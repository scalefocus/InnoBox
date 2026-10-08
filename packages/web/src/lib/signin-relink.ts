// Entra sign-in resolution with the SCIM relink repair (INNOBOX_SPEC.md §3 "Sign-in relink",
// §14.7 `signin_upn_conflict`, §15 `user.relinked`; ENTRA_AUTH_SPEC.md §6 rule 1).
//
// The identity key stays the Entra `oid` (users.external_id). The UPN is used for exactly one
// repair: when NO row has external_id = oid, a row SCIM provisioned under a mismatched
// externalId — whose owner could therefore never sign in — is re-keyed to the oid, provided it
// has never been used (the guard against UPN reuse). Anything else holding the UPN is never
// merged: the sign-in falls back to the JIT path, which the case-insensitive unique index on
// user_name makes collide, and the sign-in is refused with a system-log row naming the holder
// user ids only (never the UPN, e-mail or oid). The dev credentials provider never comes here.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import type { SystemEventInput } from "@innobox/shared";
import { appendAudit } from "./audit";
import { inTransaction } from "./db";
import { getUserByExternalId, jitUpsertFromClaims, type UserRow } from "./users";

/** The raw Entra ID-token claims the signIn callback hands over. */
export interface EntraSignInClaims {
  oid: string;
  preferredUsername?: string | null;
  email?: string | null;
  name?: string | null;
}

/** What the relink decision needs to know about a row holding the claimed UPN. */
export interface UpnHolder {
  id: string;
  externalId: string;
  active: boolean;
  scimSynced: boolean;
  scrubbedAt: Date | null;
  lastSeenAt: Date | null;
}

// ── Pure decision (unit-tested in signin-relink.test.ts) ──────────────────────────────────

/** A relink candidate: written by SCIM, active, not erased, never used, and keyed to a
 *  different Entra object. Reconciliation-created rows and JIT stubs are `scim_synced=false`. */
export function isRelinkCandidate(holder: UpnHolder, oid: string): boolean {
  return (
    holder.scimSynced &&
    holder.active &&
    holder.scrubbedAt === null &&
    holder.lastSeenAt === null &&
    holder.externalId !== oid
  );
}

export type RelinkDecision =
  /** Exactly one candidate: re-key it to the oid. */
  | { action: "relink"; userId: string; oldExternalId: string }
  /** No UPN claim, nobody holds the UPN, or the holders are not exactly one candidate:
   *  the JIT path runs unchanged (and collides on the unique index if anyone holds it). */
  | { action: "jit" };

/** `holders` are the rows whose lower(user_name) equals lower(preferred_username). */
export function decideRelink(holders: readonly UpnHolder[], claims: Pick<EntraSignInClaims, "oid" | "preferredUsername">): RelinkDecision {
  if (!claims.preferredUsername) return { action: "jit" }; // no claim → no relink attempt
  const candidates = holders.filter((h) => isRelinkCandidate(h, claims.oid));
  // More than one is structurally impossible (unique index) — kept as a defensive guard:
  // never merge, fall through to JIT, which then refuses on the collision.
  if (candidates.length !== 1) return { action: "jit" };
  const only = candidates[0]!;
  return { action: "relink", userId: only.id, oldExternalId: only.externalId };
}

/** The UPN claim the JIT path stores as user_name (unchanged fallback chain). */
export function jitUserName(claims: EntraSignInClaims): string {
  return claims.preferredUsername || claims.email || claims.oid;
}

/** pg unique violation on the case-insensitive user_name index (0003_identity.sql). */
export function isUserNameConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === "users_user_name_lower_idx";
}

export const SIGNIN_CALLBACK_ROUTE = "/api/auth/callback/[provider]";

/** The §14.7 carve-out row for a refused sign-in: 409, no user, no actor snapshot, and a
 *  message naming the holder user ids only — never the UPN, e-mail or oid. */
export function buildUpnConflictEvent(candidateIds: readonly string[], providerId = "azure-ad"): SystemEventInput {
  const ids = candidateIds.length ? candidateIds.join(", ") : "none found";
  return {
    status: 409,
    method: "GET",
    route: SIGNIN_CALLBACK_ROUTE,
    path: `/api/auth/callback/${providerId}`,
    userId: null,
    actorName: null,
    actorEmail: null,
    errorCode: "signin_upn_conflict",
    message: `Sign-in refused (UPN conflict): the UPN is held by user id(s) ${ids}, not eligible for relink`,
    source: "web",
  };
}

// ── DB orchestration ──────────────────────────────────────────────────────────────────────

export type EntraSignInResult =
  | { ok: true; user: UserRow; relinked: boolean }
  | { ok: false; reason: "inactive" | "upn_conflict" };

export interface EntraSignInDeps {
  /** Records the refusal's system-log row. The signIn callback passes a fire-and-forget
   *  recorder (§14.7: logging never blocks or fails the response); tests await it. */
  recordConflict: (event: SystemEventInput) => void | Promise<void>;
}

async function loadUpnHolders(db: Pool, upn: string): Promise<UpnHolder[]> {
  const { rows } = await db.query<{
    id: string;
    external_id: string;
    active: boolean;
    scim_synced: boolean;
    scrubbed_at: Date | null;
    last_seen_at: Date | null;
  }>(
    `select id, external_id, active, scim_synced, scrubbed_at, last_seen_at
       from users where lower(user_name) = lower($1) order by id`,
    [upn],
  );
  return rows.map((r) => ({
    id: r.id,
    externalId: r.external_id,
    active: r.active,
    scimSynced: r.scim_synced,
    scrubbedAt: r.scrubbed_at,
    lastSeenAt: r.last_seen_at,
  }));
}

/** Re-keys the candidate in one guarded update + its audit row, atomically. Returns false when
 *  the guard no longer matches (a concurrent sign-in won the race, or the row was used or
 *  changed meanwhile) — the caller then re-reads by oid and proceeds. */
async function relinkRow(db: Pool, userId: string, oldExternalId: string, oid: string): Promise<boolean> {
  try {
    return await inTransaction(db, async (client) => {
      const { rowCount } = await client.query(
        `update users set external_id = $1, updated_at = now()
          where id = $2 and external_id = $3
            and scim_synced and active and scrubbed_at is null and last_seen_at is null`,
        [oid, userId, oldExternalId],
      );
      if (!rowCount) return false;
      await appendAudit(client, {
        actorUserId: userId, // the relinked user, as `user.jit_created` is
        action: "user.relinked",
        targetType: "user",
        targetId: userId,
        before: { externalId: oldExternalId },
        after: { externalId: oid },
      });
      return true;
    });
  } catch (err) {
    // A concurrent JIT insert took the oid first (unique external_id): lost race, fall through.
    if (err && typeof err === "object" && (err as { code?: unknown }).code === "23505") return false;
    throw err;
  }
}

/**
 * Resolves an Entra sign-in to a users row: existing row by oid (refused when deactivated),
 * else the relink repair, else the unchanged JIT path. A UPN collision the relink does not
 * cover is refused (`upn_conflict`) and recorded — never an unhandled error, never a merge.
 */
export async function resolveEntraSignIn(db: Pool, claims: EntraSignInClaims, deps: EntraSignInDeps): Promise<EntraSignInResult> {
  let existing = await getUserByExternalId(db, claims.oid);
  let relinked = false;
  if (!existing && claims.preferredUsername) {
    const decision = decideRelink(await loadUpnHolders(db, claims.preferredUsername), claims);
    if (decision.action === "relink") {
      relinked = await relinkRow(db, decision.userId, decision.oldExternalId, claims.oid);
      existing = await getUserByExternalId(db, claims.oid); // relinked, or the race winner's row
    }
  }
  if (existing && !existing.active) return { ok: false, reason: "inactive" }; // leaver semantics
  const userName = jitUserName(claims);
  try {
    // Claims never overwrite a scim_synced row, so a relinked row passes through untouched.
    const user = await jitUpsertFromClaims(db, {
      oid: claims.oid,
      userName,
      email: claims.email ?? null,
      displayName: claims.name ?? "",
    });
    return { ok: true, user, relinked };
  } catch (err) {
    if (!isUserNameConflict(err)) throw err;
    const holders = await loadUpnHolders(db, userName);
    await deps.recordConflict(buildUpnConflictEvent(holders.map((h) => h.id)));
    return { ok: false, reason: "upn_conflict" };
  }
}
