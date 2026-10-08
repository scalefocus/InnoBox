// Live-DB integration test (gated) for marking /quick-start seen (INNOBOX_SPEC.md §13.7).
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "markQuickStartSeen: stamps quick_start_seen_at once and never resets it on a later call",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { markQuickStartSeen } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, active) values ($1, $2, $3, $4, true) returning id`,
        [`dbtest-me-${stamp}`, `dbtest-me-${stamp}@example.test`, `Dbtest Me ${stamp}`, `me-${stamp}@example.test`],
      );
      const userId = rows[0]!.id;

      const before = await pool.query<{ quick_start_seen_at: Date | null }>(
        `select quick_start_seen_at from users where id = $1`,
        [userId],
      );
      assert.equal(before.rows[0]!.quick_start_seen_at, null, "a freshly inserted user starts unseen");

      await markQuickStartSeen(pool, userId);
      const after = await pool.query<{ quick_start_seen_at: Date | null }>(
        `select quick_start_seen_at from users where id = $1`,
        [userId],
      );
      const firstStamp = after.rows[0]!.quick_start_seen_at;
      assert.ok(firstStamp, "quick_start_seen_at is stamped");

      await markQuickStartSeen(pool, userId);
      const again = await pool.query<{ quick_start_seen_at: Date | null }>(
        `select quick_start_seen_at from users where id = $1`,
        [userId],
      );
      assert.equal(again.rows[0]!.quick_start_seen_at?.getTime(), firstStamp!.getTime(), "a second call never resets the timestamp");
    } finally {
      await pool.end();
    }
  },
);

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  return { Pool, randomUUID };
}
