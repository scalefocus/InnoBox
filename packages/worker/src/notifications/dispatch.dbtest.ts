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

test(
  "notification sweep: a deactivated or erased recipient's row is discarded like an opt-out",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    // §12.1: `active` is re-read at send time, immediate path included (the digest job already
    // did) — a leaver's row is marked sent with no attempt, exactly as an opt-out's is; an active
    // recipient's row is attempted (and fails here: no transport configured).
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { runNotificationSweep } = await import("./dispatch.js");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const mkUser = async (label: string, extra: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email ${extra ? ", " + extra.split("=")[0] : ""})
           values ($1, $2, $3, $4 ${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
          [`dbtest-inactive-${label}-${stamp}`, `dbtest-inactive-${label}-${stamp}@example.test`, `Dbtest Inactive ${label}`, `inactive-${label}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      const active = await mkUser("active", "");
      const leaver = await mkUser("leaver", "active=false");
      const erased = await mkUser("erased", "scrubbed_at=now()");
      const outbox = async (userId: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into notification_outbox (user_id, type, payload) values ($1, 'comment_posted', $2::jsonb) returning id`,
          [userId, JSON.stringify({ message: `dbtest ${stamp}`, link: "/challenges/x" })],
        );
        return rows[0]!.id;
      };
      const rows = { active: await outbox(active), leaver: await outbox(leaver), erased: await outbox(erased) };
      const state = async (id: string) =>
        (await pool.query<{ status: string; attempts: number }>(`select status, attempts from notification_outbox where id = $1`, [id])).rows[0]!;

      const summary = await runNotificationSweep(pool, { graphEnv: null, smtpEnv: null, baseUrl: "https://innobox.example.com", batchSize: 1000 });
      assert.ok(summary.skippedOptOut >= 2, `the leaver's and the erased user's rows are skipped (got ${summary.skippedOptOut})`);
      assert.deepEqual(await state(rows.leaver), { status: "sent", attempts: 0 }, "a deactivated recipient's row: marked sent, never attempted");
      assert.deepEqual(await state(rows.erased), { status: "sent", attempts: 0 }, "an erased recipient's row: marked sent, never attempted");
      assert.deepEqual(await state(rows.active), { status: "failed", attempts: 1 }, "an active recipient's row is attempted");
    } finally {
      await pool.end();
    }
  },
);
