// Data layer for the §16 `me` resource's mutation half: marking /quick-start seen
// (INNOBOX_SPEC.md §13.7) and the What's new marker (§13.9). Own-account housekeeping, same tier
// as the profile e-mail opt-out toggle — no audit_log entry (that's reserved for
// admin/state-machine actions).
import type { Pool } from "pg";
import { normalizeMarker, stampAdvances } from "../../../lib/whats-new";

/** §13.1: stamped when the user LEAVES the Challenges surface — the nav bubble and the "new"
 *  card tags reset until newer challenges arrive. Own-account housekeeping, not audited. */
export async function markChallengesSeen(pool: Pool, userId: string): Promise<void> {
  await pool.query(`update users set challenges_seen_at = now(), updated_at = now() where id = $1`, [userId]);
}

export async function markQuickStartSeen(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `update users set quick_start_seen_at = now(), updated_at = now() where id = $1 and quick_start_seen_at is null`,
    [userId],
  );
}

/** The marker before and after a stamp; `previous` is null when it was unset or not strict x.y.z. */
export interface WhatsNewStamp {
  previous: string | null;
  current: string | null;
}

/**
 * §13.9: advance `users.whats_new_seen_version` to `version` — only when the stored value is
 * null, invalid or strictly lower, so the marker never regresses. Read, compare, then one UPDATE
 * guarded on the exact value just read: a concurrent stamp that got there first makes the guard
 * miss, and the loop re-reads rather than leapfrogging it. The same statement clears the one-time
 * rollout boundary. Callers validate `version` (strict, not in the future) first. Not audited.
 */
export async function markWhatsNewSeen(pool: Pool, userId: string, version: string): Promise<WhatsNewStamp> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { rows } = await pool.query<{ whats_new_seen_version: string | null }>(
      `select whats_new_seen_version from users where id = $1`,
      [userId],
    );
    if (!rows[0]) return { previous: null, current: null };
    const stored = rows[0].whats_new_seen_version;
    const previous = normalizeMarker(stored);
    if (!stampAdvances(stored, version)) return { previous, current: previous };
    const updated = await pool.query(
      `update users
          set whats_new_seen_version = $2,
              whats_new_since_date = null
        where id = $1 and whats_new_seen_version is not distinct from $3`,
      [userId, version, stored],
    );
    if (updated.rowCount === 1) return { previous, current: version };
  }
  // Lost the race repeatedly — whatever is stored now came from a concurrent stamp.
  const { rows } = await pool.query<{ whats_new_seen_version: string | null }>(
    `select whats_new_seen_version from users where id = $1`,
    [userId],
  );
  const current = normalizeMarker(rows[0]?.whats_new_seen_version);
  return { previous: current, current };
}
