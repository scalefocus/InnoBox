// Live-DB integration tests (gated) for the Survey results card (INNOBOX_SPEC.md §14.11): range and
// the current-day exclusion, the Segment/Feature/Source filters, the size-5 withholding (question
// cards, trend buckets, the feed), and the delete — cascade plus an audit row that never carries
// the text. Self-skips when DATABASE_URL is unset.
//
// Each test seeds its own backdated responses under a feature + segment combination no other suite
// writes, and filters on it, so the assertions are exact in the harness's throwaway database
// (no other suite writes backdated responses; submissions are dated today, which is excluded).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

async function deps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const store = await import("./store");
  return { Pool, randomUUID, store };
}

/** One response `daysAgo` UTC days back, with its star answers. */
async function seed(
  pool: Pool,
  r: { daysAgo: number; feature: string | null; segment: string; trigger?: string; text?: string | null; answers: Record<string, number> },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into survey_responses (answered_on, survey_version, trigger, feature, segment, via, free_text)
     values ((now() at time zone 'utc')::date - $1::int, 1, $2, $3, $4, 'popup', $5) returning id`,
    [r.daysAgo, r.trigger ?? "feature", r.feature, r.segment, r.text ?? null],
  );
  const id = rows[0]!.id;
  for (const [key, stars] of Object.entries(r.answers)) {
    await pool.query(`insert into survey_answers (response_id, question_key, stars) values ($1, $2, $3)`, [id, key, stars]);
  }
  return id;
}

const NOW = () => new Date();

test("summary: range, the current-day exclusion, and the size-5 withholding", { skip }, async () => {
  const { Pool, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    // Feature "leaderboard" × segment "committee" is this test's own slice.
    const base = { feature: "leaderboard", segment: "committee" };
    for (let i = 0; i < 5; i++) await seed(pool, { ...base, daysAgo: 2, answers: { "general.overall": 4, "feature.useful": 5 } });
    for (let i = 0; i < 3; i++) await seed(pool, { ...base, daysAgo: 40, answers: { "general.overall": 2 } });
    await seed(pool, { ...base, daysAgo: 0, answers: { "general.overall": 1 } }); // today — never shown

    const filters = { segment: "committee" as const, feature: "leaderboard" as const, source: "all" as const };
    const week = await store.surveySummary(pool, { ...filters, range: "7" }, NOW());
    assert.equal(week.series.reduce((n, p) => n + p.n, 0), 5, "today is excluded; 40 days ago is out of range");
    const overall = week.questions.find((q) => q.key === "general.overall")!;
    assert.deepEqual([overall.n, overall.avg, overall.withheld], [5, 4, false]);
    assert.deepEqual(overall.distribution, [0, 0, 0, 5, 0]);
    assert.equal(week.questions.find((q) => q.key === "feature.useful")!.text, "How useful is the leaderboard for your work?");

    const all = await store.surveySummary(pool, { ...filters, range: "all" }, NOW());
    assert.equal(all.series.reduce((n, p) => n + p.n, 0), 8);
    // The 40-days-ago bucket holds 3 responses: its average is withheld (a gap), its count shown.
    const thin = all.series.find((p) => p.n === 3)!;
    assert.equal(thin.overallAvg, null);

    // A question answered by fewer than 5 is withheld — no average, no distribution.
    for (let i = 0; i < 4; i++) await seed(pool, { ...base, daysAgo: 3, answers: { "rotating.docs": 5 } });
    const docs = (await store.surveySummary(pool, { ...filters, range: "7" }, NOW())).questions.find((q) => q.key === "rotating.docs")!;
    assert.deepEqual([docs.n, docs.avg, docs.distribution, docs.withheld], [4, null, null, true]);
  } finally {
    await pool.end();
  }
});

test("summary: the Segment, Feature and Source filters; the funnel stays unfiltered", { skip }, async () => {
  const { Pool, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    // "triage" × "admin" is this test's slice: 2 prompted (feature + visit) and 1 self-initiated.
    await seed(pool, { daysAgo: 1, feature: "triage", segment: "admin", trigger: "feature", answers: { "general.overall": 5 } });
    await seed(pool, { daysAgo: 1, feature: "triage", segment: "admin", trigger: "visit", answers: { "general.overall": 5 } });
    await seed(pool, { daysAgo: 1, feature: "triage", segment: "admin", trigger: "self", answers: { "general.overall": 5 } });
    const count = async (source: "all" | "prompted" | "self") =>
      (await store.surveySummary(pool, { range: "7", segment: "admin", feature: "triage", source }, NOW())).series.reduce((n, p) => n + p.n, 0);
    assert.equal(await count("all"), 3);
    assert.equal(await count("prompted"), 2);
    assert.equal(await count("self"), 1);

    const s = await store.surveySummary(pool, { range: "7", segment: "admin", feature: null, source: "all" }, NOW());
    assert.ok(s.features.some((f) => f.key === "triage" && f.n >= 3), "the feature list counts within the other filters");
    const unfiltered = await store.surveySummary(pool, { range: "7", segment: null, feature: null, source: "all" }, NOW());
    assert.deepEqual(s.funnel, unfiltered.funnel, "the funnel has no segment/feature/source dimension");
  } finally {
    await pool.end();
  }
});

test("comments: withheld below 5, then newest day first and paged", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const filters = { range: "30" as const, segment: "member" as const, feature: "attachments" as const, source: "all" as const };
    for (let i = 0; i < 4; i++) await seed(pool, { daysAgo: 5, feature: "attachments", segment: "member", text: `old ${stamp} ${i}`, answers: {} });
    const thin = await store.surveyComments(pool, filters, { offset: 0, limit: 50 }, NOW());
    assert.deepEqual([thin.withheld, thin.comments.length], [true, 0], "fewer than 5 → the whole feed is withheld");

    await seed(pool, { daysAgo: 1, feature: "attachments", segment: "member", trigger: "self", text: `new ${stamp}`, answers: {} });
    const page = await store.surveyComments(pool, filters, { offset: 0, limit: 2 }, NOW());
    assert.equal(page.withheld, false);
    assert.equal(page.total, 5);
    assert.equal(page.hasMore, true);
    assert.equal(page.comments[0]!.text, `new ${stamp}`, "newest date first");
    assert.equal(page.comments[0]!.trigger, "self", "the Self-initiated tag's source");
    assert.match(page.comments[0]!.answeredOn, /^\d{4}-\d{2}-\d{2}$/, "a date only — never a time");
    const rest = await store.surveyComments(pool, filters, { offset: 2, limit: 50 }, NOW());
    assert.equal(rest.comments.length, 3);
    assert.equal(rest.hasMore, false);
  } finally {
    await pool.end();
  }
});

test("delete: the whole response goes (answers by cascade) and the audit row carries no text", { skip }, async () => {
  const { Pool, randomUUID, store } = await deps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const { rows: u } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
      [`dbtest-survey-admin-${stamp}`, `dbtest-survey-admin-${stamp}@example.test`, `Dbtest Survey Admin ${stamp}`, `survey-admin-${stamp}@example.test`],
    );
    const text = `Abusive dbtest comment ${stamp}`;
    const id = await seed(pool, { daysAgo: 3, feature: "comment", segment: "member", text, answers: { "general.overall": 1, "feature.ease": 2 } });

    assert.equal(await store.deleteSurveyResponse(pool, id, u[0]!.id), "ok");
    assert.equal((await pool.query(`select 1 from survey_responses where id = $1`, [id])).rows.length, 0);
    assert.equal((await pool.query(`select 1 from survey_answers where response_id = $1`, [id])).rows.length, 0, "answers cascade");
    assert.equal(await store.deleteSurveyResponse(pool, id, u[0]!.id), "not_found");

    const { rows } = await pool.query<{ target_type: string; before: Record<string, unknown>; after: unknown }>(
      `select target_type, before, after from audit_log where action = 'survey.response_deleted' and target_id = $1`,
      [id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.target_type, "survey_response");
    assert.deepEqual(rows[0]!.before, {
      answeredOn: rows[0]!.before.answeredOn,
      feature: "comment",
      segment: "member",
      surveyVersion: 1,
      answerCount: 2,
      textLength: text.length,
    });
    assert.ok(!JSON.stringify(rows[0]).includes(text), "the text never reaches the append-only audit log");
  } finally {
    await pool.end();
  }
});
