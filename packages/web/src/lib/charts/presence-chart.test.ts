// Unit tests for the §14.5 active-users chart option. The builder is pure, so the rules that
// would otherwise only show up on screen are pinned here: a missing weekly/monthly sample stays
// a break (never 0), the presets' window maths, the zoom controls that must not hijack page
// scrolling, the UTC day labels in the platform's order, and an escaped tooltip.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChartEnv } from "./chart-env";
import {
  DAY_MS,
  PRESENCE_SERIES,
  applyManualZoom,
  buildPresenceOption,
  isolatedPoints,
  legendRows,
  presenceAriaDescription,
  presenceTooltip,
  presetWindow,
  seriesExtent,
  zoomWindowFromEvent,
  type PresenceChartPoint,
} from "./presence-chart";

const ENV: ChartEnv = {
  tokens: {
    accent: "#14abe3",
    accentSoft: "#dcf2fb",
    anchor: "#082773",
    muted: "#58595b",
    faint: "#909193",
    line: "#e2e3e4",
    ink: "#1a1a1a",
    surface: "#ffffff",
    fontBody: "Open Sans",
  },
  coarsePointer: false,
  width: 640,
};

/** `count` consecutive days ending 2026-07-31, with WAU/MAU missing on the first two. */
function days(count: number): PresenceChartPoint[] {
  const end = Date.UTC(2026, 6, 31);
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(end - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10);
    return { day, activeUsers: i, wau: i < 2 ? null : i * 2, mau: i < 2 ? null : i * 3 };
  });
}

// The option is a deep union type; the tests read it through narrow shapes.
interface Shape {
  series: { name: string; data: [number, number | null][]; connectNulls: boolean; lineStyle: { color: string; type: string } }[];
  dataZoom: Record<string, unknown>[];
  xAxis: { type: string; min: number; max: number; minInterval: number; axisLabel: { formatter: (v: number) => string } };
  legend: { data: string[] };
}
const shape = (o: unknown) => o as Shape;

test("three lines: daily, weekly and monthly — told apart by dash pattern as well as colour", () => {
  const o = shape(buildPresenceOption({ points: days(10), window: null, style: "eu", env: ENV }));
  assert.deepEqual(
    o.series.map((s) => s.name),
    ["Daily active", "Weekly active (rolling 7 days)", "Monthly active (rolling 30 days)"],
  );
  assert.deepEqual(o.legend.data, o.series.map((s) => s.name));
  assert.deepEqual(o.series.map((s) => s.lineStyle.type), ["solid", "dashed", "dotted"]);
  assert.deepEqual(o.series.map((s) => s.lineStyle.color), [ENV.tokens.accent, ENV.tokens.anchor, ENV.tokens.muted]);
});

test("a missing weekly/monthly sample stays null — a break, never a zero, never bridged", () => {
  const o = shape(buildPresenceOption({ points: days(10), window: null, style: "eu", env: ENV }));
  const [daily, weekly, monthly] = o.series;
  assert.equal(weekly!.data[0]![1], null);
  assert.equal(monthly!.data[1]![1], null);
  assert.equal(weekly!.data[2]![1], 4);
  // The daily line has a value every day (the API returns quiet days as 0).
  assert.equal(daily!.data[0]![1], 0);
  for (const s of o.series) assert.equal(s.connectNulls, false);
});

test("a lone sample between two breaks is drawn as a dot; otherwise symbols stay hover-only", () => {
  assert.deepEqual([...isolatedPoints([null, 5, null, 3, 4, null, 7])], [1, 6]);
  assert.equal(isolatedPoints([1, 2, 3]).size, 0);

  const points = days(10).map((p, i) => (i === 3 || i === 5 ? { ...p, wau: null } : p));
  const o = buildPresenceOption({ points, window: null, style: "eu", env: ENV }) as unknown as {
    series: { showSymbol: boolean; symbolSize: number | ((v: unknown, p: { dataIndex: number }) => number) }[];
  };
  const [daily, weekly] = o.series;
  assert.equal(daily!.showSymbol, false, "a series without lone samples keeps hover-only symbols");
  assert.equal(weekly!.showSymbol, true);
  const size = weekly!.symbolSize as (v: unknown, p: { dataIndex: number }) => number;
  assert.equal(size(null, { dataIndex: 4 }), 6, "day 4 sits between the breaks on days 3 and 5");
  assert.equal(size(null, { dataIndex: 7 }), 0);
});

test("the plot makes room for the legend as it wraps on narrower cards", () => {
  assert.deepEqual([900, 640, 300, 0].map(legendRows), [1, 2, 3, 2]);
  const top = (width: number) =>
    (buildPresenceOption({ points: days(10), window: null, style: "eu", env: { ...ENV, width } }) as unknown as { grid: { top: number } }).grid.top;
  assert.ok(top(300) > top(640) && top(640) > top(900), "a phone-width card gets the most room above the plot");
});

test("points sit on UTC midnights and the axis never ticks below a day", () => {
  const points = days(10);
  const o = shape(buildPresenceOption({ points, window: null, style: "eu", env: ENV }));
  assert.equal(o.series[0]!.data[0]![0], Date.UTC(2026, 6, 22));
  assert.equal(o.xAxis.type, "time");
  assert.equal(o.xAxis.min, Date.UTC(2026, 6, 22));
  assert.equal(o.xAxis.max, Date.UTC(2026, 6, 31));
  assert.equal(o.xAxis.minInterval, DAY_MS);
});

test("axis labels are the UTC day in the platform's order, not the viewer's local day", () => {
  const eu = shape(buildPresenceOption({ points: days(10), window: null, style: "eu", env: ENV }));
  const us = shape(buildPresenceOption({ points: days(10), window: null, style: "us", env: ENV }));
  const midnight = Date.UTC(2026, 6, 13);
  assert.equal(eu.xAxis.axisLabel.formatter(midnight), "13/07");
  assert.equal(us.xAxis.axisLabel.formatter(midnight), "07/13");
});

test("presets: the trailing 7 / 30 / 90 days, or everything; a short series is shown whole", () => {
  const points = days(100);
  const extent = seriesExtent(points)!;
  assert.deepEqual(presetWindow(points, "7d"), { startMs: extent.endMs - 7 * DAY_MS, endMs: extent.endMs });
  assert.deepEqual(presetWindow(points, "30d"), { startMs: extent.endMs - 30 * DAY_MS, endMs: extent.endMs });
  assert.deepEqual(presetWindow(points, "all"), extent);
  // Ten days of history: 30d and 90d both resolve to the whole series (§14.5 cold start).
  const young = days(10);
  assert.deepEqual(presetWindow(young, "90d"), seriesExtent(young));
  assert.equal(presetWindow([], "30d"), null);
});

test("the zoom window reaches both the slider and the inside zoom", () => {
  const points = days(100);
  const window = presetWindow(points, "30d")!;
  const o = shape(buildPresenceOption({ points, window, style: "eu", env: ENV }));
  for (const dz of o.dataZoom) {
    assert.equal(dz.startValue, window.startMs);
    assert.equal(dz.endValue, window.endMs);
    // Lines run to the window's edges instead of stopping at the first point inside it.
    assert.equal(dz.filterMode, "none");
  }
});

test("a bare wheel scrolls the page: zoom only with Ctrl, and the wheel never pans", () => {
  const o = shape(buildPresenceOption({ points: days(10), window: null, style: "eu", env: ENV }));
  const inside = o.dataZoom.find((dz) => dz.type === "inside")!;
  assert.equal(inside.zoomOnMouseWheel, "ctrl");
  assert.equal(inside.moveOnMouseWheel, false);
  assert.equal(inside.disabled, false, "drag-to-pan is on for a fine pointer");
  assert.ok(o.dataZoom.some((dz) => dz.type === "slider"), "the slider is always there");
});

test("on a coarse (touch) pointer the plot does not pan, so a swipe still scrolls the page", () => {
  const o = shape(buildPresenceOption({ points: days(10), window: null, style: "eu", env: { ...ENV, coarsePointer: true } }));
  assert.equal(o.dataZoom.find((dz) => dz.type === "inside")!.disabled, true);
  assert.equal(o.dataZoom.find((dz) => dz.type === "slider")!.disabled, undefined, "the slider is the touch control");
});

test("a manual zoom is read back as a window — slider percentages and inside batches alike", () => {
  const extent = { startMs: 0, endMs: 100 * DAY_MS };
  assert.deepEqual(zoomWindowFromEvent({ type: "datazoom", start: 50, end: 100 }, extent), { startMs: 50 * DAY_MS, endMs: 100 * DAY_MS });
  assert.deepEqual(zoomWindowFromEvent({ type: "datazoom", batch: [{ start: 0, end: 25 }] }, extent), { startMs: 0, endMs: 25 * DAY_MS });
  assert.deepEqual(zoomWindowFromEvent({ startValue: 3 * DAY_MS, endValue: 9 * DAY_MS }, extent), { startMs: 3 * DAY_MS, endMs: 9 * DAY_MS });
  assert.equal(zoomWindowFromEvent(null, extent), null);
});

test("a manual zoom releases the pressed preset and keeps the window it produced", () => {
  const extent = { startMs: 0, endMs: 100 * DAY_MS };
  const current = { startMs: 70 * DAY_MS, endMs: 100 * DAY_MS };
  assert.deepEqual(applyManualZoom({ start: 10, end: 20 }, extent, current), {
    window: { startMs: 10 * DAY_MS, endMs: 20 * DAY_MS },
    pressed: null,
  });
  // An event that carries no range still releases the preset, keeping the current window.
  assert.deepEqual(applyManualZoom(undefined, extent, current), { window: current, pressed: null });
});

test("the tooltip names the UTC day in the platform's order and shows — for a missing value", () => {
  const axisValue = Date.UTC(2026, 6, 13);
  const html = presenceTooltip(
    [
      { seriesName: PRESENCE_SERIES[0].name, axisValue, value: [axisValue, 42] },
      { seriesName: PRESENCE_SERIES[1].name, axisValue, value: [axisValue, 118] },
      { seriesName: PRESENCE_SERIES[2].name, axisValue, value: [axisValue, null] },
    ],
    "eu",
  );
  assert.ok(html.includes("13/07/2026 (UTC)"));
  assert.ok(html.includes("Daily active <strong>42</strong>"));
  assert.ok(html.includes("Weekly active <strong>118</strong>"));
  assert.ok(html.includes("Monthly active <strong>—</strong>"));
  assert.ok(presenceTooltip([{ seriesName: PRESENCE_SERIES[0].name, axisValue, value: [axisValue, 1] }], "us").includes("07/13/2026 (UTC)"));
});

test("the screen-reader summary names the span and latest values — never raw timestamps", () => {
  const points = days(10);
  const text = presenceAriaDescription(points, "eu");
  assert.equal(
    text,
    "Daily, weekly and monthly active users per UTC day, 10 days from 22/07/2026 to 31/07/2026. Latest day: 9 daily, 18 weekly and 27 monthly active users.",
  );
  assert.ok(!/\d{10,}/.test(text), "no epoch milliseconds");
  const young = days(1);
  assert.ok(presenceAriaDescription(young, "us").includes("no weekly and no monthly"), "a missing sample says so");
  const o = buildPresenceOption({ points, window: null, style: "eu", env: ENV }) as { aria?: { label?: { description?: string } } };
  assert.equal(o.aria?.label?.description, text);
});

test("the tooltip escapes what it interpolates", () => {
  const axisValue = Date.UTC(2026, 6, 13);
  const html = presenceTooltip([{ seriesName: "<img src=x>", axisValue, value: [axisValue, 1] }], "eu");
  assert.ok(!html.includes("<img"), "an unknown series name is rendered as text");
  assert.ok(html.includes("&#60;img"));
});
