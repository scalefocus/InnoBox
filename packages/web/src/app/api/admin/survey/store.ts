// Data layer for the Survey results card (INNOBOX_SPEC.md §14.11) — platform admins only (gated in
// the routes). Aggregates in SQL; every figure then runs through the pure §14.11 rules in
// @innobox/shared/survey-results, so a figure computed over fewer than 5 responses is withheld
// HERE and never reaches the browser. The current UTC day is always excluded.
//
// Dates: `answered_on` and `survey_daily.day` are `date` columns, read as `::text` so node-pg never
// turns them into a local-midnight Date — they are UTC calendar days, displayed verbatim.
// Relative imports (not `@/…`) so the gated *.dbtest.ts suite can load this under plain node.
import type { Pool } from "pg";
import {
  SURVEY_FEATURES,
  SURVEY_QUESTION_ORDER,
  isRetiredQuestion,
  isSurveyFeature,
  surveyFeatureLabel,
  surveyQuestionText,
  type SurveyFeature,
  type SurveySegment,
  type SurveyTrigger,
} from "@innobox/shared/survey";
import {
  SURVEY_COMMENTS_PAGE,
  buildSurveySeries,
  isWithheld,
  questionFigure,
  surveyBucketFor,
  surveyRangeBounds,
  triggersForSource,
  type SurveyBucket,
  type SurveyRange,
  type SurveySeriesPoint,
  type SurveySource,
} from "@innobox/shared/survey-results";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";
import { getSurveyEnabled } from "../../me/survey/store";

export interface SurveyFilters {
  range: SurveyRange;
  segment: SurveySegment | null;
  feature: SurveyFeature | null;
  source: SurveySource;
}

/** WHERE conditions over `survey_responses r` for the range and the filters. `withFeature: false`
 *  leaves the feature filter out (the feature list's own counts). */
function responseConditions(filters: SurveyFilters, now: Date, opts: { withFeature?: boolean } = {}): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const push = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const { from, to } = surveyRangeBounds(filters.range, now);
  const conds = [`r.answered_on < ${push(to)}::date`];
  if (from) conds.push(`r.answered_on >= ${push(from)}::date`);
  if (filters.segment) conds.push(`r.segment = ${push(filters.segment)}`);
  if (filters.feature && opts.withFeature !== false) conds.push(`r.feature = ${push(filters.feature)}`);
  const triggers = triggersForSource(filters.source);
  if (triggers) conds.push(`r.trigger = any(${push(triggers)}::text[])`);
  return { sql: conds.join(" and "), params };
}

// ── Summary ───────────────────────────────────────────────────────────────────────────────

export interface SurveyFunnel {
  shown: number;
  closed: number;
  submitted: number;
  submittedFromMenu: number;
  optedOut: number;
  shownSelf: number;
  submittedSelf: number;
}

export interface SurveyQuestionResult {
  key: string;
  text: string;
  retired: boolean;
  n: number;
  avg: number | null;
  distribution: number[] | null;
  withheld: boolean;
}

export interface SurveySummary {
  enabled: boolean;
  /** The last day with a response (current day excluded), whatever the filters. */
  lastDate: string | null;
  bucket: SurveyBucket;
  funnel: SurveyFunnel;
  series: SurveySeriesPoint[];
  questions: SurveyQuestionResult[];
  features: { key: SurveyFeature; label: string; n: number }[];
}

export async function surveySummary(pool: Pool, filters: SurveyFilters, now: Date = new Date()): Promise<SurveySummary> {
  const { from, to } = surveyRangeBounds(filters.range, now);
  const where = responseConditions(filters, now);
  const whereNoFeature = responseConditions(filters, now, { withFeature: false });

  const [enabled, lastRows, funnelRows, optedRows, dailyRows, answerRows, featureRows] = await Promise.all([
    getSurveyEnabled(pool),
    pool.query<{ last: string | null }>(`select max(answered_on)::text as last from survey_responses where answered_on < $1::date`, [to]),
    // The funnel is range-bound but UNFILTERED — it has no segment, feature or source dimension.
    pool.query<{ [K in keyof Omit<SurveyFunnel, "optedOut">]: string }>(
      `select coalesce(sum(shown), 0)::text as "shown", coalesce(sum(closed), 0)::text as "closed",
              coalesce(sum(submitted), 0)::text as "submitted", coalesce(sum(submitted_from_menu), 0)::text as "submittedFromMenu",
              coalesce(sum(shown_self), 0)::text as "shownSelf", coalesce(sum(submitted_self), 0)::text as "submittedSelf"
         from survey_daily
        where day < $1::date and ($2::date is null or day >= $2::date)`,
      [to, from],
    ),
    pool.query<{ n: string }>(`select count(*)::text as n from users where not surveys_enabled`),
    pool.query<{ day: string; n: string; overall_n: string; overall_sum: string }>(
      `select r.answered_on::text as day, count(*)::text as n, count(a.stars)::text as overall_n, coalesce(sum(a.stars), 0)::text as overall_sum
         from survey_responses r
         left join survey_answers a on a.response_id = r.id and a.question_key = 'general.overall'
        where ${where.sql}
        group by r.answered_on
        order by r.answered_on`,
      where.params,
    ),
    pool.query<{ question_key: string; stars: number; n: string }>(
      `select a.question_key, a.stars, count(*)::text as n
         from survey_answers a join survey_responses r on r.id = a.response_id
        where ${where.sql}
        group by a.question_key, a.stars`,
      where.params,
    ),
    pool.query<{ feature: string; n: string }>(
      `select r.feature, count(*)::text as n from survey_responses r
        where ${whereNoFeature.sql} and r.feature is not null
        group by r.feature`,
      whereNoFeature.params,
    ),
  ]);

  const f = funnelRows.rows[0]!;
  const funnel: SurveyFunnel = {
    shown: Number(f.shown),
    closed: Number(f.closed),
    submitted: Number(f.submitted),
    submittedFromMenu: Number(f.submittedFromMenu),
    optedOut: Number(optedRows.rows[0]?.n ?? 0),
    shownSelf: Number(f.shownSelf),
    submittedSelf: Number(f.submittedSelf),
  };

  const daily = dailyRows.rows.map((r) => ({ day: r.day, n: Number(r.n), overallN: Number(r.overall_n), overallSum: Number(r.overall_sum) }));
  const bucket = surveyBucketFor(filters.range, daily[0]?.day ?? null, daily[daily.length - 1]?.day ?? null);

  // Star counts per question, then one figure per question in catalog order (unknown keys last).
  const dist = new Map<string, number[]>();
  for (const row of answerRows.rows) {
    const counts = dist.get(row.question_key) ?? [0, 0, 0, 0, 0];
    counts[row.stars - 1] = Number(row.n);
    dist.set(row.question_key, counts);
  }
  const order = [...SURVEY_QUESTION_ORDER, ...[...dist.keys()].filter((k) => !SURVEY_QUESTION_ORDER.includes(k)).sort()];
  const featureLabel = filters.feature ? surveyFeatureLabel(filters.feature) : null;
  const questions: SurveyQuestionResult[] = order
    .filter((key) => dist.has(key))
    .map((key) => ({
      key,
      text: surveyQuestionText(key, featureLabel) ?? key,
      retired: isRetiredQuestion(key) || !SURVEY_QUESTION_ORDER.includes(key),
      ...questionFigure(dist.get(key)!),
    }));

  const featureCounts = new Map(featureRows.rows.filter((r) => isSurveyFeature(r.feature)).map((r) => [r.feature, Number(r.n)]));
  const features = SURVEY_FEATURES.filter((x) => featureCounts.has(x.key)).map((x) => ({ key: x.key, label: x.label, n: featureCounts.get(x.key)! }));

  return {
    enabled,
    lastDate: lastRows.rows[0]?.last ?? null,
    bucket,
    funnel,
    series: buildSurveySeries(daily, bucket),
    questions,
    features,
  };
}

// ── The free-text feed ────────────────────────────────────────────────────────────────────

export interface SurveyComment {
  id: string;
  answeredOn: string;
  feature: SurveyFeature | null;
  segment: SurveySegment;
  trigger: SurveyTrigger;
  text: string;
}

export interface SurveyCommentsPage {
  comments: SurveyComment[];
  total: number;
  hasMore: boolean;
  /** True when fewer than 5 comments match — the feed as a whole is withheld. */
  withheld: boolean;
}

/** Newest date first, then by the RANDOM id within a day, so intra-day order is never revealed. */
export async function surveyComments(
  pool: Pool,
  filters: SurveyFilters,
  page: { offset: number; limit: number },
  now: Date = new Date(),
): Promise<SurveyCommentsPage> {
  const where = responseConditions(filters, now);
  const { rows: countRows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from survey_responses r where ${where.sql} and r.free_text is not null`,
    where.params,
  );
  const total = Number(countRows[0]?.n ?? 0);
  if (isWithheld(total)) return { comments: [], total, hasMore: false, withheld: true };

  const limit = Math.max(1, Math.min(SURVEY_COMMENTS_PAGE, Math.floor(page.limit)));
  const offset = Math.max(0, Math.floor(page.offset));
  const params = [...where.params, limit, offset];
  const { rows } = await pool.query<{ id: string; answered_on: string; feature: string | null; segment: SurveySegment; trigger: SurveyTrigger; free_text: string }>(
    `select r.id, r.answered_on::text as answered_on, r.feature, r.segment, r.trigger, r.free_text
       from survey_responses r
      where ${where.sql} and r.free_text is not null
      order by r.answered_on desc, r.id
      limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  return {
    comments: rows.map((r) => ({
      id: r.id,
      answeredOn: r.answered_on,
      feature: isSurveyFeature(r.feature) ? r.feature : null,
      segment: r.segment,
      trigger: r.trigger,
      text: r.free_text,
    })),
    total,
    hasMore: offset + rows.length < total,
    withheld: false,
  };
}

// ── Delete ────────────────────────────────────────────────────────────────────────────────

/**
 * Removes a whole response, its star answers by cascade — a deliberate hard-delete path of its own
 * (§14.11), separate from the §10.3 content cascade. Audited as `survey.response_deleted` with a
 * description of what went, but NEVER the text itself: a deleted comment must not survive in the
 * append-only audit log.
 */
export async function deleteSurveyResponse(pool: Pool, id: string, actorUserId: string): Promise<"ok" | "not_found"> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      answered_on: string;
      feature: string | null;
      segment: string;
      survey_version: number;
      text_length: number;
      answer_count: number;
    }>(
      // One statement, no row lock: the app role has no UPDATE on survey_responses (immutable),
      // which `SELECT … FOR UPDATE` would need. The outer SELECT reads the pre-delete snapshot,
      // so the answer count is taken before the cascade removes them. A concurrent delete leaves
      // this one with no row → 404, never a second audit row.
      `with gone as (
         delete from survey_responses r where r.id = $1
         returning r.id, r.answered_on::text as answered_on, r.feature, r.segment, r.survey_version,
                   coalesce(char_length(r.free_text), 0) as text_length
       )
       select g.answered_on, g.feature, g.segment, g.survey_version, g.text_length,
              (select count(*)::int from survey_answers a where a.response_id = g.id) as answer_count
         from gone g`,
      [id],
    );
    const row = rows[0];
    if (!row) return "not_found";
    await appendAudit(client, {
      actorUserId,
      action: "survey.response_deleted",
      targetType: "survey_response",
      targetId: id,
      before: {
        answeredOn: row.answered_on,
        feature: row.feature,
        segment: row.segment,
        surveyVersion: row.survey_version,
        answerCount: row.answer_count,
        textLength: row.text_length,
      },
    });
    return "ok";
  });
}
