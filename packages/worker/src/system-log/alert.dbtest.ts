// Live-DB integration test (gated) for the §14.7 alert sweep and retention trim: the watermark
// prevents double counting, the unread row coalesces (count accumulates) until read, a read row
// is left alone and a fresh one starts, no outbox row is ever written, and the trim removes only
// rows past the retention window. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "system log alert sweep + trim",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { SYSTEM_ERROR_NOTIFICATION_TYPE, SYSTEM_LOG_NOTIFY_WATERMARK_KEY, runSystemLogAlertSweep } = await import("./alert.js");
    const { recordWorkerEvent, trimSystemEvents } = await import("./record.js");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const bootstrapGroup = `dbtest-bootstrap-${stamp}`;

      // A platform admin via the bootstrap group (the only admin path that needs no role mapping).
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
        [`dbtest-alert-admin-${stamp}`, `dbtest-alert-admin-${stamp}@example.test`, `Dbtest Alert Admin ${stamp}`, `alert-${stamp}@example.test`],
      );
      const adminId = u[0]!.id;
      const { rows: g } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $2) returning id`, [bootstrapGroup, "Dbtest bootstrap"]);
      await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [g[0]!.id, adminId]);

      // Start from a clean watermark at "now" so earlier suites' events are not counted here.
      await pool.query(
        `insert into platform_settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [SYSTEM_LOG_NOTIFY_WATERMARK_KEY, new Date().toISOString()],
      );
      const unread = () =>
        pool.query<{ id: string; payload: { count: number; message: string; link: string } }>(
          `select id, payload from notifications where user_id = $1 and type = $2 and read_at is null`,
          [adminId, SYSTEM_ERROR_NOTIFICATION_TYPE],
        );

      const quiet = await runSystemLogAlertSweep(pool, { bootstrapAdminGroup: bootstrapGroup });
      assert.equal(quiet.newEvents, 0);
      assert.equal((await unread()).rows.length, 0, "nothing new → no row");

      const ev = (status: number) => recordWorkerEvent(pool, { status, method: "GET", route: "/scim/v2/*", path: "/scim/v2/Users", message: `t ${stamp}`, source: "worker" });
      await ev(401);
      await ev(401);
      const first = await runSystemLogAlertSweep(pool, { bootstrapAdminGroup: bootstrapGroup });
      assert.equal(first.newEvents, 2);
      assert.ok(first.adminsNotified >= 1);
      let rows = (await unread()).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.payload.count, 2);
      assert.equal(rows[0]!.payload.link, "/admin/system-log");
      assert.match(rows[0]!.payload.message, /2 new system log events/);

      const again = await runSystemLogAlertSweep(pool, { bootstrapAdminGroup: bootstrapGroup });
      assert.equal(again.newEvents, 0, "the watermark prevents double counting");
      assert.equal((await unread()).rows[0]!.payload.count, 2);

      await ev(403);
      await runSystemLogAlertSweep(pool, { bootstrapAdminGroup: bootstrapGroup });
      rows = (await unread()).rows;
      assert.equal(rows.length, 1, "still one unread row");
      assert.equal(rows[0]!.payload.count, 3, "the count accumulated in place");

      // No e-mail: the alert is in-app only.
      const { rows: outbox } = await pool.query(`select 1 from notification_outbox where user_id = $1 and type = $2`, [adminId, SYSTEM_ERROR_NOTIFICATION_TYPE]);
      assert.equal(outbox.length, 0);

      // Reading the row and recording more starts a fresh row, leaving the read one alone.
      await pool.query(`update notifications set read_at = now() where id = $1`, [rows[0]!.id]);
      await ev(401);
      await runSystemLogAlertSweep(pool, { bootstrapAdminGroup: bootstrapGroup });
      const fresh = (await unread()).rows;
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0]!.payload.count, 1);
      assert.notEqual(fresh[0]!.id, rows[0]!.id);

      // Trim: an event back-dated past the window goes; the recent ones stay.
      await pool.query(`insert into system_events (created_at, status, method, route, path, message, source) values (now() - interval '100 days', 500, 'GET', '/x', '/x', $1, 'web')`, [`old ${stamp}`]);
      const trimmed = await trimSystemEvents(pool, 90);
      assert.ok(trimmed >= 1);
      const { rows: left } = await pool.query(`select 1 from system_events where message = $1`, [`old ${stamp}`]);
      assert.equal(left.length, 0);
      const { rows: kept } = await pool.query(`select count(*)::int as c from system_events where message = $1`, [`t ${stamp}`]);
      assert.equal(kept[0]!.c, 4);
    } finally {
      await pool.end();
    }
  },
);
