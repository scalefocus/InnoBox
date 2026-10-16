// Live-DB integration test (gated) for the §14.5 daily WAU/MAU snapshot written by the presence
// rollup sweep: the tiles' formula and person filter against real rows, the write-once rule,
// and the zero row for a day nobody was active on — which a later rollup must still be able to
// correct. Self-skips when DATABASE_URL is unset.
//
// presence_daily is one row per day for the whole install, so "yesterday" is shared with
// whatever else ran in this throwaway database. The assertions are therefore DELTAS: sample,
// add known people, re-sample, and compare.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

const YESTERDAY = "(now() at time zone 'utc')::date - 1";

test("presence snapshot: yesterday's WAU/MAU use the tiles' windows and person filter, and are written once", { skip }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { runPresenceRollupSweep } = await import("./rollup.js");

  const pool = new Pool({ connectionString: url });
  const stamp = randomUUID().slice(0, 8);
  const created: string[] = [];
  const seed = async (label: string, daysAgo: number, opts: { scrubbed?: boolean; active?: boolean } = {}) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name, active, scrubbed_at, last_seen_at)
         values ($1, $2, $3, $4, $5, now() - make_interval(days => $6::int))
       returning id`,
      [
        `dbtest-snapshot-${label}-${stamp}`,
        `dbtest-snapshot-${label}-${stamp}@example.test`,
        `Dbtest Snapshot ${label} ${stamp}`,
        opts.active ?? true,
        opts.scrubbed ? new Date() : null,
        daysAgo,
      ],
    );
    created.push(rows[0]!.id);
    return rows[0]!.id;
  };
  const yesterday = async () =>
    (
      await pool.query<{ active_users: number; wau: number | null; mau: number | null }>(
        `select active_users, wau, mau from presence_daily where day = ${YESTERDAY}`,
      )
    ).rows[0];

  try {
    // Baseline: whatever people this database already holds.
    await pool.query(`delete from presence_daily where day = ${YESTERDAY}`);
    const first = await runPresenceRollupSweep(pool);
    assert.equal(first.snapshot, true, "the first sweep of the day writes yesterday's pair");
    const base = await yesterday();
    assert.ok(base && base.wau !== null && base.mau !== null);

    // Known people: inside 7 days, inside 30 only, outside both, a deactivated user inside 7
    // (the tiles count them), a scrubbed user and the e-mail service mailbox (never counted).
    await seed("week", 2);
    await seed("month", 10);
    await seed("stale", 40);
    await seed("deactivated", 3, { active: false });
    await seed("scrubbed", 1, { scrubbed: true });
    const mailbox = await seed("mailbox", 1);

    // Connect the seeded mailbox as THE service account, saving whatever connection a previous
    // suite left behind. (Swapping the connection also moves the previous mailbox user, if any,
    // back into the count — hence the baseline is re-taken after the swap, not before.)
    const { rows: prior } = await pool.query(`select * from email_service_account where id = true`);
    const { rows: mailboxRow } = await pool.query<{ external_id: string }>(`select external_id from users where id = $1`, [mailbox]);
    await pool.query(
      `insert into email_service_account (id, account_upn, account_display_name, account_oid, refresh_token_enc)
         values (true, $1, 'Dbtest mailbox', $2, 'x')
       on conflict (id) do update set account_oid = excluded.account_oid`,
      [`dbtest-snapshot-mailbox-${stamp}@example.test`, mailboxRow[0]!.external_id],
    );
    try {
      // Re-take the baseline without the known people (they are hidden from presence by a NULL
      // last_seen_at for the moment), then restore them and re-sample.
      const known = created.slice();
      const saved = await pool.query<{ id: string; last_seen_at: Date }>(
        `select id, last_seen_at from users where id = any($1::uuid[])`,
        [known],
      );
      await pool.query(`update users set last_seen_at = null where id = any($1::uuid[])`, [known]);
      await pool.query(`delete from presence_daily where day = ${YESTERDAY}`);
      await runPresenceRollupSweep(pool);
      const baseline = await yesterday();
      for (const row of saved.rows) {
        await pool.query(`update users set last_seen_at = $2 where id = $1`, [row.id, row.last_seen_at]);
      }

      await pool.query(`delete from presence_daily where day = ${YESTERDAY}`);
      await runPresenceRollupSweep(pool);
      const after = await yesterday();
      assert.equal(after!.wau, baseline!.wau! + 2, "the 2-day and the deactivated 3-day user count in WAU");
      assert.equal(
        after!.mau,
        baseline!.mau! + 3,
        "…and the 10-day user in MAU too; the 40-day, scrubbed and service-mailbox users in neither",
      );

      // Write-once: someone new appears, and the next sweep leaves yesterday's sample alone.
      await seed("late", 0);
      const later = await runPresenceRollupSweep(pool);
      assert.equal(later.snapshot, false, "a later sweep must not re-sample");
      const unchanged = await yesterday();
      assert.equal(unchanged!.wau, after!.wau);
      assert.equal(unchanged!.mau, after!.mau);
    } finally {
      await pool.query(`delete from email_service_account where id = true`);
      const p = prior[0] as Record<string, unknown> | undefined;
      if (p) {
        await pool.query(
          `insert into email_service_account (id, account_upn, account_display_name, account_oid, refresh_token_enc, access_token_enc, access_token_expires_at, connected_by_user_id, connected_at)
             values (true, $1, $2, $3, $4, $5, $6, $7, $8)`,
          [p.account_upn, p.account_display_name, p.account_oid, p.refresh_token_enc, p.access_token_enc, p.access_token_expires_at, p.connected_by_user_id, p.connected_at],
        );
      }
    }
  } finally {
    // Presence columns are what the other suites read; drop the seeded people from presence.
    if (created.length) {
      await pool.query(`update users set last_seen_at = null where id = any($1::uuid[])`, [created]);
    }
    await pool.end();
  }
});

test("presence snapshot: a quiet day gets a zero row that a later rollup still corrects", { skip }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { runPresenceRollupSweep } = await import("./rollup.js");

  const pool = new Pool({ connectionString: url });
  try {
    // Nobody was active yesterday, and the day has no row.
    await pool.query(`delete from user_activity_days where day = ${YESTERDAY}`);
    await pool.query(`delete from presence_daily where day = ${YESTERDAY}`);
    await runPresenceRollupSweep(pool);
    const { rows: quiet } = await pool.query<{ active_users: number; wau: number | null }>(
      `select active_users, wau from presence_daily where day = ${YESTERDAY}`,
    );
    assert.equal(quiet.length, 1, "the snapshot inserts the row the rollup had no reason to write");
    assert.equal(quiet[0]!.active_users, 0);
    assert.notEqual(quiet[0]!.wau, null);

    // Activity for yesterday turns up later (a sweep that ran before a slow write committed):
    // the rollup's upsert corrects the count, and the sample stays as it was.
    const stamp = randomUUID().slice(0, 8);
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name) values ($1, $2, 'Dbtest Snapshot quiet') returning id`,
      [`dbtest-snapshot-quiet-${stamp}`, `dbtest-snapshot-quiet-${stamp}@example.test`],
    );
    await pool.query(`insert into user_activity_days (user_id, day) values ($1, ${YESTERDAY})`, [rows[0]!.id]);
    await runPresenceRollupSweep(pool);
    const { rows: corrected } = await pool.query<{ active_users: number; wau: number | null }>(
      `select active_users, wau from presence_daily where day = ${YESTERDAY}`,
    );
    assert.equal(corrected[0]!.active_users, 1, "the rollup still owns the daily count");
    assert.equal(corrected[0]!.wau, quiet[0]!.wau, "…and never disturbs the sample");
  } finally {
    await pool.end();
  }
});
