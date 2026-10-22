// Real user monitoring rules shared by the browser collector, the beacon endpoint, the admin
// read path and the worker's rollup (INNOBOX_SPEC.md §14.12). Client-safe: pure functions and
// constants, no node imports (also at `@innobox/shared/rum`).
//
// Two privacy properties are enforced here rather than trusted to callers:
//   • A view names its page by TEMPLATE only. `rumRouteFor` turns a concrete pathname into its
//     registry template before anything leaves the browser, and `validateRumBeacon` coerces any
//     template the server does not know to "other" — so no number, title or id is ever stored.
//   • A beacon carries no person. The validated shape has no field a user id could ride in.
import { calendarDayMs, utcCalendarDay } from "./calendar-day.js";

// ── Settings ─────────────────────────────────────────────────────────────────────────────

export const RUM_ENABLED_KEY = "rum_enabled";
export const RUM_SAMPLE_RATE_KEY = "rum_sample_rate";

/** The sample rates an admin may choose, in percent of sessions. */
export const RUM_SAMPLE_RATES = [100, 50, 25, 10, 1] as const;
export type RumSampleRate = (typeof RUM_SAMPLE_RATES)[number];
export const DEFAULT_RUM_SAMPLE_RATE: RumSampleRate = 100;

export function isRumSampleRate(value: unknown): value is RumSampleRate {
  return typeof value === "number" && (RUM_SAMPLE_RATES as readonly number[]).includes(value);
}

/** A stored rate that is missing or malformed reads as the default. */
export function coerceRumSampleRate(value: unknown): RumSampleRate {
  return isRumSampleRate(value) ? value : DEFAULT_RUM_SAMPLE_RATE;
}

/** One draw per session: `random` in [0, 1). A 10 % rate samples one session in ten. */
export function decideSampled(rate: number, random: number): boolean {
  return random * 100 < rate;
}

// ── Flush schedule ───────────────────────────────────────────────────────────────────────

/** Seconds to the next flush: 17 while something was sent, then backing off through primes to
 *  157 while idle. Primes keep thousands of tabs from flushing in step. */
export const RUM_FLUSH_SCHEDULE_S = [17, 23, 37, 59, 97, 157] as const;

/** The schedule step after a tick: back to the start when the tick sent something, else one step
 *  further, stopping at the last. */
export function nextFlushStep(step: number, sentSomething: boolean): number {
  if (sentSomething) return 0;
  return Math.min(step + 1, RUM_FLUSH_SCHEDULE_S.length - 1);
}

export const RUM_FLUSH_SCHEDULE_TEXT = `beacons every ${RUM_FLUSH_SCHEDULE_S[0]} s while active, backing off to ${RUM_FLUSH_SCHEDULE_S.at(-1)} s when idle`;

// ── Limits ───────────────────────────────────────────────────────────────────────────────

export const RUM_MAX_VIEWS_PER_BEACON = 50;
export const RUM_MAX_ERRORS_PER_BEACON = 50;
export const RUM_MAX_BEACON_BYTES = 64 * 1024;
/** Durations timed per view; further calls are counted but not timed. */
export const RUM_MAX_API_TIMINGS = 50;
/** Error occurrences described per view; further ones are only counted. */
export const RUM_MAX_ERRORS_PER_VIEW = 10;
export const RUM_MESSAGE_MAX = 500;
export const RUM_FRAME_MAX = 200;
export const RUM_SOURCE_MAX = 300;
export const RUM_DURATION_MAX_MS = 120_000;
export const RUM_CLS_MAX = 10;
const RUM_COUNT_MAX = 10_000;

/** Raw views are kept this many days; the 7d range is the only one they cover. */
export const RUM_RAW_RETENTION_DAYS = 7;
/** A deduplicated error row is deleted this long after it was last seen. */
export const RUM_ERROR_RETENTION_DAYS = 90;
/** The errors list shows at most this many rows. */
export const RUM_ERROR_LIST_CAP = 50;
/** Fewer rollup days than this and the chart gives way to the "not enough history" note. */
export const RUM_MIN_CHART_POINTS = 7;

// ── Ranges ───────────────────────────────────────────────────────────────────────────────

export const RUM_RANGES = ["7d", "30d", "90d", "all"] as const;
export type RumRange = (typeof RUM_RANGES)[number];
export const DEFAULT_RUM_RANGE: RumRange = "30d";

export function parseRumRange(raw: string | null | undefined): RumRange {
  return (RUM_RANGES as readonly string[]).includes(raw ?? "") ? (raw as RumRange) : DEFAULT_RUM_RANGE;
}

/** Days in a range, today included; null for All. */
export function rumRangeDays(range: RumRange): number | null {
  return range === "all" ? null : Number(range.slice(0, -1));
}

/** 7d is computed from raw views (a true p75); every longer range reads the daily rollup. */
export function rumRangeSource(range: RumRange): "raw" | "rollup" {
  return range === "7d" ? "raw" : "rollup";
}

// ── Days ─────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `day` moved by `delta` whole days (UTC calendar arithmetic, no time zone involved). */
export function addDays(day: string, delta: number): string {
  return utcCalendarDay(calendarDayMs(day) + delta * DAY_MS);
}

/** The first UTC day a range covers, or null for All. */
export function rumRangeStart(range: RumRange, today: string): string | null {
  const days = rumRangeDays(range);
  return days === null ? null : addDays(today, -(days - 1));
}

// ── Route registry ───────────────────────────────────────────────────────────────────────

/** A view of a page that is not in the registry. */
export const RUM_OTHER_ROUTE = "other";

/**
 * Every authenticated page, by its App Router template, with the name the table shows. The
 * signed-out Home and the public form never send a beacon, so they are absent; "/" is the
 * signed-in Home. A unit test walks app/**\/page.tsx and fails when a page is missing here.
 */
export const RUM_ROUTES: readonly { template: string; name: string }[] = [
  { template: "/", name: "Home" },
  { template: "/challenges", name: "Challenges" },
  { template: "/challenges/new", name: "New challenge" },
  { template: "/challenges/[number]", name: "Challenge" },
  { template: "/search", name: "Search" },
  { template: "/topics", name: "Topics" },
  { template: "/leaderboard", name: "Leaderboard" },
  { template: "/profile", name: "Profile" },
  { template: "/profile/[userId]", name: "User profile" },
  { template: "/quick-start", name: "Quick start" },
  { template: "/whats-new", name: "What's new" },
  { template: "/agents", name: "AI agents" },
  { template: "/admin", name: "Administration" },
  { template: "/admin/triage", name: "Triage queue" },
  { template: "/admin/settings", name: "Platform settings" },
  { template: "/admin/audit", name: "Audit log" },
  { template: "/admin/system-log", name: "System log" },
  { template: "/admin/trash", name: "Trash" },
  { template: "/admin/public-submissions", name: "Public submissions" },
  { template: "/admin/feature-ideas", name: "Feature ideas" },
  { template: "/admin/monitoring", name: "Real user monitoring" },
];

/** Pages deliberately outside the registry: unauthenticated surfaces that carry no collector. */
export const RUM_UNMONITORED_TEMPLATES: readonly string[] = ["/submit", "/submit/confirm"];

const TEMPLATE_NAMES = new Map(RUM_ROUTES.map((r) => [r.template, r.name]));

/** Static templates first, then by fewer parameters, so `/challenges/new` beats
 *  `/challenges/[number]`. */
const MATCH_ORDER = [...RUM_ROUTES]
  .map((r) => ({ template: r.template, segments: splitPath(r.template) }))
  .sort((a, b) => paramCount(a.segments) - paramCount(b.segments));

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function paramCount(segments: string[]): number {
  return segments.filter(isParam).length;
}

function isParam(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

export function isKnownRumRoute(template: string): boolean {
  return template === RUM_OTHER_ROUTE || TEMPLATE_NAMES.has(template);
}

/** The template a concrete pathname belongs to, or "other". Query string and hash are ignored. */
export function rumRouteFor(pathname: string): string {
  const clean = pathname.split(/[?#]/)[0] ?? "";
  const segments = splitPath(clean);
  for (const candidate of MATCH_ORDER) {
    if (candidate.segments.length !== segments.length) continue;
    if (candidate.segments.every((seg, i) => isParam(seg) || seg === segments[i])) return candidate.template;
  }
  return RUM_OTHER_ROUTE;
}

/** The table name for a template; "All routes" for the '*' row and "Other" for the rest. */
export function rumRouteName(template: string): string {
  if (template === "*") return "All routes";
  return TEMPLATE_NAMES.get(template) ?? "Other";
}

// ── Beacon validation (server side) ──────────────────────────────────────────────────────

export interface RumViewInput {
  route: string;
  day: string;
  hardLoad: boolean;
  lcpMs: number | null;
  inpMs: number | null;
  navMs: number | null;
  ttfbMs: number | null;
  cls: number | null;
  apiMs: number[];
  apiCalls: number;
  apiErrors: number;
  clientErrors: number;
}

export interface RumErrorInput {
  message: string;
  source: string;
  frame: string;
  route: string;
}

export interface RumBeacon {
  sessionId: string;
  views: RumViewInput[];
  errors: RumErrorInput[];
}

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function duration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(RUM_DURATION_MAX_MS, Math.max(0, Math.round(value)));
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(RUM_COUNT_MAX, Math.max(0, Math.round(value)));
}

function clsValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(RUM_CLS_MAX, Math.max(0, value)) * 10_000) / 10_000;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // One line, no control characters.
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

function route(value: unknown): string {
  return typeof value === "string" && isKnownRumRoute(value) ? value : RUM_OTHER_ROUTE;
}

/** The view's own UTC day, accepted only inside the raw window (a tab hidden at 23:58 flushes
 *  after midnight with yesterday's day); anything else is today. */
function viewDay(value: unknown, today: string): string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return today;
  if (value > today || value < addDays(today, -RUM_RAW_RETENTION_DAYS)) return today;
  return value;
}

function validateView(raw: Record<string, unknown>, today: string): RumViewInput {
  const hardLoad = raw.hard === true;
  const apiMs = Array.isArray(raw.api)
    ? raw.api
        .slice(0, RUM_MAX_API_TIMINGS)
        .map(duration)
        .filter((v): v is number => v !== null)
    : [];
  const apiCalls = Math.max(count(raw.calls), apiMs.length);
  return {
    route: route(raw.route),
    day: viewDay(raw.day, today),
    hardLoad,
    // LCP, CLS and TTFB belong to a hard load; a soft navigation has none of its own.
    lcpMs: hardLoad ? duration(raw.lcp) : null,
    inpMs: duration(raw.inp),
    navMs: duration(raw.nav),
    ttfbMs: hardLoad ? duration(raw.ttfb) : null,
    cls: hardLoad ? clsValue(raw.cls) : null,
    apiMs,
    apiCalls,
    apiErrors: Math.min(count(raw.apiErrors), apiCalls),
    clientErrors: count(raw.errors),
  };
}

function validateError(raw: Record<string, unknown>): RumErrorInput | null {
  const message = text(raw.message, RUM_MESSAGE_MAX);
  if (!message) return null;
  return {
    message,
    source: text(raw.source, RUM_SOURCE_MAX),
    frame: text(raw.frame, RUM_FRAME_MAX),
    route: route(raw.route),
  };
}

/**
 * Validates and coerces a beacon body. Only the shape is refused (a non-object, no `views` array,
 * a malformed session id); every field inside is bounded, truncated or coerced rather than
 * rejected, and unknown fields are dropped. `today` is the server's UTC day.
 */
export function validateRumBeacon(raw: unknown, today: string): { ok: true; value: RumBeacon } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: "beacon must be a JSON object" };
  if (!Array.isArray(raw.views)) return { ok: false, error: "beacon must carry a views array" };
  if (typeof raw.sid !== "string" || !SESSION_ID_RE.test(raw.sid)) return { ok: false, error: "beacon must carry a session id" };
  const views = raw.views
    .slice(0, RUM_MAX_VIEWS_PER_BEACON)
    .filter(isRecord)
    .map((v) => validateView(v, today));
  const errors = (Array.isArray(raw.errors) ? raw.errors : [])
    .slice(0, RUM_MAX_ERRORS_PER_BEACON)
    .filter(isRecord)
    .map(validateError)
    .filter((e): e is RumErrorInput => e !== null);
  return { ok: true, value: { sessionId: raw.sid, views, errors } };
}

// ── Client errors ────────────────────────────────────────────────────────────────────────

/** Digits and quoted strings collapsed, so a message that embeds a number or a name is one error
 *  rather than thousands. The fingerprint hashes this plus the source file and line. */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the server hashes into a fingerprint. */
export function errorFingerprintInput(message: string, source: string): string {
  return `${normalizeErrorMessage(message)}\n${source}`;
}

const EXTENSION_SCHEME = /^(?:chrome|moz|safari|safari-web|ms-browser)-extension:\/\//i;
const BENIGN_MESSAGES = [/^ResizeObserver loop/i];
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s()]+/gi;

/** A URL reduced to what the error list may show: the path only for the app's own scripts. Null
 *  when it points outside the app — an extension or another origin. */
function ownPath(url: string, origin: string): string | null {
  if (EXTENSION_SCHEME.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin) return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

/** A trailing ":line" or ":line:col". No two quantifiers can claim the same character, so it runs
 *  in linear time on any input. */
const LINE_COL = /:\d+(?::\d+)?$/;
/** Stack lines read and the length each is cut to before any pattern runs: a stack is
 *  attacker-influenced text (anyone can throw), and a real top frame is far shorter. */
const STACK_LINES_READ = 20;
const STACK_LINE_MAX = 1000;

/** `url:12:5` → [`url`, `:12:5`]; no suffix → [`url`, ``]. */
function splitLineCol(url: string): [string, string] {
  const m = LINE_COL.exec(url);
  return m ? [url.slice(0, m.index), m[0]] : [url, ""];
}

/** A Firefox/Safari frame, `fn@url:line:col`: an `@` followed by a whitespace-free location that
 *  ends in a line number. Checked with string operations, not a backtracking pattern. */
function isAtFrame(line: string): boolean {
  const at = line.lastIndexOf("@");
  if (at < 0) return false;
  const location = line.slice(at + 1);
  return location.length > 0 && !/\s/.test(location) && LINE_COL.test(location) && splitLineCol(location)[0].length > 0;
}

/** The first stack line (V8 `at …` or Firefox/Safari `fn@url`), its URLs reduced to paths. Null
 *  when the frame points outside the app. */
export function topFrame(stack: string | undefined, origin: string): string | null | undefined {
  if (!stack) return undefined;
  const line = stack
    .split("\n", STACK_LINES_READ)
    .map((l) => l.slice(0, STACK_LINE_MAX).trim())
    .find((l) => l.startsWith("at ") || isAtFrame(l));
  if (!line) return undefined;
  let outside = false;
  const rewritten = line.replace(/^at\s+/, "").replace(URL_IN_TEXT, (url) => {
    // Keep the trailing ":line:col" that follows the path inside the URL match.
    const [bare, lineCol] = splitLineCol(url);
    const path = ownPath(bare, origin);
    if (path === null) {
      outside = true;
      return url;
    }
    return `${path}${lineCol}`;
  });
  if (outside) return null;
  return rewritten.slice(0, RUM_FRAME_MAX);
}

export interface RawClientError {
  message: string;
  /** ErrorEvent.filename — empty for a rejection or a cross-origin script. */
  filename?: string;
  lineno?: number;
  stack?: string;
}

/**
 * What the collector records for an error, or null to drop it: a browser extension's error, a
 * script from another origin, an error with neither a source nor a frame, and the one benign
 * ResizeObserver message every app sees. Never anything from the DOM or a form.
 */
export function describeClientError(raw: RawClientError, origin: string): { message: string; source: string; frame: string } | null {
  const message = text(raw.message, RUM_MESSAGE_MAX);
  if (!message || BENIGN_MESSAGES.some((re) => re.test(message))) return null;
  const frame = topFrame(raw.stack, origin);
  if (frame === null) return null;
  let source = "";
  if (raw.filename) {
    const path = ownPath(raw.filename, origin);
    if (path === null) return null;
    source = raw.lineno ? `${path}:${raw.lineno}` : path;
  }
  if (!source && !frame) return null;
  return { message, source: source.slice(0, RUM_SOURCE_MAX), frame: frame ?? "" };
}

/** The frame recorded for a rejection whose reason is not an Error — it has no stack to read. */
export const RUM_REJECTION_FRAME = "(unhandled rejection)";

/** An `unhandledrejection` reason: an Error is described like any error; anything else records its
 *  `String()` form, truncated, with a fixed frame (it has neither a source nor a stack). */
export function describeRejection(reason: unknown, origin: string): { message: string; source: string; frame: string } | null {
  if (reason instanceof Error) {
    return describeClientError({ message: reason.message || reason.name, stack: reason.stack }, origin);
  }
  let message: string;
  try {
    message = text(String(reason), RUM_MESSAGE_MAX);
  } catch {
    return null; // an object whose toString throws
  }
  if (!message || BENIGN_MESSAGES.some((re) => re.test(message))) return null;
  return { message, source: "", frame: RUM_REJECTION_FRAME };
}

// ── INP ──────────────────────────────────────────────────────────────────────────────────

/**
 * The INP of a set of interactions (each the longest event duration of one interaction id): the
 * worst, after discarding the single worst per 50 interactions. Null with no interaction.
 */
export function inpFromInteractions(durations: readonly number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => b - a);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length / 50));
  return Math.round(sorted[index]!);
}

// ── Thresholds ───────────────────────────────────────────────────────────────────────────

export type RumMetric = "lcp" | "inp" | "cls" | "ttfb" | "nav" | "api";
export type RumVerdict = "good" | "needs-improvement" | "poor";

/** [good up to, needs improvement up to]. The Web Vitals thresholds for LCP, INP, CLS and TTFB;
 *  InnoBox's own bars for navigation and API latency. */
export const RUM_THRESHOLDS: Record<RumMetric, readonly [number, number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  ttfb: [800, 1800],
  nav: [1000, 3000],
  api: [500, 1500],
};

export function rumVerdict(metric: RumMetric, value: number | null): RumVerdict | null {
  if (value === null) return null;
  const [good, ni] = RUM_THRESHOLDS[metric];
  if (value <= good) return "good";
  return value <= ni ? "needs-improvement" : "poor";
}

// ── Aggregation over daily rows (the rollup ranges) ──────────────────────────────────────

export interface RumP75 {
  lcp: number | null;
  inp: number | null;
  cls: number | null;
  ttfb: number | null;
  nav: number | null;
  api: number | null;
}

export interface RumDailyRow {
  day: string;
  route: string;
  views: number;
  sessions: number;
  p75: RumP75;
  apiCalls: number;
  apiErrors: number;
  clientErrors: number;
}

export interface RumRouteSummary {
  route: string;
  name: string;
  views: number;
  sessions: number;
  p75: RumP75;
  apiCalls: number;
  apiErrors: number;
  clientErrors: number;
}

/** Weighted mean of the non-null values; null when nothing carries weight. */
export function weightedMean(pairs: readonly { value: number | null; weight: number }[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const { value, weight: w } of pairs) {
    if (value === null || w <= 0) continue;
    sum += value * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

const roundMs = (v: number | null) => (v === null ? null : Math.round(v));
const roundCls = (v: number | null) => (v === null ? null : Math.round(v * 10_000) / 10_000);

/**
 * Daily rows → one summary per route. Counts add up; sessions are the sum of daily distinct
 * sessions; each p75 is the views-weighted mean of the daily p75 (API latency weighted by calls),
 * because a percentile cannot be re-aggregated. The '*' rows become the all-routes total.
 */
export function aggregateDailyRows(rows: readonly RumDailyRow[]): { routes: RumRouteSummary[]; total: RumRouteSummary } {
  const byRoute = new Map<string, RumDailyRow[]>();
  for (const row of rows) {
    const list = byRoute.get(row.route) ?? [];
    list.push(row);
    byRoute.set(row.route, list);
  }
  const summarize = (route: string, list: readonly RumDailyRow[]): RumRouteSummary => {
    const byViews = (key: keyof RumP75) => list.map((r) => ({ value: r.p75[key], weight: r.views }));
    return {
      route,
      name: rumRouteName(route),
      views: list.reduce((n, r) => n + r.views, 0),
      sessions: list.reduce((n, r) => n + r.sessions, 0),
      p75: {
        lcp: roundMs(weightedMean(byViews("lcp"))),
        inp: roundMs(weightedMean(byViews("inp"))),
        cls: roundCls(weightedMean(byViews("cls"))),
        ttfb: roundMs(weightedMean(byViews("ttfb"))),
        nav: roundMs(weightedMean(byViews("nav"))),
        api: roundMs(weightedMean(list.map((r) => ({ value: r.p75.api, weight: r.apiCalls })))),
      },
      apiCalls: list.reduce((n, r) => n + r.apiCalls, 0),
      apiErrors: list.reduce((n, r) => n + r.apiErrors, 0),
      clientErrors: list.reduce((n, r) => n + r.clientErrors, 0),
    };
  };
  const routes = [...byRoute.entries()]
    .filter(([route]) => route !== "*")
    .map(([route, list]) => summarize(route, list))
    .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name));
  return { routes, total: summarize("*", byRoute.get("*") ?? []) };
}

// ── The chart series ─────────────────────────────────────────────────────────────────────

export interface RumSeriesPoint {
  day: string;
  views: number;
  p75Lcp: number | null;
  p75Inp: number | null;
}

/** One point per UTC day from the first recorded day to `today`: a day without a row is 0 views
 *  and no vitals (the lines break there). No rows at all → no points. */
export function contiguousSeries(rows: readonly RumSeriesPoint[], today: string): RumSeriesPoint[] {
  if (rows.length === 0) return [];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const first = rows.reduce((min, r) => (r.day < min ? r.day : min), rows[0]!.day);
  const out: RumSeriesPoint[] = [];
  for (let day = first; day <= today; day = addDays(day, 1)) {
    out.push(byDay.get(day) ?? { day, views: 0, p75Lcp: null, p75Inp: null });
  }
  return out;
}

/** Percent of calls that failed, one decimal; null with no calls. */
export function apiErrorPercent(errors: number, calls: number): number | null {
  if (calls <= 0) return null;
  return Math.round((errors / calls) * 1000) / 10;
}
