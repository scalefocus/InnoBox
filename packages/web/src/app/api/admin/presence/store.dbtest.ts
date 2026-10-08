// Live-DB integration test (gated) for the §14.5 presence read path. Self-skips when
// DATABASE_URL is unset.
//
// What is worth testing against real SQL rather than a fake pool: the anonymity masking (§9),
// which is a join + a flag the write path never sees; the rolling-window arithmetic, which is
// the entire basis of the DAU/WAU/MAU tiles; and the exclusions (scrubbed users, the service
// mailbox), each of which is a negative assertion that a fake pool cannot make.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  return { Pool, randomUUID };
}

/** A user with presence already stamped `secondsAgo` seconds back. */
async function seedUser(
  pool: import("pg").Pool,
  stamp: string,
  label: string,
  opts: { secondsAgo: number; route?: string | null; active?: boolean; scrubbed?: boolean } = { secondsAgo: 10 },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (external_id, user_name, display_name, email, active, scrubbed_at, last_seen_at, last_route)
       values ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7), $8)
     returning id`,
    [
      `dbtest-presence-${label}-${stamp}`,
      `dbtest-presence-${label}-${stamp}@example.test`,
      `Dbtest Presence ${label} ${stamp}`,
      `presence-${label}-${stamp}@example.test`,
      opts.active ?? true,
      opts.scrubbed ? new Date() : null,
      opts.secondsAgo,
      opts.route ?? null,
    ],
  );
  return rows[0]!.id;
}

async function seedChallenge(
  pool: import("pg").Pool,
  stamp: string,
  authorId: string,
  anonymous: boolean,
): Promise<{ id: string; number: number; title: string }> {
  const { rows: nsRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
  const { rows: areaRows } = await pool.query<{ id: string }>(`select id from impact_areas limit 1`);
  const title = `Dbtest presence challenge ${anonymous ? "anon" : "named"} ${stamp}`;
  const { rows } = await pool.query<{ id: string; number: number }>(
    `insert into challenges (namespace_id, visibility, title, description, impact_area_id, is_anonymous, author_id, status)
       values ($1, 'org', $2, 'd', $3, $4, $5, 'valid') returning id, number`,
    [nsRows[0]!.id, title, areaRows[0]!.id, anonymous, authorId],
  );
  return { id: rows[0]!.id, number: rows[0]!.number, title };
}

test("presenceSummary: an anonymous challenge is masked to the bare category (§9)", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { presenceSummary } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const author = await seedUser(pool, stamp, "author", { secondsAgo: 3600 });
    const named = await seedChallenge(pool, stamp, author, false);
    const anon = await seedChallenge(pool, stamp, author, true);

    const onNamed = await seedUser(pool, stamp, "onnamed", { secondsAgo: 10, route: `challenge:${named.number}` });
    const onAnon = await seedUser(pool, stamp, "onanon", { secondsAgo: 10, route: `challenge:${anon.number}` });

    const summary = await presenceSummary(pool, "1h");
    const rowFor = (id: string) => summary.users.find((u) => u.id === id);

    // A named challenge is shown in full — number and title.
    assert.equal(rowFor(onNamed)?.location, `Challenge: CH-${named.number} — ${named.title}`);
    // The anonymous one degrades to the category: no number, no title, nothing correlatable.
    assert.equal(rowFor(onAnon)?.location, "Challenges");
    assert.ok(!JSON.stringify(summary).includes(anon.title), "an anonymous title must not appear anywhere in the payload");
    assert.ok(!JSON.stringify(summary).includes(`CH-${anon.number}`), "an anonymous number must not leak either");
  } finally {
    await pool.end();
  }
});

test("presenceSummary: a solution is masked when EITHER it or its challenge is anonymous", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { presenceSummary } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const author = await seedUser(pool, stamp, "solauthor", { secondsAgo: 3600 });
    const namedChallenge = await seedChallenge(pool, stamp, author, false);
    const anonChallenge = await seedChallenge(pool, stamp, author, true);

    const insertSolution = async (challengeId: string, anonymous: boolean) => {
      const { rows } = await pool.query<{ number: number }>(
        `insert into solutions (challenge_id, description, is_anonymous, author_id, status)
           values ($1, 'd', $2, $3, 'proposed') returning number`,
        [challengeId, anonymous, author],
      );
      return rows[0]!.number;
    };

    const openSolution = await insertSolution(namedChallenge.id, false);
    const anonSolution = await insertSolution(namedChallenge.id, true);
    const solutionOnAnon = await insertSolution(anonChallenge.id, false);

    const a = await seedUser(pool, stamp, "solopen", { secondsAgo: 10, route: `solution:${openSolution}` });
    const b = await seedUser(pool, stamp, "solanon", { secondsAgo: 10, route: `solution:${anonSolution}` });
    const c = await seedUser(pool, stamp, "solparent", { secondsAgo: 10, route: `solution:${solutionOnAnon}` });

    const summary = await presenceSummary(pool, "1h");
    const rowFor = (id: string) => summary.users.find((u) => u.id === id);

    assert.equal(rowFor(a)?.location, `Solution: SOL-${openSolution} on CH-${namedChallenge.number} — ${namedChallenge.title}`);
    assert.equal(rowFor(b)?.location, "Solutions", "an anonymous solution must be masked");
    // The parent's anonymity masks the child too, or the child would surface its title.
    assert.equal(rowFor(c)?.location, "Solutions", "a solution on an anonymous challenge must be masked");
    assert.ok(!JSON.stringify(summary).includes(anonChallenge.title));
  } finally {
    await pool.end();
  }
});

test("presenceSummary: a missing or non-existent entity falls back to the category, never blank", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { presenceSummary } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    // A challenge number that cannot exist, plus a plain category token.
    const ghost = await seedUser(pool, stamp, "ghost", { secondsAgo: 10, route: "challenge:2147483000" });
    const triage = await seedUser(pool, stamp, "triage", { secondsAgo: 10, route: "triage" });
    const nowhere = await seedUser(pool, stamp, "nowhere", { secondsAgo: 10, route: null });

    const summary = await presenceSummary(pool, "1h");
    const rowFor = (id: string) => summary.users.find((u) => u.id === id);
    assert.equal(rowFor(ghost)?.location, "Challenges", "masking is the fallback, not the exception");
    assert.equal(rowFor(triage)?.location, "Triage");
    assert.equal(rowFor(nowhere)?.location, null, "no recorded route renders no location");
  } finally {
    await pool.end();
  }
});

test("presenceSummary: windows are rolling and ordered most-recent-first", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { presenceSummary } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const fresh = await seedUser(pool, stamp, "fresh", { secondsAgo: 30 });
    const midWindow = await seedUser(pool, stamp, "mid", { secondsAgo: 40 * 60 }); // 40m
    const yesterday = await seedUser(pool, stamp, "yesterday", { secondsAgo: 30 * 60 * 60 }); // 30h

    const fiveMinutes = await presenceSummary(pool, "5m");
    const ids5 = fiveMinutes.users.map((u) => u.id);
    assert.ok(ids5.includes(fresh));
    assert.equal(ids5.includes(midWindow), false, "40m ago is outside a 5-minute window");

    const oneHour = await presenceSummary(pool, "1h");
    const ids1h = oneHour.users.map((u) => u.id);
    assert.ok(ids1h.includes(fresh) && ids1h.includes(midWindow));
    assert.equal(ids1h.includes(yesterday), false);
    // Most recent first (§14.5).
    assert.ok(ids1h.indexOf(fresh) < ids1h.indexOf(midWindow));

    // A user last active 30h ago counts in WAU and MAU but NOT DAU — the whole point of
    // deriving the tiles from last_seen_at.
    const day = await presenceSummary(pool, "30d");
    assert.ok(day.users.map((u) => u.id).includes(yesterday));
    assert.ok(day.mau >= 3 && day.wau >= 3);
    assert.ok(day.dau >= 2);
  } finally {
    await pool.end();
  }
});

test("presenceSummary: scrubbed users never appear; deactivated ones appear greyed", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { presenceSummary } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    // Presence columns deliberately left populated on the scrubbed row: the READ side must
    // exclude it even if a writer somehow left values behind (§3 wipes them at erasure).
    const scrubbed = await seedUser(pool, stamp, "scrubbed", { secondsAgo: 10, active: false, scrubbed: true });
    const deactivated = await seedUser(pool, stamp, "deactivated", { secondsAgo: 10, active: false });

    const summary = await presenceSummary(pool, "1h");
    const ids = summary.users.map((u) => u.id);
    assert.equal(ids.includes(scrubbed), false, "a scrubbed user must never appear");
    const row = summary.users.find((u) => u.id === deactivated);
    assert.ok(row, "a deactivated (not scrubbed) user still appears");
    assert.equal(row!.active, false, "…flagged so the UI can grey it");
  } finally {
    await pool.end();
  }
});

test("presenceSummary: the e-mail service mailbox is excluded — it is not a person", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { presenceSummary } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const botExternalId = `dbtest-presence-bot-${stamp}`;
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name, active, last_seen_at)
         values ($1, $2, $3, true, now()) returning id`,
      [botExternalId, `${botExternalId}@example.test`, `Dbtest Presence Bot ${stamp}`],
    );
    const botId = rows[0]!.id;

    const before = await presenceSummary(pool, "1h");
    assert.ok(before.users.map((u) => u.id).includes(botId), "before being registered it is just a user");

    // The singleton service-account row is keyed on `id = true`; save and restore whatever a
    // real (or previous test's) connection left behind.
    const { rows: existing } = await pool.query(`select * from email_service_account where id = true`);
    await pool.query(
      `insert into email_service_account (id, account_upn, account_display_name, account_oid, refresh_token_enc)
         values (true, $1, 'Dbtest mailbox', $2, 'x')
       on conflict (id) do update set account_oid = excluded.account_oid`,
      [`${botExternalId}@example.test`, botExternalId],
    );
    try {
      const after = await presenceSummary(pool, "1h");
      assert.equal(after.users.map((u) => u.id).includes(botId), false, "the connected mailbox is filtered out");
    } finally {
      await pool.query(`delete from email_service_account where id = true`);
      const prior = existing[0] as Record<string, unknown> | undefined;
      if (prior) {
        await pool.query(
          `insert into email_service_account (id, account_upn, account_display_name, account_oid, refresh_token_enc, access_token_enc, access_token_expires_at, connected_by_user_id, connected_at)
             values (true, $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            prior.account_upn, prior.account_display_name, prior.account_oid, prior.refresh_token_enc,
            prior.access_token_enc, prior.access_token_expires_at, prior.connected_by_user_id, prior.connected_at,
          ],
        );
      }
    }
  } finally {
    await pool.end();
  }
});

test("presenceHistory: today comes from live detail; closed days come from the aggregate", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { presenceHistory } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const user = await seedUser(pool, stamp, "history", { secondsAgo: 10 });
    await pool.query(
      `insert into user_activity_days (user_id, day) values ($1, (now() at time zone 'utc')::date)
       on conflict do nothing`,
      [user],
    );

    const points = await presenceHistory(pool, "30d");
    const today = new Date().toISOString().slice(0, 10);
    const todayPoint = points.find((p) => p.day === today);
    assert.ok(todayPoint, "the in-progress UTC day must be present, not omitted until tomorrow");
    assert.ok(todayPoint!.activeUsers >= 1);
    // Ordered ascending, and each day appears exactly once (no aggregate/live double count).
    const days = points.map((p) => p.day);
    assert.deepEqual(days, [...days].sort());
    assert.equal(new Set(days).size, days.length, "a day must never appear twice");
  } finally {
    await pool.end();
  }
});

test("presenceHistory: 'all' is a superset of a bounded range", { skip }, async () => {
  const { Pool } = await importDeps();
  const { presenceHistory } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const all = await presenceHistory(pool, "all");
    const week = await presenceHistory(pool, "7d");
    assert.ok(all.length >= week.length);
    const allDays = new Set(all.map((p) => p.day));
    for (const p of week) assert.ok(allDays.has(p.day), `${p.day} missing from the unbounded range`);
  } finally {
    await pool.end();
  }
});
