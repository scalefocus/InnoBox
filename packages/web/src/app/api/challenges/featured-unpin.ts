// Automatic Home-pin clearing (INNOBOX_SPEC.md §13.2 *Automatic unpin*, §15 curation). Called
// from INSIDE the transaction of every challenge status write (store.ts applyChallengeStatusChange
// and withdrawChallenge, delete.ts's solution-delete revert) and of the §10.3 hard delete. It must
// run BEFORE the status UPDATE: the DB CHECK `challenges_featured_status_chk` refuses a pinned row
// leaving valid/solved, so the pin has to be gone first. A cleared pin is never restored.
//
// Curation is not an edit: clearing the pin touches only featured_at / featured_by — never
// updated_at — and notifies no one. Relative imports only (the gated dbtests run under plain node).
import type { PoolClient } from "pg";
import { appendAudit } from "../../../lib/audit";
import { transitionClearsPin } from "./featured-rules";

/** Clears the pin when `newStatus` is not eligible, writing `challenge.unfeatured` with
 *  `trigger: "status_changed"`. Actor = the transition's actor (null for a system-driven move).
 *  A no-op (no row, no audit) when the challenge is not featured or the new status keeps it. */
export async function unpinOnStatusChange(
  client: PoolClient,
  actorUserId: string | null,
  challengeId: string,
  newStatus: string,
): Promise<boolean> {
  if (!transitionClearsPin(newStatus)) return false;
  const { rows } = await client.query<{ featured_at: Date | null }>(`select featured_at from challenges where id = $1 for update`, [challengeId]);
  const featuredAt = rows[0]?.featured_at ?? null;
  if (featuredAt === null) return false;
  await client.query(`update challenges set featured_at = null, featured_by = null where id = $1`, [challengeId]);
  await appendAudit(client, {
    actorUserId,
    action: "challenge.unfeatured",
    targetType: "challenge",
    targetId: challengeId,
    before: { featuredAt: featuredAt.toISOString() },
    after: { trigger: "status_changed", status: newStatus },
  });
  return true;
}

/** §10.3: inside the hard-delete transaction, before the row is removed — writes
 *  `challenge.unfeatured` with `trigger: "deleted"` when the challenge was featured. */
export async function unpinOnDelete(client: PoolClient, actorUserId: string, challengeId: string): Promise<boolean> {
  const { rows } = await client.query<{ featured_at: Date | null }>(`select featured_at from challenges where id = $1 for update`, [challengeId]);
  const featuredAt = rows[0]?.featured_at ?? null;
  if (featuredAt === null) return false;
  await appendAudit(client, {
    actorUserId,
    action: "challenge.unfeatured",
    targetType: "challenge",
    targetId: challengeId,
    before: { featuredAt: featuredAt.toISOString() },
    after: { trigger: "deleted" },
  });
  return true;
}
