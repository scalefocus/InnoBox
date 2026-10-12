// Live-DB integration tests (gated) for the feedback survey (INNOBOX_SPEC.md §13.10): first uses
// vs repeats, consumed first uses, `canShow`, exactly one of two concurrent winners, the 90-day
// fallback, close counting once, submit (no user reference anywhere in the response, the offer
// cleared, 409/422), the opt-out and an open `self` offer, the GDPR erasure, and the migration's
// backfill and idempotency. Self-skips when DATABASE_URL is unset.
//
// `survey_daily` and the platform switch are global, so counters are asserted as deltas and every
// test that flips the switch restores it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";
const lose = () => 0.99; // the roll loses
const win = () => 0; // the roll wins (and picks the first rotating question / used feature)

async function deps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const store = await import("./store");
  return { Pool, randomUUID, store };
}

/** An active user, Quick start `qsDaysAgo` days ago, surveys on, never shown. */
async function makeUser(pool: Pool, stamp: string, tag: string, opts: { qsDaysAgo?: number; lastShownDaysAgo?: number | null } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (external_id, user_name, display_name, email, active, quick_start_seen_at, survey_last_shown_at)
     values ($1, $2, $3, $4, true, now() - make_interval(days => $5), case when $6::int is null then null else now() - make_interval(days => $6::int) end)
     returning id`,
    [`dbtest-survey-${tag}-${stamp}`, `dbtest-survey-${tag}-${stamp}@example.test`, `Dbtest Survey ${tag} ${stamp}`, `survey-${tag}-${stamp}@example.test`, opts.qsDaysAgo ?? 20, opts.lastShownDaysAgo ?? null],
  );
  return rows[0]!.id;
}

interface Daily {
  shown: number;
  closed: number;
  submitted: number;
  submitted_from_menu: number;
  shown_self: number;
  submitted_self: number;
}

async function daily(pool: Pool): Promise<Daily> {
  const { rows } = await pool.query<Daily>(
    `select coalesce(sum(shown),0)::int as shown, coalesce(sum(closed),0)::int as closed, coalesce(sum(submitted),0)::int as submitted,
            coalesce(sum(submitted_from_menu),0)::int as submitted_from_menu, coalesce(sum(shown_self),0)::int as shown_self,
            coalesce(sum(submitted_self),0)::int as submitted_self
       from survey_daily`,
  );
  return rows[0]!;
}

async function offerOf(pool: Pool, userId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query<{ survey_offer: Record<string, unknown> | null }>(`select survey_offer from users where id = $1`, [userId]);
  return rows[0]!.survey_offer;
}

const member = { isPlatformAdmin: false, grants: [{ role: "member" }] };

test("features/used: a fresh first use rolls and opens an offer; a repeat never triggers", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const userId = await makeUser(pool, randomUUID().slice(0, 8), "first");
    const before = await daily(pool);

    const first = await store.recordFeatureUse(pool, userId, "comment", true, { rng: win });
    assert.equal(first.firstUse, true);
    assert.ok(first.survey, "an eligible fresh first use that wins opens the offer");
    assert.equal(first.survey!.trigger, "feature");
    assert.deepEqual(first.survey!.feature, { key: "comment", label: "commenting" });
    assert.equal(first.survey!.questions.length, 7);
    assert.equal((await daily(pool)).shown, before.shown + 1, "shown counted once");

    const { rows } = await pool.query<{ survey_last_shown_at: Date | null }>(`select survey_last_shown_at from users where id = $1`, [userId]);
    assert.ok(rows[0]!.survey_last_shown_at, "the 30-day floor is stamped on open");

    const repeat = await store.recordFeatureUse(pool, userId, "comment", true, { rng: win });
    assert.deepEqual(repeat, { firstUse: false, survey: null });
  } finally {
    await pool.end();
  }
});

test("features/used: ineligible, canShow=false and lost rolls are recorded and consumed for good", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    // Inside the 14-day grace.
    const fresh = await makeUser(pool, stamp, "grace", { qsDaysAgo: 3 });
    assert.deepEqual(await store.recordFeatureUse(pool, fresh, "like", true, { rng: win, forceWin: true }), { firstUse: true, survey: null });
    // canShow = false: not rolled even with a forced win.
    const blocked = await makeUser(pool, stamp, "blocked");
    assert.deepEqual(await store.recordFeatureUse(pool, blocked, "like", false, { rng: win, forceWin: true }), { firstUse: true, survey: null });
    // A lost roll.
    const loser = await makeUser(pool, stamp, "loser");
    assert.deepEqual(await store.recordFeatureUse(pool, loser, "like", true, { rng: lose }), { firstUse: true, survey: null });

    // Each of them is now consumed: the same feature never triggers again, even when it would win.
    for (const id of [fresh, blocked, loser]) {
      assert.deepEqual(await store.recordFeatureUse(pool, id, "like", true, { rng: win, forceWin: true }), { firstUse: false, survey: null });
      assert.equal(await offerOf(pool, id), null);
    }
  } finally {
    await pool.end();
  }
});

test("features/used: of two concurrent winners exactly one opens the offer", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const userId = await makeUser(pool, randomUUID().slice(0, 8), "race");
    const before = await daily(pool);
    const results = await Promise.all([
      store.recordFeatureUse(pool, userId, "search", true, { rng: win }),
      store.recordFeatureUse(pool, userId, "leaderboard", true, { rng: win }),
    ]);
    assert.equal(results.filter((r) => r.survey !== null).length, 1, "exactly one winner");
    assert.equal((await daily(pool)).shown, before.shown + 1, "shown counted once");
  } finally {
    await pool.end();
  }
});

test("survey/check: the fallback is due at 90 days, not 89, and asks about a feature already used", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const early = await makeUser(pool, stamp, "fb89", { qsDaysAgo: 400, lastShownDaysAgo: 89 });
    assert.deepEqual(await store.checkSurveyFallback(pool, early, true, { rng: win, forceWin: true }), { survey: null });

    const due = await makeUser(pool, stamp, "fb90", { qsDaysAgo: 400, lastShownDaysAgo: 90 });
    await pool.query(`insert into user_feature_uses (user_id, feature) values ($1, 'attachments')`, [due]);
    assert.deepEqual(await store.checkSurveyFallback(pool, due, false, { rng: win, forceWin: true }), { survey: null }, "canShow false → no roll");
    const opened = await store.checkSurveyFallback(pool, due, true, { rng: win });
    assert.equal(opened.survey?.trigger, "visit");
    assert.equal(opened.survey?.feature?.key, "attachments", "the used-feature pick");

    // No recorded use → the general questions only.
    const blank = await makeUser(pool, stamp, "fbnone", { qsDaysAgo: 120 });
    const general = await store.checkSurveyFallback(pool, blank, true, { rng: win });
    assert.equal(general.survey?.feature, null);
    assert.equal(general.survey?.questions.length, 5);
  } finally {
    await pool.end();
  }
});

test("close: the first close of a random offer counts once; later closes count nothing", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const userId = await makeUser(pool, randomUUID().slice(0, 8), "close");
    assert.equal(await store.closeSurvey(pool, userId), "no_open_survey");
    await store.recordFeatureUse(pool, userId, "follow", true, { rng: win });
    const before = await daily(pool);
    assert.equal(await store.closeSurvey(pool, userId), "ok");
    assert.equal(await store.closeSurvey(pool, userId), "ok");
    assert.equal((await daily(pool)).closed, before.closed + 1);
    assert.ok(await offerOf(pool, userId), "closing keeps the offer open (Take the survey)");
    assert.ok(await store.readOpenSurvey(pool, userId));
  } finally {
    await pool.end();
  }
});

test("submit: stored with no user reference, the offer cleared, counted; then 409", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const userId = await makeUser(pool, randomUUID().slice(0, 8), "submit");
    const opened = await store.recordFeatureUse(pool, userId, "review", true, { rng: win });
    const rotating = opened.survey!.questions[4]!.key;

    assert.deepEqual(await store.submitSurvey(pool, { id: userId, roles: member }, { answers: { "made.up": 3 }, via: "popup" }), {
      status: "invalid",
      error: "unknown question: made.up",
    });
    assert.equal((await store.submitSurvey(pool, { id: userId, roles: member }, { answers: {}, via: "popup" })).status, "invalid");

    const before = await daily(pool);
    const text = `Dbtest feedback ${randomUUID()}`;
    const ok = await store.submitSurvey(
      pool,
      { id: userId, roles: { isPlatformAdmin: false, grants: [{ role: "member" }, { role: "committee" }] } },
      { answers: { "general.overall": 4, [rotating]: 2, "feature.ease": 5 }, freeText: `  ${text}  `, via: "menu" },
    );
    assert.deepEqual(ok, { status: "ok" });
    assert.equal(await offerOf(pool, userId), null, "the offer is cleared");
    const after = await daily(pool);
    assert.equal(after.submitted, before.submitted + 1);
    assert.equal(after.submitted_from_menu, before.submitted_from_menu + 1);

    const { rows } = await pool.query<Record<string, unknown>>(`select * from survey_responses where free_text = $1`, [text]);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    // No user reference, no timestamp: exactly these columns.
    assert.deepEqual(Object.keys(row).sort(), ["answered_on", "feature", "free_text", "id", "segment", "survey_version", "trigger", "via"]);
    assert.equal(row.segment, "committee");
    assert.equal(row.feature, "review");
    assert.equal(row.trigger, "feature");
    for (const value of Object.values(row)) assert.ok(!String(value).includes(userId), "the user id appears nowhere");
    const { rows: fk } = await pool.query(
      `select 1 from information_schema.table_constraints tc
         join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
        where tc.table_name in ('survey_responses', 'survey_answers') and tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'users'`,
    );
    assert.equal(fk.length, 0, "no foreign key to users");
    const { rows: answers } = await pool.query<{ question_key: string; stars: number }>(
      `select question_key, stars from survey_answers where response_id = $1 order by question_key`,
      [row.id],
    );
    assert.equal(answers.length, 3, "one row per answered question");

    assert.deepEqual(await store.submitSurvey(pool, { id: userId, roles: member }, { answers: { "general.overall": 4 }, via: "popup" }), {
      status: "no_open_survey",
    });
  } finally {
    await pool.end();
  }
});

test("submit: 409 after expiry, after the opt-out, and while the switch is off", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  const answer = { answers: { "general.overall": 3 }, via: "popup" };
  try {
    const stamp = randomUUID().slice(0, 8);
    const expired = await makeUser(pool, stamp, "exp");
    await store.recordFeatureUse(pool, expired, "like", true, { rng: win });
    await pool.query(`update users set survey_last_shown_at = now() - interval '30 days' where id = $1`, [expired]);
    assert.equal((await store.submitSurvey(pool, { id: expired, roles: member }, answer)).status, "no_open_survey");
    assert.equal(await offerOf(pool, expired), null, "an ended offer is dropped on read");

    const optedOut = await makeUser(pool, stamp, "opt");
    await store.recordFeatureUse(pool, optedOut, "like", true, { rng: win });
    await store.setSurveysEnabled(pool, optedOut, false);
    assert.equal(await offerOf(pool, optedOut), null, "the opt-out clears a random offer at once");
    assert.equal((await store.submitSurvey(pool, { id: optedOut, roles: member }, answer)).status, "no_open_survey");

    const switched = await makeUser(pool, stamp, "sw");
    await store.recordFeatureUse(pool, switched, "like", true, { rng: win });
    const admin = await makeUser(pool, stamp, "swadmin");
    await store.setSurveyEnabled(pool, false, admin);
    try {
      assert.equal(await store.readOpenSurvey(pool, switched), null);
      assert.equal((await store.submitSurvey(pool, { id: switched, roles: member }, answer)).status, "no_open_survey");
      assert.equal(await offerOf(pool, switched), null, "switching off ends every open offer");
      const blocked = await makeUser(pool, stamp, "swnew");
      assert.equal((await store.recordFeatureUse(pool, blocked, "like", true, { rng: win, forceWin: true })).survey, null);
    } finally {
      await store.setSurveyEnabled(pool, true, admin);
    }
    const { rows } = await pool.query<{ after: { enabled: boolean } }>(
      `select after from audit_log where action = 'settings.survey_enabled_changed' and actor_user_id = $1 order by id`,
      [admin],
    );
    assert.deepEqual(rows.map((r) => r.after.enabled), [false, true], "the switch is audited both ways");
  } finally {
    await pool.end();
  }
});

test("an open self offer blocks the random roll and survives the opt-out", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const userId = await makeUser(pool, randomUUID().slice(0, 8), "self");
    const self = { surveyVersion: 1, trigger: "self", feature: null, rotating: "rotating.look", closed: false };
    await pool.query(`update users set survey_offer = $2::jsonb, survey_self_shown_at = now() where id = $1`, [userId, JSON.stringify(self)]);

    assert.deepEqual(await store.recordFeatureUse(pool, userId, "comment", true, { rng: win, forceWin: true }), { firstUse: true, survey: null });
    await store.setSurveysEnabled(pool, userId, false);
    assert.deepEqual(await offerOf(pool, userId), self, "the opt-out keeps an on-demand offer");

    const before = await daily(pool);
    assert.deepEqual(await store.submitSurvey(pool, { id: userId, roles: member }, { answers: { "general.overall": 5 }, via: "popup", feature: null }), { status: "ok" });
    const after = await daily(pool);
    assert.equal(after.submitted_self, before.submitted_self + 1, "a self submission counts only in the _self column");
    assert.equal(after.submitted, before.submitted);
  } finally {
    await pool.end();
  }
});

test("erasure clears the per-user survey state and leaves responses intact", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const { scrubUser } = await import("../../users/store");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const userId = await makeUser(pool, stamp, "erase");
    const admin = await makeUser(pool, stamp, "eraseadmin");
    await store.recordFeatureUse(pool, userId, "comment", true, { rng: win });
    const text = `Dbtest erasure ${stamp}`;
    await store.submitSurvey(pool, { id: userId, roles: member }, { answers: { "general.overall": 4 }, freeText: text, via: "popup" });
    await store.recordFeatureUse(pool, userId, "like", true, { rng: lose });
    await pool.query(`update users set surveys_enabled = false, survey_self_shown_at = now() where id = $1`, [userId]);

    assert.equal((await scrubUser(pool, admin, userId)).status, "ok");
    const { rows } = await pool.query(
      `select surveys_enabled, survey_last_shown_at, survey_offer, survey_self_shown_at from users where id = $1`,
      [userId],
    );
    assert.deepEqual(rows[0], { surveys_enabled: true, survey_last_shown_at: null, survey_offer: null, survey_self_shown_at: null });
    const { rows: uses } = await pool.query(`select 1 from user_feature_uses where user_id = $1`, [userId]);
    assert.equal(uses.length, 0);
    const { rows: kept } = await pool.query(`select 1 from survey_responses where free_text = $1`, [text]);
    assert.equal(kept.length, 1, "responses reference no one and are untouched");
  } finally {
    await pool.end();
  }
});

test("migration 0037: the backfill finds first uses and a re-run is idempotent and never re-staggers", { skip }, async () => {
  const { Pool, randomUUID } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const author = await makeUser(pool, stamp, "bf");
    const other = await makeUser(pool, stamp, "bfother");
    const { rows: ns } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
    const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
    const { rows: ch } = await pool.query<{ id: string }>(
      `insert into challenges (title, description, impact_area_id, namespace_id, author_id, visibility, status)
       values ($1, 'x', $2, $3, $4, 'org', 'valid') returning id`,
      [`Dbtest backfill ${stamp}`, ia[0]!.id, ns[0]!.id, author],
    );
    // The author's own follow is automatic — never an explicit first use. Another user's is.
    await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, 'challenge', $3), ($2, 'challenge', $3)`, [author, other, ch[0]!.id]);
    await pool.query(`insert into likes (user_id, parent_type, parent_id) values ($1, 'challenge', $2)`, [other, ch[0]!.id]);
    await pool.query(`update users set survey_last_shown_at = null where id = $1`, [other]);

    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..", "..");
    const sql = readFileSync(join(root, "db", "migrations", "0037_feedback_survey.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf("-- ── Backfill first uses"));
    await pool.query(backfill);
    await pool.query(backfill); // idempotent

    const uses = async (id: string) =>
      (await pool.query<{ feature: string }>(`select feature from user_feature_uses where user_id = $1 order by feature`, [id])).rows.map((r) => r.feature);
    assert.deepEqual(await uses(author), ["submit_challenge"]);
    assert.deepEqual(await uses(other), ["follow", "like"]);

    const { rows: marker } = await pool.query(`select 1 from platform_settings where key = 'survey_launch_staggered'`);
    assert.equal(marker.length, 1, "the stagger ran once at migration time and left its marker");
    const { rows: still } = await pool.query<{ survey_last_shown_at: Date | null }>(`select survey_last_shown_at from users where id = $1`, [other]);
    assert.equal(still[0]!.survey_last_shown_at, null, "a re-run never re-staggers");
  } finally {
    await pool.end();
  }
});

test("start: opens a self offer once under concurrency, stamps the cooldown on open, then 409 cooldown", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    // Opted out, inside the grace, just shown a random survey: the on-demand path ignores all three.
    const userId = await makeUser(pool, randomUUID().slice(0, 8), "start", { qsDaysAgo: 1, lastShownDaysAgo: 2 });
    await pool.query(`update users set surveys_enabled = false where id = $1`, [userId]);
    const before = await daily(pool);

    const [a, b] = await Promise.all([store.startSelfSurvey(pool, userId, { rng: win }), store.startSelfSurvey(pool, userId, { rng: win })]);
    assert.equal(a.status, "ok");
    assert.equal(b.status, "ok");
    if (a.status !== "ok" || b.status !== "ok") return;
    assert.deepEqual([a.created, b.created].sort(), [false, true], "exactly one start creates the offer");
    assert.equal(a.survey.trigger, "self");
    assert.equal(a.survey.feature, null, "the user picks the feature in the card");
    assert.equal(Date.parse(a.survey.expiresAt) - Date.parse(a.survey.shownAt), 7 * 24 * 60 * 60 * 1000);
    assert.equal((await daily(pool)).shown_self, before.shown_self + 1, "counted once");
    const { rows } = await pool.query<{ survey_self_shown_at: Date | null }>(`select survey_self_shown_at from users where id = $1`, [userId]);
    assert.ok(rows[0]!.survey_self_shown_at, "the cooldown is stamped on open");
    assert.ok((await store.readSelfSurvey(pool, userId))?.nextAt, "me.selfSurvey carries the cooldown's end");

    // Answer it: the cooldown still holds (it was stamped on open, never on submit).
    assert.deepEqual(
      await store.submitSurvey(pool, { id: userId, roles: member }, { answers: { "feature.useful": 4 }, via: "popup", feature: "search" }),
      { status: "ok" },
    );
    const again = await store.startSelfSurvey(pool, userId, { rng: win });
    assert.equal(again.status, "cooldown");
    if (again.status === "cooldown") assert.equal(Date.parse(again.nextAt), rows[0]!.survey_self_shown_at!.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Seven days on, it can start again.
    await pool.query(`update users set survey_self_shown_at = now() - interval '7 days' where id = $1`, [userId]);
    assert.equal(await store.readSelfSurvey(pool, userId).then((s) => s?.nextAt), null);
    assert.equal((await store.startSelfSurvey(pool, userId, { rng: win })).status, "ok");
  } finally {
    await pool.end();
  }
});

test("start: an open random offer is returned unchanged — no stamp, nothing counted; 409 while the switch is off", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const userId = await makeUser(pool, stamp, "startrandom");
    await store.recordFeatureUse(pool, userId, "like", true, { rng: win });
    const before = await daily(pool);
    const res = await store.startSelfSurvey(pool, userId, { rng: win });
    assert.equal(res.status, "ok");
    if (res.status === "ok") {
      assert.equal(res.created, false);
      assert.equal(res.survey.trigger, "feature");
    }
    assert.equal((await daily(pool)).shown_self, before.shown_self);
    const { rows } = await pool.query(`select survey_self_shown_at from users where id = $1`, [userId]);
    assert.equal(rows[0]!.survey_self_shown_at, null, "no cooldown stamped");

    const admin = await makeUser(pool, stamp, "startadmin");
    const other = await makeUser(pool, stamp, "startoff");
    await store.setSurveyEnabled(pool, false, admin);
    try {
      assert.deepEqual(await store.startSelfSurvey(pool, other, { rng: win }), { status: "surveys_off" });
      assert.equal(await store.readSelfSurvey(pool, other), null, "selfSurvey is null while the switch is off");
    } finally {
      await store.setSurveyEnabled(pool, true, admin);
    }
  } finally {
    await pool.end();
  }
});
