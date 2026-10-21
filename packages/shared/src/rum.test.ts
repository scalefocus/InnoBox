// §14.12 real user monitoring rules (INNOBOX_SPEC.md): the route registry and matcher, sampling,
// the flush schedule, beacon validation and coercion, error description and fingerprints, the INP
// rule, thresholds, the rollup arithmetic and the chart series.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUM_FLUSH_SCHEDULE_S,
  RUM_MAX_API_TIMINGS,
  RUM_MAX_VIEWS_PER_BEACON,
  RUM_OTHER_ROUTE,
  addDays,
  aggregateDailyRows,
  apiErrorPercent,
  coerceRumSampleRate,
  contiguousSeries,
  decideSampled,
  describeClientError,
  describeRejection,
  errorFingerprintInput,
  inpFromInteractions,
  isRumSampleRate,
  nextFlushStep,
  normalizeErrorMessage,
  parseRumRange,
  rumRangeSource,
  rumRangeStart,
  rumRouteFor,
  rumRouteName,
  rumVerdict,
  validateRumBeacon,
  weightedMean,
  type RumDailyRow,
} from "./rum.js";
import { rumAggregateSql } from "./rum-sql.js";

const ORIGIN = "https://innobox.example.test";
const TODAY = "2026-10-21";

test("the matcher resolves templates and never keeps a concrete id", () => {
  assert.equal(rumRouteFor("/"), "/");
  assert.equal(rumRouteFor("/challenges"), "/challenges");
  assert.equal(rumRouteFor("/challenges/new"), "/challenges/new", "a static segment beats a parameter");
  assert.equal(rumRouteFor("/challenges/412"), "/challenges/[number]");
  assert.equal(rumRouteFor("/challenges/412?tab=solutions#c-9"), "/challenges/[number]");
  assert.equal(rumRouteFor("/profile/3f2b"), "/profile/[userId]");
  assert.equal(rumRouteFor("/admin/monitoring/"), "/admin/monitoring");
  assert.equal(rumRouteFor("/no/such/page"), RUM_OTHER_ROUTE);
  assert.equal(rumRouteFor("/submit"), RUM_OTHER_ROUTE, "the public form is not monitored");
  assert.equal(rumRouteName("/challenges/[number]"), "Challenge");
  assert.equal(rumRouteName("*"), "All routes");
  assert.equal(rumRouteName("other"), "Other");
});

test("sampling is one draw against the rate", () => {
  assert.equal(decideSampled(100, 0.999), true);
  assert.equal(decideSampled(10, 0.05), true);
  assert.equal(decideSampled(10, 0.1), false);
  assert.equal(decideSampled(1, 0.0099), true);
  assert.equal(decideSampled(1, 0.01), false);
  // A 1 % rate over a seeded run samples about one session in a hundred.
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let sampled = 0;
  for (let i = 0; i < 20_000; i++) if (decideSampled(1, random())) sampled++;
  assert.ok(sampled > 120 && sampled < 280, `sampled ${sampled} of 20000`);
});

test("only the fixed sample rates are valid; a malformed stored rate reads as 100", () => {
  assert.equal(isRumSampleRate(25), true);
  assert.equal(isRumSampleRate(30), false);
  assert.equal(isRumSampleRate("50"), false);
  assert.equal(coerceRumSampleRate(null), 100);
  assert.equal(coerceRumSampleRate(10), 10);
});

test("the flush schedule backs off through the primes and resets after a send", () => {
  assert.deepEqual([...RUM_FLUSH_SCHEDULE_S], [17, 23, 37, 59, 97, 157]);
  let step = 0;
  const seen = [RUM_FLUSH_SCHEDULE_S[step]];
  for (let i = 0; i < 7; i++) {
    step = nextFlushStep(step, false);
    seen.push(RUM_FLUSH_SCHEDULE_S[step]);
  }
  assert.deepEqual(seen, [17, 23, 37, 59, 97, 157, 157, 157]);
  assert.equal(nextFlushStep(4, true), 0);
});

test("ranges: 7d reads raw rows, longer ranges the rollup", () => {
  assert.equal(parseRumRange("90d"), "90d");
  assert.equal(parseRumRange("1y"), "30d");
  assert.equal(parseRumRange(null), "30d");
  assert.equal(rumRangeSource("7d"), "raw");
  assert.equal(rumRangeSource("30d"), "rollup");
  assert.equal(rumRangeSource("all"), "rollup");
  assert.equal(rumRangeStart("7d", TODAY), "2026-10-15");
  assert.equal(rumRangeStart("all", TODAY), null);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("beacon validation refuses only the shape", () => {
  assert.equal(validateRumBeacon(null, TODAY).ok, false);
  assert.equal(validateRumBeacon([], TODAY).ok, false);
  assert.equal(validateRumBeacon({ sid: "abcdefgh-1234" }, TODAY).ok, false, "no views array");
  assert.equal(validateRumBeacon({ sid: "x", views: [] }, TODAY).ok, false, "a malformed session id");
  assert.equal(validateRumBeacon({ sid: "abcdefgh-1234", views: [] }, TODAY).ok, true);
});

test("beacon validation coerces, bounds, caps and truncates", () => {
  const result = validateRumBeacon(
    {
      sid: "0b8f0c3e-1a2b-4c5d-8e9f-001122334455",
      userId: "should-never-survive",
      views: [
        {
          route: "/challenges/412",
          day: TODAY,
          hard: true,
          lcp: 2400.6,
          inp: -5,
          cls: 42,
          ttfb: Number.NaN,
          nav: 999_999,
          api: [...Array.from({ length: 70 }, () => 120), "x"],
          calls: 3,
          apiErrors: 99,
          errors: 2,
          path: "/challenges/412",
        },
        { route: "/challenges/[number]", day: "2026-10-20", hard: false, lcp: 1000, cls: 0.2, ttfb: 50, inp: 80 },
        { route: "/", day: "2025-01-01" },
        "not a view",
      ],
      errors: [
        { message: "x".repeat(900), source: "/_next/a.js:1", frame: "f", route: "/admin" },
        { message: "   " },
      ],
    },
    TODAY,
  );
  assert.ok(result.ok);
  const { views, errors, sessionId } = result.value;
  assert.equal(sessionId, "0b8f0c3e-1a2b-4c5d-8e9f-001122334455");
  assert.equal(views.length, 3);
  const [hard, soft, old] = views;
  assert.equal(hard!.route, "other", "a concrete path is not a template");
  assert.equal(hard!.lcpMs, 2401);
  assert.equal(hard!.inpMs, 0);
  assert.equal(hard!.cls, 10);
  assert.equal(hard!.ttfbMs, null);
  assert.equal(hard!.navMs, 120_000);
  assert.equal(hard!.apiMs.length, RUM_MAX_API_TIMINGS);
  assert.equal(hard!.apiCalls, RUM_MAX_API_TIMINGS, "calls are at least the timings");
  assert.equal(hard!.apiErrors, RUM_MAX_API_TIMINGS, "errors never exceed calls");
  assert.equal(hard!.clientErrors, 2);
  assert.equal((hard as unknown as Record<string, unknown>).path, undefined);
  assert.equal(soft!.route, "/challenges/[number]");
  assert.equal(soft!.day, "2026-10-20", "a late flush keeps yesterday");
  assert.equal(soft!.lcpMs, null, "no LCP on a soft navigation");
  assert.equal(soft!.cls, null);
  assert.equal(soft!.ttfbMs, null);
  assert.equal(soft!.inpMs, 80);
  assert.equal(old!.day, TODAY, "a day outside the raw window is coerced to today");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.message.length, 500);
  assert.equal(errors[0]!.route, "/admin");
  assert.equal(JSON.stringify(result.value).includes("should-never-survive"), false);

  const many = validateRumBeacon({ sid: "abcdefgh-1234", views: Array.from({ length: 80 }, () => ({ route: "/" })) }, TODAY);
  assert.ok(many.ok);
  assert.equal(many.value.views.length, RUM_MAX_VIEWS_PER_BEACON);
});

test("the fingerprint collapses digits and quoted strings; source and line distinguish", () => {
  assert.equal(normalizeErrorMessage(`Cannot read 'title' of item 412`), "Cannot read <str> of item <n>");
  assert.equal(
    errorFingerprintInput("Failed at row 12", "/_next/a.js:10"),
    errorFingerprintInput("Failed at row 9001", "/_next/a.js:10"),
  );
  assert.notEqual(errorFingerprintInput("Boom", "/_next/a.js:10"), errorFingerprintInput("Boom", "/_next/a.js:11"));
  assert.notEqual(errorFingerprintInput("Boom", "/_next/a.js:10"), errorFingerprintInput("Boom", "/_next/b.js:10"));
});

test("client errors: the app's own are described, extensions and benign noise are dropped", () => {
  const own = describeClientError(
    {
      message: "x is undefined",
      filename: `${ORIGIN}/_next/static/chunks/app.js?v=3`,
      lineno: 12,
      stack: `TypeError: x is undefined\n    at render (${ORIGIN}/_next/static/chunks/app.js?v=3:12:5)\n    at other`,
    },
    ORIGIN,
  );
  assert.deepEqual(own, { message: "x is undefined", source: "/_next/static/chunks/app.js:12", frame: "render (/_next/static/chunks/app.js:12:5)" });

  const firefox = describeClientError({ message: "boom", stack: `render@${ORIGIN}/_next/a.js:3:9\n` }, ORIGIN);
  assert.deepEqual(firefox, { message: "boom", source: "", frame: "render@/_next/a.js:3:9" });

  assert.equal(describeClientError({ message: "e", filename: "chrome-extension://abc/content.js", lineno: 1 }, ORIGIN), null);
  assert.equal(describeClientError({ message: "e", stack: "Error: e\n at x (moz-extension://abc/c.js:1:1)" }, ORIGIN), null);
  assert.equal(describeClientError({ message: "e", filename: "https://cdn.other.test/x.js", lineno: 1 }, ORIGIN), null);
  assert.equal(describeClientError({ message: "Script error." }, ORIGIN), null, "no source and no frame");
  assert.equal(
    describeClientError({ message: "ResizeObserver loop completed with undelivered notifications.", filename: `${ORIGIN}/a.js` }, ORIGIN),
    null,
  );
});

test("rejections: an Error is described normally, anything else records its string form", () => {
  assert.deepEqual(describeRejection("quota exceeded", ORIGIN), { message: "quota exceeded", source: "", frame: "(unhandled rejection)" });
  assert.deepEqual(describeRejection(42, ORIGIN), { message: "42", source: "", frame: "(unhandled rejection)" });
  const err = new Error("fetch blew up");
  err.stack = `Error: fetch blew up\n    at load (${ORIGIN}/_next/x.js:4:2)`;
  assert.deepEqual(describeRejection(err, ORIGIN), { message: "fetch blew up", source: "", frame: "load (/_next/x.js:4:2)" });
  assert.equal(describeRejection({ toString: () => { throw new Error("no"); } }, ORIGIN), null);
});

test("INP discards the single worst interaction per 50", () => {
  assert.equal(inpFromInteractions([]), null);
  assert.equal(inpFromInteractions([40, 300, 120]), 300);
  const fifty = [900, ...Array.from({ length: 49 }, (_, i) => 100 + i)];
  assert.equal(inpFromInteractions(fifty), 148, "the 900 ms outlier is discarded at 50 interactions");
  assert.equal(inpFromInteractions(fifty.slice(0, 49)), 900, "but kept below 50");
});

test("verdicts at each threshold boundary", () => {
  assert.equal(rumVerdict("lcp", 2500), "good");
  assert.equal(rumVerdict("lcp", 2501), "needs-improvement");
  assert.equal(rumVerdict("lcp", 4001), "poor");
  assert.equal(rumVerdict("inp", 200), "good");
  assert.equal(rumVerdict("inp", 500), "needs-improvement");
  assert.equal(rumVerdict("cls", 0.1), "good");
  assert.equal(rumVerdict("cls", 0.26), "poor");
  assert.equal(rumVerdict("ttfb", 1800), "needs-improvement");
  assert.equal(rumVerdict("nav", 3001), "poor");
  assert.equal(rumVerdict("api", 500), "good");
  assert.equal(rumVerdict("api", null), null);
});

const row = (day: string, route: string, views: number, lcp: number | null, apiCalls = 0, api: number | null = null): RumDailyRow => ({
  day,
  route,
  views,
  sessions: views,
  p75: { lcp, inp: null, cls: null, ttfb: null, nav: null, api },
  apiCalls,
  apiErrors: 1,
  clientErrors: 0,
});

test("the rollup ranges blend daily p75 by views (API by calls) and sum the counts", () => {
  assert.equal(weightedMean([{ value: 1000, weight: 1 }, { value: 2000, weight: 3 }]), 1750);
  assert.equal(weightedMean([{ value: null, weight: 5 }]), null);

  const { routes, total } = aggregateDailyRows([
    row("2026-10-20", "/", 10, 1000, 4, 100),
    row("2026-10-21", "/", 30, 2000, 1, 900),
    row("2026-10-21", "/search", 50, null),
    row("2026-10-20", "*", 10, 1000),
    row("2026-10-21", "*", 80, 1500),
  ]);
  assert.deepEqual(
    routes.map((r) => [r.route, r.name, r.views]),
    [
      ["/search", "Search", 50],
      ["/", "Home", 40],
    ],
  );
  const home = routes.find((r) => r.route === "/")!;
  assert.equal(home.p75.lcp, 1750);
  assert.equal(home.p75.api, 260, "weighted by calls: (100×4 + 900×1) / 5");
  assert.equal(home.sessions, 40);
  assert.equal(home.apiErrors, 2);
  assert.equal(routes.find((r) => r.route === "/search")!.p75.lcp, null);
  assert.equal(total.route, "*");
  assert.equal(total.views, 90);
  assert.equal(total.p75.lcp, 1444, "(1000×10 + 1500×80) / 90");
  assert.equal(apiErrorPercent(1, 3), 33.3);
  assert.equal(apiErrorPercent(0, 0), null);
});

test("the chart series is contiguous to today; quiet days are zero with no vitals", () => {
  assert.deepEqual(contiguousSeries([], TODAY), []);
  const series = contiguousSeries(
    [
      { day: "2026-10-18", views: 5, p75Lcp: 1200, p75Inp: 90 },
      { day: "2026-10-20", views: 2, p75Lcp: null, p75Inp: 60 },
    ],
    TODAY,
  );
  assert.deepEqual(
    series.map((p) => [p.day, p.views, p.p75Lcp]),
    [
      ["2026-10-18", 5, 1200],
      ["2026-10-19", 0, null],
      ["2026-10-20", 2, null],
      ["2026-10-21", 0, null],
    ],
  );
});

test("the aggregate SQL adds the all-routes row and groups per day only when asked", () => {
  const perDay = rumAggregateSql("v.day >= $1", true);
  assert.match(perDay, /grouping sets \(\(v\.day, v\.route\), \(v\.day\)\)/);
  assert.match(perDay, /coalesce\(v\.route, '\*'\)/);
  assert.match(perDay, /unnest\(v\.api_ms\)/);
  const range = rumAggregateSql("v.day >= $1", false);
  assert.match(range, /grouping sets \(\(v\.route\), \(\)\)/);
  assert.doesNotMatch(range, /m\.day/);
  assert.doesNotMatch(perDay + range, /user_id/);
});
