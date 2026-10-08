// Live-DB integration test (gated): proves audit_log is append-only against a real
// Postgres with db/migrations applied — invariant 5 enforced by BOTH the missing
// UPDATE/DELETE grants (when connected as innobox_app) and the immutability trigger
// (any role). Self-skips when DATABASE_URL is unset so the hermetic unit stage stays green.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "audit_log accepts INSERT but refuses UPDATE and DELETE",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { appendAudit } = await import("./audit");
    const pool = new Pool({ connectionString: url });
    try {
      await appendAudit(pool, {
        action: "test.append_only_probe",
        targetType: "test",
        targetId: "audit.dbtest",
        after: { probe: true },
      });
      const { rows } = await pool.query<{ id: string }>(
        `select id from audit_log where action = 'test.append_only_probe' order by id desc limit 1`,
      );
      const id = rows[0]?.id;
      assert.ok(id, "probe row was inserted");

      // Both enforcement layers surface as one of these errors depending on the role:
      // innobox_app hits the missing grant ("permission denied"), superuser hits the trigger.
      const appendOnly = /append-only|permission denied/;
      await assert.rejects(pool.query(`update audit_log set action = 'tampered' where id = $1`, [id]), appendOnly);
      await assert.rejects(pool.query(`delete from audit_log where id = $1`, [id]), appendOnly);

      const { rows: still } = await pool.query(`select action from audit_log where id = $1`, [id]);
      assert.equal(still[0]?.action, "test.append_only_probe", "row is untouched");
    } finally {
      await pool.end();
    }
  },
);

test(
  "audit_log refuses TRUNCATE (statement-level guard trigger, §15)",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url });
    try {
      // The guard is present: a BEFORE TRUNCATE, statement-level trigger on audit_log.
      // pg_trigger.tgtype bits: 1 = ROW (must be clear), 2 = BEFORE, 32 = TRUNCATE.
      const { rows: trig } = await pool.query<{ tgtype: number }>(
        `select t.tgtype from pg_trigger t
           where t.tgrelid = 'audit_log'::regclass and t.tgname = 'audit_log_no_truncate' and not t.tgisinternal`,
      );
      assert.equal(trig.length, 1, "audit_log_no_truncate trigger exists");
      const tgtype = Number(trig[0]!.tgtype);
      assert.equal(tgtype & 1, 0, "statement-level, not row-level");
      assert.equal(tgtype & 2, 2, "fires BEFORE");
      assert.equal(tgtype & 32, 32, "fires on TRUNCATE");

      // And it bites, whichever role the suite runs as: innobox_app lacks the grant
      // ("permission denied"), the owner/superuser hits the trigger ("append-only"). Wrapped in
      // a transaction that is always rolled back, so even a regression could not empty the table.
      const client = await pool.connect();
      try {
        await client.query("begin");
        await assert.rejects(client.query("truncate audit_log"), /append-only|permission denied/);
      } finally {
        await client.query("rollback");
        client.release();
      }
    } finally {
      await pool.end();
    }
  },
);
