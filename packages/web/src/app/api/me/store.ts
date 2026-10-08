// Data layer for the §16 `me` resource's mutation half: marking /quick-start seen
// (INNOBOX_SPEC.md §13.7). Own-account housekeeping, same tier as the profile e-mail
// opt-out toggle — no audit_log entry (that's reserved for admin/state-machine actions).
import type { Pool } from "pg";

export async function markQuickStartSeen(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `update users set quick_start_seen_at = now(), updated_at = now() where id = $1 and quick_start_seen_at is null`,
    [userId],
  );
}
