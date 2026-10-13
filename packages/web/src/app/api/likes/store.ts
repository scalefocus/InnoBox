// Data layer for DELETE /api/likes (INNOBOX_SPEC.md §16 "likes … create/delete on either parent
// type"): an idempotent unlike, beside the POST toggle the UI uses. Same visibility gate as the
// toggle (an item the viewer cannot see is "not found", invariant 2) and the same audit trail —
// `like.removed` is written only when a like actually existed, so a repeated DELETE is a silent
// no-op rather than a duplicate audit row.
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { getParentAccess, lockLikeParent, type Viewer } from "../challenges/store";

export type RemoveLikeResult = { status: "ok"; liked: false; count: number } | { status: "not_found" } | { status: "trashed" } | { status: "frozen" };

export async function removeLike(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<RemoveLikeResult> {
  const access = await getParentAccess(pool, viewer, parentType, parentId);
  if (access !== "live") return { status: access }; // §10.4: no unlike on a trashed item

  return inTransaction(pool, async (client) => {
    // §8.3: likes are frozen on a closed challenge (solved, rejected, withdrawn) and its solutions — an unlike is refused too.
    const gate = await lockLikeParent(client, parentType, parentId);
    if (gate !== "open") return { status: gate };
    const removed = await client.query(`delete from likes where user_id = $1 and parent_type = $2 and parent_id = $3`, [
      viewer.userId,
      parentType,
      parentId,
    ]);
    if ((removed.rowCount ?? 0) > 0) {
      await appendAudit(client, { actorUserId: viewer.userId, action: "like.removed", targetType: parentType, targetId: parentId });
    }
    const { rows } = await client.query<{ count: string }>(`select count(*)::text as count from likes where parent_type = $1 and parent_id = $2`, [
      parentType,
      parentId,
    ]);
    return { status: "ok", liked: false, count: Number(rows[0]!.count) };
  });
}
