// Data layer for /api/follows (INNOBOX_SPEC.md §12.3): follow/unfollow any challenge or
// solution the viewer can see. No audit entry — follows are a personal preference, not a
// moderation-relevant event (§15's audit list does not mention follow/unfollow).
import type { Pool } from "pg";
import { isParentVisible, type Viewer } from "../challenges/store";

export type ToggleFollowResult = { status: "ok"; following: boolean } | { status: "not_found" };

export async function toggleFollow(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<ToggleFollowResult> {
  if (!(await isParentVisible(pool, viewer, parentType, parentId))) return { status: "not_found" };

  const { rows: existing } = await pool.query(
    `select 1 from follows where user_id = $1 and parent_type = $2 and parent_id = $3`,
    [viewer.userId, parentType, parentId],
  );
  if (existing.length > 0) {
    await pool.query(`delete from follows where user_id = $1 and parent_type = $2 and parent_id = $3`, [
      viewer.userId,
      parentType,
      parentId,
    ]);
    return { status: "ok", following: false };
  }
  await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, $2, $3) on conflict do nothing`, [
    viewer.userId,
    parentType,
    parentId,
  ]);
  return { status: "ok", following: true };
}

export async function isFollowing(pool: Pool, viewer: Viewer, parentType: "challenge" | "solution", parentId: string): Promise<boolean> {
  const { rows } = await pool.query(`select 1 from follows where user_id = $1 and parent_type = $2 and parent_id = $3`, [
    viewer.userId,
    parentType,
    parentId,
  ]);
  return rows.length > 0;
}

/** Auto-follow on submit/propose (§12.3) — best-effort, ON CONFLICT DO NOTHING since the
 *  author is guaranteed not to already follow their own brand-new item. */
export async function autoFollow(pool: Pool, userId: string, parentType: "challenge" | "solution", parentId: string): Promise<void> {
  await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, $2, $3) on conflict do nothing`, [
    userId,
    parentType,
    parentId,
  ]);
}
