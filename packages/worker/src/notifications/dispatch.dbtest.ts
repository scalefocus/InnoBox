// Live-DB integration test (gated) for the §12.1 e-mail retry backoff: a failed outbox row gets
// a backed-off next_attempt_at and is NOT picked up again by an immediate re-sweep; once due it is
// retried with a doubled delay; at the attempt cap it is left failed for good. Runs the real sweep
// with no transport configured (every send fails). Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "notification sweep: failed e-mail retries with exponential backoff",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { MAX_EMAIL_ATTEMPTS, runNotificationSweep } = await import("./dispatch.js");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
        [`dbtest-outbox-${stamp}`, `dbtest-outbox-${stamp}@example.test`, `Dbtest Outbox ${stamp}`, `outbox-${stamp}@example.test`],
      );
      const userId = u[0]!.id;
      const { rows: o } = await pool.query<{ id: string }>(
        `insert into notification_outbox (user_id, type, payload) values ($1, 'comment_posted', $2::jsonb) returning id`,
        [userId, JSON.stringify({ message: `dbtest ${stamp}`, link: "/challenges/x" })],
      );
      const outboxId = o[0]!.id;
      const row = async () =>
        (
          await pool.query<{ status: string; attempts: number; delay_s: number | null }>(
            `select status, attempts, extract(epoch from (next_attempt_at - now()))::float8 as delay_s
               from notification_outbox where id = $1`,
            [outboxId],
          )
        ).rows[0]!;
      const sweep = () => runNotificationSweep(pool, { graphEnv: null, smtpEnv: null, baseUrl: "https://innobox.example.com", batchSize: 1000 });

      await sweep();
      let r = await row();
      assert.equal(r.status, "failed");
      assert.equal(r.attempts, 1);
      assert.ok(r.delay_s !== null && r.delay_s > 50 && r.delay_s <= 60, `first retry ~1 min out (got ${r.delay_s}s)`);

      await sweep();
      r = await row();
      assert.equal(r.attempts, 1, "an immediate re-sweep does not retry a backed-off row");

      // Make it due: the retry happens and the next delay doubles.
      await pool.query(`update notification_outbox set next_attempt_at = now() - interval '1 second' where id = $1`, [outboxId]);
      await sweep();
      r = await row();
      assert.equal(r.attempts, 2);
      assert.ok(r.delay_s !== null && r.delay_s > 110 && r.delay_s <= 120, `second retry ~2 min out (got ${r.delay_s}s)`);

      // At the attempt cap the row is never picked up again, even when due.
      await pool.query(`update notification_outbox set attempts = $2, next_attempt_at = now() - interval '1 second' where id = $1`, [
        outboxId,
        MAX_EMAIL_ATTEMPTS,
      ]);
      await sweep();
      r = await row();
      assert.equal(r.attempts, MAX_EMAIL_ATTEMPTS, "a row at the cap is left failed");
      assert.equal(r.status, "failed");
    } finally {
      await pool.end();
    }
  },
);
