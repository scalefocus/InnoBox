// Data layer for POST /api/me/sign-out-everywhere ("Sign out everywhere", INNOBOX_SPEC.md §3):
// stamps `users.sessions_valid_from = now()` so every session token minted before this instant
// — on every device — is refused by getSessionUser() at its next request, and audits it
// (`user.signed_out_everywhere`, actor = target, §15). The request that stamps it is itself
// still valid for its own lifetime; the client signs this browser out right after.
import type { Pool } from "pg";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";

/** Stamps the column and writes the audit row in one transaction. Returns the stamp as stored
 *  (null only if the user row vanished — nothing to revoke, nothing audited). */
export async function signOutEverywhere(pool: Pool, userId: string): Promise<Date | null> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ sessions_valid_from: Date }>(
      `update users set sessions_valid_from = now(), updated_at = now() where id = $1 returning sessions_valid_from`,
      [userId],
    );
    const stamp = rows[0]?.sessions_valid_from ?? null;
    if (!stamp) return null;
    await appendAudit(client, {
      actorUserId: userId,
      action: "user.signed_out_everywhere",
      targetType: "user",
      targetId: userId,
      after: { sessionsValidFrom: stamp.toISOString() },
    });
    return stamp;
  });
}
