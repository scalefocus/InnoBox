// Live-DB integration test (gated) for the What's new marker (INNOBOX_SPEC.md §13.9): the stamp
// store behind POST /api/me/whats-new-seen, the Quick start acknowledgement, erasure, and the
// migration's one-time rollout snapshot. Self-skips when DATABASE_URL is unset; the migration
// cases also self-skip without TEST_OWNER_DATABASE_URL (set only by the harness), because
// re-running DDL needs the table owner — they run inside a rolled-back transaction.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { readFileSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  return { Pool, randomUUID, readFileSync, dirname, join, resolve, fileURLToPath };
}

async function seedUser(
  pool: import("pg").Pool,
  label: string,
  opts: { seen?: string | null; sinceDate?: string | null } = {},
): Promise<string> {
  const { randomUUID } = await importDeps();
  const stamp = randomUUID().slice(0, 8);
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (external_id, user_name, display_name, email, active, whats_new_seen_version, whats_new_since_date)
       values ($1, $2, $3, $4, true, $5, $6::date)
     returning id`,
    [
      `dbtest-whatsnew-${label}-${stamp}`,
      `dbtest-whatsnew-${label}-${stamp}@example.test`,
      `Dbtest WhatsNew ${label} ${stamp}`,
      `whatsnew-${label}-${stamp}@example.test`,
      opts.seen ?? null,
      opts.sinceDate ?? null,
    ],
  );
  return rows[0]!.id;
}

async function readMarker(pool: import("pg").Pool, userId: string) {
  const { rows } = await pool.query<{ seen: string | null; since: string | null }>(
    `select whats_new_seen_version as seen, to_char(whats_new_since_date, 'YYYY-MM-DD') as since from users where id = $1`,
    [userId],
  );
  return rows[0]!;
}

test("markWhatsNewSeen: a null marker is set, and the rollout date is cleared in the same write", { skip }, async () => {
  const { Pool } = await importDeps();
  const { markWhatsNewSeen } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const userId = await seedUser(pool, "null", { seen: null, sinceDate: "2026-10-01" });
    const result = await markWhatsNewSeen(pool, userId, "1.2.3");
    assert.deepEqual(result, { previous: null, current: "1.2.3" });
    assert.deepEqual(await readMarker(pool, userId), { seen: "1.2.3", since: null });
  } finally {
    await pool.end();
  }
});

test("markWhatsNewSeen: a lower marker advances; an invalid one counts as null", { skip }, async () => {
  const { Pool } = await importDeps();
  const { markWhatsNewSeen } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const lower = await seedUser(pool, "lower", { seen: "1.2.2" });
    assert.deepEqual(await markWhatsNewSeen(pool, lower, "1.2.3"), { previous: "1.2.2", current: "1.2.3" });
    assert.equal((await readMarker(pool, lower)).seen, "1.2.3");

    const invalid = await seedUser(pool, "invalid", { seen: "v1-beta" });
    assert.deepEqual(await markWhatsNewSeen(pool, invalid, "1.0.0"), { previous: null, current: "1.0.0" });
    assert.equal((await readMarker(pool, invalid)).seen, "1.0.0");
  } finally {
    await pool.end();
  }
});

test("markWhatsNewSeen: a higher or equal marker never regresses, and repeat calls are no-ops", { skip }, async () => {
  const { Pool } = await importDeps();
  const { markWhatsNewSeen } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const higher = await seedUser(pool, "higher", { seen: "2.0.0" });
    const result = await markWhatsNewSeen(pool, higher, "1.9.9");
    assert.deepEqual(result, { previous: "2.0.0", current: "2.0.0" }, "previous == current when nothing moved");
    assert.equal((await readMarker(pool, higher)).seen, "2.0.0");

    const same = await seedUser(pool, "same", { seen: null });
    await markWhatsNewSeen(pool, same, "1.0.0");
    assert.deepEqual(await markWhatsNewSeen(pool, same, "1.0.0"), { previous: "1.0.0", current: "1.0.0" });
  } finally {
    await pool.end();
  }
});

test("markWhatsNewSeen: concurrent stamps settle on the highest version", { skip }, async () => {
  const { Pool } = await importDeps();
  const { markWhatsNewSeen } = await import("./store");
  const pool = new Pool({ connectionString: url, max: 6 });
  try {
    const userId = await seedUser(pool, "race", { seen: "1.0.0" });
    await Promise.all(["1.0.1", "1.3.0", "1.1.0", "1.2.0", "1.0.5"].map((v) => markWhatsNewSeen(pool, userId, v)));
    assert.equal((await readMarker(pool, userId)).seen, "1.3.0");
  } finally {
    await pool.end();
  }
});

test("Quick start's Continue acknowledges the running release", { skip }, async () => {
  const { Pool } = await importDeps();
  const { markQuickStartSeen, markWhatsNewSeen } = await import("./store");
  const { APP_VERSION } = await import("@innobox/shared/version");
  const pool = new Pool({ connectionString: url });
  try {
    const userId = await seedUser(pool, "quickstart", { seen: null });
    // The PATCH /api/me handler's sequence (route.ts): mark Quick start seen, then stamp at the
    // server's APP_VERSION.
    await markQuickStartSeen(pool, userId);
    await markWhatsNewSeen(pool, userId, APP_VERSION);
    assert.equal((await readMarker(pool, userId)).seen, APP_VERSION);
  } finally {
    await pool.end();
  }
});

test("erasure nulls the marker and the rollout date", { skip }, async () => {
  const { Pool } = await importDeps();
  const { scrubUser } = await import("../users/store");
  const pool = new Pool({ connectionString: url });
  try {
    const admin = await seedUser(pool, "admin");
    const userId = await seedUser(pool, "erased", { seen: "1.2.3", sinceDate: "2026-10-01" });
    await pool.query(`update users set active = false, deactivated_at = now() where id = $1`, [userId]);
    const result = await scrubUser(pool, admin, userId);
    assert.equal(result.status, "ok");
    assert.deepEqual(await readMarker(pool, userId), { seen: null, since: null });
  } finally {
    await pool.end();
  }
});

test(
  "migration 0036: snapshots the UTC day of last activity once, and a re-run never moves it",
  { skip: skip || (ownerUrl ? false : "TEST_OWNER_DATABASE_URL not set — migration cases self-skip") },
  async () => {
    const { Pool, readFileSync, dirname, join, resolve, fileURLToPath } = await importDeps();
    // packages/web/src/app/api/me → repo root.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
    const sql = readFileSync(join(repoRoot, "db", "migrations", "0036_whats_new_seen.sql"), "utf8");

    const pool = new Pool({ connectionString: ownerUrl });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { rows } = await client.query<{ active_id: string; idle_id: string }>(
        `with a as (
           insert into users (external_id, user_name, display_name, active, last_seen_at)
           values ('dbtest-whatsnew-mig-a', 'dbtest-whatsnew-mig-a@example.test', 'Dbtest Mig A', true,
                   timestamptz '2026-10-09 23:30:00+00')
           returning id),
         b as (
           insert into users (external_id, user_name, display_name, active)
           values ('dbtest-whatsnew-mig-b', 'dbtest-whatsnew-mig-b@example.test', 'Dbtest Mig B', true)
           returning id)
         select a.id as active_id, b.id as idle_id from a, b`,
      );
      const { active_id: activeId, idle_id: idleId } = rows[0]!;

      // First application: the boundary column does not exist yet, so the snapshot runs. A
      // non-UTC session must not shift the day (23:30 UTC is already the 10th in Sofia).
      await client.query("set local time zone 'Europe/Sofia'");
      await client.query("alter table users drop column whats_new_since_date");
      await client.query(sql);
      const day = async (id: string) =>
        (
          await client.query<{ since: string | null; seen: string | null }>(
            `select to_char(whats_new_since_date, 'YYYY-MM-DD') as since, whats_new_seen_version as seen from users where id = $1`,
            [id],
          )
        ).rows[0]!;
      assert.deepEqual(await day(activeId), { since: "2026-10-09", seen: null }, "UTC calendar day; marker not back-filled");
      assert.deepEqual(await day(idleId), { since: null, seen: null }, "no activity → no boundary");

      // A re-run must not move the boundary, even after last_seen_at changed.
      await client.query(`update users set last_seen_at = timestamptz '2026-10-12 08:00:00+00' where id = $1`, [activeId]);
      await client.query(sql);
      assert.equal((await day(activeId)).since, "2026-10-09");
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
      await pool.end();
    }
  },
);
