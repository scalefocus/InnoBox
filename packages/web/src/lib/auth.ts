// Per-request session validation + role resolution (ENTRA_AUTH_SPEC.md §5). The JWT
// cookie only proves authentication happened; identity, `active`, and roles come from
// the database on EVERY request — a deactivated user holding a live cookie loses access
// at the next call (§2 leaver semantics), and roles NEVER come from token claims
// (INNOBOX_SPEC.md invariant 1; per-request resolution, no role cache in v1). §4.2 *Resolution*:
// one statement per resolution, at most one resolution per request.
import { headers } from "next/headers";
import { getServerSession } from "next-auth";
import type { RoleSet } from "@innobox/shared";
import { authOptions } from "./authOptions";
import { pool } from "./db";
import { PRESENCE_METHOD_HEADER, PRESENCE_PATH_HEADER, touchPresence } from "./presence-touch";
import { isSessionRevoked } from "./session-revocation";
import { requestMemo } from "./request-memo";
import { bootstrapAdminGroup, loadSessionRow, resolveRoleSets } from "./role-resolution";

export interface SessionUser {
  id: string;
  externalId: string;
  userName: string;
  displayName: string;
  email: string | null;
  emailNotificationsEnabled: boolean;
  quickStartSeenAt: Date | null;
  /** §13.9 What's new marker, raw as stored (the rules treat a non-x.y.z value as null). */
  whatsNewSeenVersion: string | null;
  /** §13.9 one-time rollout boundary, `YYYY-MM-DD` — read only while the marker is null. */
  whatsNewSinceDate: string | null;
  roles: RoleSet;
}

/** Resolves a RoleSet for each of many user ids in ONE statement, whatever the count (§4.2
 *  *Resolution*) — notification dispatch (lib/notify.ts) visibility-checks every candidate
 *  recipient of an event at once. Every id gets an entry; a user with no grants gets the
 *  implicit-member RoleSet. The ONE place roles are resolved (invariant 1): resolveRolesForUser and
 *  getSessionUser go through the same SQL (lib/role-resolution.ts). */
export async function resolveRolesForUsers(userIds: readonly string[]): Promise<Map<string, RoleSet>> {
  return resolveRoleSets(pool, userIds, bootstrapAdminGroup());
}

/** Resolves a RoleSet for an arbitrary user id (not just the session user) — the assignee and
 *  successor checks, and the shape every NotifyContext is built with. It carries the bulk resolver
 *  as `.many`, so a notification fan-out given this function resolves all its recipients at once
 *  (lib/notify.ts finalRecipients) without any caller changing. */
export const resolveRolesForUser = Object.assign(
  async (userId: string): Promise<RoleSet> => (await resolveRolesForUsers([userId])).get(userId)!,
  { many: resolveRolesForUsers },
);

/** Presence stamp (§14.5), on the only per-request node-layer hook there is. The pathname
 *  arrives as a middleware-injected header because Next hands route handlers no matched
 *  path; `headers()` throws outside a request scope, and the whole thing is best-effort —
 *  presence must never be able to fail the request it rides on. */
async function stampPresence(userId: string): Promise<void> {
  try {
    const h = await headers();
    touchPresence(pool, userId, h.get(PRESENCE_PATH_HEADER), h.get(PRESENCE_METHOD_HEADER));
  } catch {
    /* no request scope (build-time page collection, tests) — nothing to record */
  }
}

/** The request's scope object for the §4.2 per-request memo: the headers object Next hands out
 *  once per request (lib/request-memo.ts). Null outside a request scope — then nothing is memoized. */
async function requestScope(): Promise<object | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}

const sessionMemo = requestMemo<SessionUser | null>();

/** The signed-in, ACTIVE user with DB-resolved roles — or null (unauthenticated, or the
 *  user row is missing/deactivated, or the token was issued before the row's
 *  `sessions_valid_from` — "Sign out everywhere", INNOBOX_SPEC.md §3: same outcome, no session).
 *  §4.2 *Resolution*: the user row and its roles come back from ONE statement, and a request that
 *  asks twice (a handler and a helper it calls) shares one resolution — never across requests. */
export async function getSessionUser(): Promise<SessionUser | null> {
  return sessionMemo(await requestScope(), resolveSessionUser);
}

async function resolveSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const oid = session?.oid;
  if (!oid) return null;

  const row = await loadSessionRow(pool, oid, bootstrapAdminGroup());
  if (!row || !row.active) return null;
  // §3 Sign out everywhere / erasure / SCIM deactivation stamp: a token minted before it is no
  // session, whatever the cookie says — the API answers 401, a page redirects to Home.
  if (isSessionRevoked({ issuedAt: session.issuedAt, sessionsValidFrom: row.sessionsValidFrom })) return null;

  await stampPresence(row.id);

  return {
    id: row.id,
    externalId: row.externalId,
    userName: row.userName,
    displayName: row.displayName,
    email: row.email,
    emailNotificationsEnabled: row.emailNotificationsEnabled,
    quickStartSeenAt: row.quickStartSeenAt,
    whatsNewSeenVersion: row.whatsNewSeenVersion,
    whatsNewSinceDate: row.whatsNewSinceDate,
    roles: row.roles,
  };
}

export type Guard = { ok: true; user: SessionUser } | { ok: false; response: Response };

/** For API routes: 401 JSON when there is no valid, active session. */
export async function requireUser(): Promise<Guard> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  return { ok: true, user };
}

/** For platform-admin API routes: 401 without a session, 403 without the role. */
export async function requirePlatformAdmin(): Promise<Guard> {
  const guard = await requireUser();
  if (!guard.ok) return guard;
  if (!guard.user.roles.isPlatformAdmin) {
    return { ok: false, response: Response.json({ error: "forbidden" }, { status: 403 }) };
  }
  return guard;
}
