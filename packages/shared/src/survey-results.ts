// Survey results — the admin card's vocabulary and its privacy rules (INNOBOX_SPEC.md §14.11).
// Pure and CLIENT-SAFE (also exposed at `@innobox/shared/survey-results`): the range and filter
// parsing, the current-day exclusion, the trend buckets and — the part that matters — the
// minimum group size. The web store aggregates in SQL and runs every figure through these
// helpers before anything leaves the server, so a withheld figure never reaches the browser.
import { SURVEY_TRIGGERS, isSurveyFeature, type SurveyFeature, type SurveyResponseTrigger, type SurveySegment, SURVEY_SEGMENTS } from "./survey.js";

/** Any figure computed over fewer than this many responses is withheld. */
export const SURVEY_MIN_GROUP = 5;

/** The free-text feed's page size (and the most `limit` may ask for). */
export const SURVEY_COMMENTS_PAGE = 50;

export function isWithheld(n: number): boolean {
  return n < SURVEY_MIN_GROUP;
}

// ── Range ─────────────────────────────────────────────────────────────────────────────────

export const SURVEY_RANGES = ["7", "30", "90", "all"] as const;
export type SurveyRange = (typeof SURVEY_RANGES)[number];
export const DEFAULT_SURVEY_RANGE: SurveyRange = "30";

export const SURVEY_RANGE_LABEL: Record<SurveyRange, string> = { "7": "7d", "30": "30d", "90": "90d", all: "All" };

export function parseSurveyRange(raw: string | null | undefined): SurveyRange {
  return (SURVEY_RANGES as readonly string[]).includes(raw ?? "") ? (raw as SurveyRange) : DEFAULT_SURVEY_RANGE;
}

/** `YYYY-MM-DD` of the UTC calendar day `date` falls in. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDay(d);
}

/**
 * The days a range covers, as a half-open `[from, to)` over `answered_on`. `to` is always TODAY
 * (UTC), exclusive: the current day is never shown, so a fresh response can never be lined up
 * with who is online right now. `from` is null for "all".
 */
export function surveyRangeBounds(range: SurveyRange, now: Date): { from: string | null; to: string } {
  const to = utcDay(now);
  if (range === "all") return { from: null, to };
  return { from: addDays(to, -Number(range)), to };
}

// ── Filters ───────────────────────────────────────────────────────────────────────────────

export const SURVEY_SOURCES = ["all", "prompted", "self", "bug"] as const;
export type SurveySource = (typeof SURVEY_SOURCES)[number];
export const SURVEY_SOURCE_LABEL: Record<SurveySource, string> = { all: "All", prompted: "Prompted", self: "Self-initiated", bug: "Bug reports" };

export function parseSurveySource(raw: string | null | undefined): SurveySource {
  return (SURVEY_SOURCES as readonly string[]).includes(raw ?? "") ? (raw as SurveySource) : "all";
}

/** The triggers a source covers; null for "all" (no condition). *Prompted* is the random
 *  survey — first-use and fallback alike; *Self-initiated* stays `self` only; *Bug reports* is
 *  `bug` only. */
export function triggersForSource(source: SurveySource): SurveyResponseTrigger[] | null {
  if (source === "all") return null;
  if (source === "self") return ["self"];
  if (source === "bug") return ["bug"];
  return SURVEY_TRIGGERS.filter((t) => t !== "self");
}

/**
 * The free-text feed's withholding with bug reports in it (§14.11). The size-5 rule covers the
 * SURVEY comments of the filtered set only; bug reports are listed whatever their number, since a
 * bug report is a problem to act on. Returns whether the survey comments are withheld and which
 * kinds of row the feed lists. With the *Bug reports* source, or with no survey comment at all,
 * there is nothing to withhold.
 */
export function surveyFeedPlan(source: SurveySource, surveyCommentCount: number): { withheld: boolean; listSurvey: boolean; listBugs: boolean } {
  if (source === "bug") return { withheld: false, listSurvey: false, listBugs: true };
  const listBugs = source === "all";
  if (surveyCommentCount > 0 && isWithheld(surveyCommentCount)) return { withheld: true, listSurvey: false, listBugs };
  return { withheld: false, listSurvey: true, listBugs };
}

export function parseSurveySegmentFilter(raw: string | null | undefined): SurveySegment | null {
  return (SURVEY_SEGMENTS as readonly string[]).includes(raw ?? "") ? (raw as SurveySegment) : null;
}

export function parseSurveyFeatureFilter(raw: string | null | undefined): SurveyFeature | null {
  return isSurveyFeature(raw) ? raw : null;
}

// ── Question cards ────────────────────────────────────────────────────────────────────────

export interface QuestionFigure {
  n: number;
  avg: number | null;
  /** Count of 1★ … 5★, index 0 = one star. */
  distribution: number[] | null;
  withheld: boolean;
}

/** One question's figure from its star counts — withheld below the group size. `n` counts the
 *  responses that answered it, and stays visible (it is what the withholding note explains). */
export function questionFigure(distribution: readonly number[]): QuestionFigure {
  const counts = [0, 1, 2, 3, 4].map((i) => distribution[i] ?? 0);
  const n = counts.reduce((a, b) => a + b, 0);
  if (isWithheld(n)) return { n, avg: null, distribution: null, withheld: true };
  const sum = counts.reduce((acc, c, i) => acc + c * (i + 1), 0);
  return { n, avg: Math.round((sum / n) * 10) / 10, distribution: counts, withheld: false };
}

// ── The satisfaction trend ────────────────────────────────────────────────────────────────

export type SurveyBucket = "day" | "week" | "month";

/** Day buckets up to a month, weeks up to about half a year, months beyond. For "all" the span
 *  is the data's own (first to last answered day). */
export function surveyBucketFor(range: SurveyRange, firstDay: string | null, lastDay: string | null): SurveyBucket {
  if (range === "7" || range === "30") return "day";
  if (range === "90") return "week";
  if (!firstDay || !lastDay) return "day";
  const spanDays = (Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000;
  if (spanDays <= 31) return "day";
  if (spanDays <= 183) return "week";
  return "month";
}

/** The bucket a day belongs to, named by its first day (weeks start on Monday, UTC). */
export function bucketStart(day: string, bucket: SurveyBucket): string {
  if (bucket === "day") return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  const d = new Date(`${day}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday → 0
  return addDays(day, -offset);
}

export interface DailySurveyRow {
  day: string;
  /** Responses that day. */
  n: number;
  /** Responses that answered `general.overall`, and the sum of their stars. */
  overallN: number;
  overallSum: number;
}

export interface SurveySeriesPoint {
  date: string;
  n: number;
  /** Withheld (null) when fewer than SURVEY_MIN_GROUP responses answered the overall question —
   *  the chart leaves a gap. */
  overallAvg: number | null;
}

/** Groups daily rows into buckets, oldest first, withholding thin averages. No zero-filling:
 *  a bucket with no responses is simply absent. */
export function buildSurveySeries(rows: readonly DailySurveyRow[], bucket: SurveyBucket): SurveySeriesPoint[] {
  const byBucket = new Map<string, { n: number; overallN: number; overallSum: number }>();
  for (const row of rows) {
    const key = bucketStart(row.day, bucket);
    const acc = byBucket.get(key) ?? { n: 0, overallN: 0, overallSum: 0 };
    acc.n += row.n;
    acc.overallN += row.overallN;
    acc.overallSum += row.overallSum;
    byBucket.set(key, acc);
  }
  return [...byBucket.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, acc]) => ({
      date,
      n: acc.n,
      overallAvg: isWithheld(acc.overallN) ? null : Math.round((acc.overallSum / acc.overallN) * 10) / 10,
    }));
}
