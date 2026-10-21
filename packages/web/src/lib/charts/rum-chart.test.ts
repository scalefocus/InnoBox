// §14.12 monitoring chart and table formatting (INNOBOX_SPEC.md): the option builder (page-view
// bars plus two lines on a second axis, a null breaks a line, no data-zoom, the aria sentence, the
// escaped tooltip), the millisecond and layout-shift formats, the verdict pills and the table sort.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RumRouteSummary } from "@innobox/shared/rum";
import { buildRumOption, rumAriaDescription, rumTooltip } from "./rum-chart";
import type { ChartEnv } from "./chart-env";
import { formatRumCls, formatRumMs, formatRumPercent, sortRoutes, verdictLabel, verdictPillClass } from "../rum-format";

const env: ChartEnv = {
  tokens: { accent: "#0a0", accentSoft: "#efe", anchor: "#003", muted: "#666", faint: "#999", line: "#ddd", ink: "#111", surface: "#fff", fontBody: "sans" },
  coarsePointer: false,
  width: 800,
};

const points = [
  { day: "2026-10-19", views: 40, p75Lcp: 2100, p75Inp: 90 },
  { day: "2026-10-20", views: 0, p75Lcp: null, p75Inp: null },
  { day: "2026-10-21", views: 12, p75Lcp: 1500, p75Inp: 70 },
];

test("bars for views on the left axis, LCP and INP lines on the right", () => {
  const option = buildRumOption({ points, style: "eu", env }) as Record<string, unknown>;
  const series = option.series as { name: string; type: string; yAxisIndex: number; connectNulls?: boolean; data: [number, number | null][]; lineStyle?: { type: string } }[];
  assert.deepEqual(
    series.map((s) => [s.name, s.type, s.yAxisIndex]),
    [
      ["Page views", "bar", 0],
      ["p75 LCP", "line", 1],
      ["p75 INP", "line", 1],
    ],
  );
  assert.equal(series[1]!.connectNulls, false);
  assert.equal(series[1]!.data[1]![1], null, "a quiet day breaks the line");
  assert.equal(series[0]!.data[1]![1], 0, "and is a zero bar");
  assert.notEqual(series[1]!.lineStyle!.type, series[2]!.lineStyle!.type, "told apart by dash, not only colour");
  assert.equal(option.dataZoom, undefined, "the range buttons are the window");
  assert.equal((option.yAxis as unknown[]).length, 2);
});

test("the aria sentence states the span, the total and the latest day", () => {
  assert.equal(
    rumAriaDescription(points, "eu"),
    "Page views as bars and p75 LCP and p75 INP as lines per UTC day, 3 days from 19/10/2026 to 21/10/2026, 52 views in all. Latest day: 12 views, p75 LCP 1.50 s, p75 INP 70 ms.",
  );
  assert.match(rumAriaDescription([], "us"), /No days recorded yet/);
});

test("the tooltip names the UTC day and escapes everything it interpolates", () => {
  const ms = Date.UTC(2026, 9, 21);
  const html = rumTooltip(
    [
      { seriesName: "Page views", marker: "", axisValue: ms, value: [ms, 12] },
      { seriesName: "p75 LCP", marker: "", axisValue: ms, value: [ms, 2390] },
      { seriesName: "<b>x</b>", marker: "", axisValue: ms, value: [ms, null] },
    ],
    "us",
  );
  assert.match(html, /10\/21\/2026 \(UTC\)/);
  assert.match(html, /Page views <strong>12<\/strong>/);
  assert.match(html, /p75 LCP <strong>2\.39 s<\/strong>/);
  assert.match(html, /&#60;b&#62;x&#60;\/b&#62; <strong>—<\/strong>/);
});

test("formats: milliseconds, seconds, layout shift and percent", () => {
  assert.equal(formatRumMs(null), "—");
  assert.equal(formatRumMs(85), "85 ms");
  assert.equal(formatRumMs(999.6), "1000 ms");
  assert.equal(formatRumMs(2390), "2.39 s");
  assert.equal(formatRumCls(0.11), "0.110");
  assert.equal(formatRumPercent(0.1), "0.1 %");
  assert.equal(formatRumPercent(null), "—");
  assert.equal(verdictPillClass("good"), "pill-ok");
  assert.equal(verdictPillClass("needs-improvement"), "pill-warn");
  assert.equal(verdictPillClass("poor"), "pill-danger");
  assert.equal(verdictLabel("needs-improvement"), "needs improvement");
});

const route = (name: string, views: number, lcp: number | null, apiErrors: number): RumRouteSummary => ({
  route: `/${name}`,
  name,
  views,
  sessions: views,
  p75: { lcp, inp: null, cls: null, ttfb: null, nav: null, api: null },
  apiCalls: 10,
  apiErrors,
  clientErrors: 0,
});

test("the table sorts by any column, and a missing value sinks either way", () => {
  const rows = [route("Search", 5, 3000, 3), route("Home", 50, null, 0), route("Profile", 20, 1200, 1)];
  assert.deepEqual(sortRoutes(rows, "views", true).map((r) => r.name), ["Home", "Profile", "Search"]);
  assert.deepEqual(sortRoutes(rows, "lcp", true).map((r) => r.name), ["Search", "Profile", "Home"]);
  assert.deepEqual(sortRoutes(rows, "lcp", false).map((r) => r.name), ["Profile", "Search", "Home"]);
  assert.deepEqual(sortRoutes(rows, "name", false).map((r) => r.name), ["Home", "Profile", "Search"]);
  assert.deepEqual(sortRoutes(rows, "apiErrors", true).map((r) => r.name), ["Search", "Profile", "Home"]);
});
