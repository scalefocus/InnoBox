// Live-DB integration test (gated) for the §14.6 system banner store: set restarts the countdown
// unconditionally, lazy expiry hides an expired row without deleting it, clear empties it and
// both writes are audited. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "system banner store: set / replace / lazy expiry / clear / audit",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { SYSTEM_BANNER_KEY, clearSystemBanner, getActiveSystemBanner, getStoredSystemBanner, setSystemBanner } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
        [`dbtest-banner-${stamp}`, `dbtest-banner-${stamp}@example.test`, `Dbtest Banner ${stamp}`, `banner-${stamp}@example.test`],
      );
      const adminId = u[0]!.id;
      const t0 = Date.parse("2026-10-08T10:00:00Z");

      // Start clean (another suite may have left a banner).
      await clearSystemBanner(pool, adminId);
      assert.equal(await getActiveSystemBanner(pool), null);

      const first = await setSystemBanner(pool, { message: `Maintenance ${stamp}`, tone: "warning", url: "/whats-new", duration: "4h" }, adminId, t0);
      assert.equal(first.expiresAt, new Date(t0 + 4 * 3_600_000).toISOString());
      const active = await getActiveSystemBanner(pool, t0 + 3_600_000);
      assert.ok(active);
      assert.equal(active.message, `Maintenance ${stamp}`);
      assert.equal(active.tone, "warning");
      assert.equal(active.url, "/whats-new");

      // Replace with a SHORTER duration: the countdown restarts from the new save, no "only extend".
      const t1 = t0 + 2 * 3_600_000;
      const second = await setSystemBanner(pool, { message: `Replaced ${stamp}`, tone: "info", url: null, duration: "1h" }, adminId, t1);
      assert.equal(second.expiresAt, new Date(t1 + 3_600_000).toISOString());
      assert.equal((await getActiveSystemBanner(pool, t1))!.message, `Replaced ${stamp}`);

      // Lazy expiry: past expiresAt the active view is empty while the stored row persists.
      assert.equal(await getActiveSystemBanner(pool, t1 + 3_600_000), null);
      const stored = await getStoredSystemBanner(pool);
      assert.ok(stored, "the row lingers, inert");
      assert.equal(stored.message, `Replaced ${stamp}`);

      // Clear empties it and reports whether something was there.
      assert.equal(await clearSystemBanner(pool, adminId), true);
      assert.equal(await getStoredSystemBanner(pool), null);
      assert.equal(await clearSystemBanner(pool, adminId), false, "clearing nothing is a no-op that still answers");
      const { rows: row } = await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [SYSTEM_BANNER_KEY]);
      assert.equal(row[0]?.value, null);

      // Audit trail: two sets + three clears by this actor.
      const { rows: audit } = await pool.query<{ action: string; after: { message?: string; duration?: string } | null }>(
        `select action, after from audit_log where actor_user_id = $1 and action like 'system_banner.%' order by id`,
        [adminId],
      );
      assert.deepEqual(
        audit.map((a) => a.action),
        ["system_banner.cleared", "system_banner.set", "system_banner.set", "system_banner.cleared", "system_banner.cleared"],
      );
      assert.equal(audit[1]!.after?.duration, "4h");
      assert.equal(audit[2]!.after?.message, `Replaced ${stamp}`);
    } finally {
      await pool.end();
    }
  },
);
