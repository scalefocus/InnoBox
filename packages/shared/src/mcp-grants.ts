// Agent-access grant housekeeping (INNOBOX_SPEC.md §25.3, §25.13) — SERVER-ONLY, shared by the
// web tier (a person's own revoke, the GDPR erasure) and the worker (SCIM / reconciliation
// deactivation, the hourly sweep). DB access is the structural DbClient shape, so a pg Pool or a
// checked-out PoolClient both satisfy it; pass the caller's transaction client to keep the
// revocation atomic with the change that caused it.
import { appendAudit } from "./audit.js";
import type { DbClient } from "./email-graph.js";
import type { GrantRevokeReason } from "./mcp.js";

/** Ends one grant: stamps revoked_at (and who), deletes every token under it, audits
 *  `mcp.grant_revoked` with the reason. False when the grant is not live (already revoked/gone). */
export async function revokeGrant(
  db: DbClient,
  grantId: string,
  reason: GrantRevokeReason,
  actorUserId: string | null,
): Promise<boolean> {
  const { rows } = await db.query<{ id: string; user_id: string; client_name: string }>(
    `update oauth_grants g set revoked_at = now(), revoked_by = $2
       from oauth_clients c
      where g.id = $1 and g.revoked_at is null and c.id = g.client_id
      returning g.id, g.user_id, c.client_name`,
    [grantId, reason === "user" ? actorUserId : null],
  );
  const grant = rows[0];
  if (!grant) return false;
  await db.query(`delete from oauth_tokens where grant_id = $1`, [grantId]);
  await appendAudit(db, {
    actorUserId,
    action: "mcp.grant_revoked",
    targetType: "mcp_grant",
    targetId: grant.id,
    after: { userId: grant.user_id, client: grant.client_name, reason },
  });
  return true;
}

/**
 * §25.3 leavers: every live grant the person holds is revoked and every token under any of their
 * grants deleted — call it in the same transaction as the deactivation. Returns how many grants
 * were live. A reactivated person connects again (nothing is restored).
 */
export async function revokeUserGrants(db: DbClient, userId: string, reason: "deactivated" | "erased", actorUserId: string | null = null): Promise<number> {
  const { rows } = await db.query<{ id: string }>(`select id from oauth_grants where user_id = $1 and revoked_at is null order by created_at`, [userId]);
  let revoked = 0;
  for (const g of rows) if (await revokeGrant(db, g.id, reason, actorUserId)) revoked++;
  await db.query(`delete from oauth_tokens where grant_id in (select id from oauth_grants where user_id = $1)`, [userId]);
  return revoked;
}

/** §3 erasure: the live grants are revoked (audited, reason `erased`), then every grant row of the
 *  person is deleted — their tokens and pending authorizations cascade. */
export async function eraseUserGrants(db: DbClient, userId: string, actorUserId: string | null): Promise<void> {
  await revokeUserGrants(db, userId, "erased", actorUserId);
  await db.query(`delete from oauth_pending_authorizations where user_id = $1`, [userId]);
  await db.query(`delete from oauth_grants where user_id = $1`, [userId]);
}

export interface OauthSweepSummary {
  tokens: number;
  pending: number;
  clients: number;
}

/** A client with no grant at all this long after registering is deleted (§25.3). */
export const UNUSED_CLIENT_DAYS = 7;

/**
 * The worker's hourly housekeeping (§25.13): expired codes and access tokens; consumed or expired
 * pending authorizations; refresh lineage past its idle lifetime (a rotated refresh token is kept
 * until then, so presenting it again is still detected as reuse); and clients that never got a
 * grant within 7 days of registering. Revoked grants themselves stay, as the record of a person's
 * connections; their tokens were deleted at revocation.
 */
export async function sweepOauth(db: DbClient): Promise<OauthSweepSummary> {
  const tokens = await db.query(`delete from oauth_tokens where expires_at < now()`);
  const pending = await db.query(
    `delete from oauth_pending_authorizations where consumed_at is not null or created_at < now() - interval '10 minutes'`,
  );
  const clients = await db.query(
    `delete from oauth_clients c
      where c.created_at < now() - make_interval(days => $1)
        and not exists (select 1 from oauth_grants g where g.client_id = c.id)`,
    [UNUSED_CLIENT_DAYS],
  );
  return { tokens: tokens.rowCount ?? 0, pending: pending.rowCount ?? 0, clients: clients.rowCount ?? 0 };
}
