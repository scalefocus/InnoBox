// Unit tests for the §14.11 satisfaction-trend option: a withheld average is a break in the
// line (never interpolated), markers appear with fewer than 3 points and on isolated points,
// the tooltip carries the date in the platform's order and the count, and there is no zoom.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChartEnv } from "./chart-env";
import {
  buildSurveyTrendOption,
  needsMarker,
  surveyTrendAriaDescription,
  surveyTrendTooltip,
  type SurveyTrendPoint,
} from "./survey-trend-chart";

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

const point = (date: string, n: number, overallAvg: number | null): SurveyTrendPoint => ({ date, n, overallAvg });

interface Shape {
  series: { type: string; yAxisIndex: number; data: (number | null | { value: number; symbolSize: number })[]; connectNulls?: boolean }[];
  xAxis: { type: string; data: string[]; axisLabel: { formatter: (d: string) => string } };
  dataZoom?: unknown;
}
const shape = (o: unknown) => o as Shape;

test("bars are the response count, the line is the average — each on its own axis", () => {
  const series = [point("2026-10-05", 7, 4.2), point("2026-10-06", 9, 3.8), point("2026-10-07", 6, 4)];
  const o = shape(buildSurveyTrendOption({ series, style: "eu", env: ENV }));
  const [bars, line] = o.series;
  assert.equal(bars!.type, "bar");
  assert.equal(bars!.yAxisIndex, 1);
  assert.deepEqual(bars!.data, [7, 9, 6]);
  assert.equal(line!.type, "line");
  assert.equal(line!.yAxisIndex, 0);
  assert.equal(o.xAxis.type, "category");
  assert.deepEqual(o.xAxis.data, ["2026-10-05", "2026-10-06", "2026-10-07"]);
});

test("a withheld average is a break in the line, never interpolated", () => {
  const series = [point("2026-10-05", 7, 4.2), point("2026-10-06", 3, null), point("2026-10-07", 6, 4)];
  const line = shape(buildSurveyTrendOption({ series, style: "eu", env: ENV })).series[1]!;
  assert.equal(line.data[1], null);
  assert.equal(line.connectNulls, false);
});

test("markers: every point when there are fewer than 3, otherwise only isolated ones", () => {
  const two = [point("2026-10-05", 7, 4.2), point("2026-10-06", 9, 3.8)];
  assert.ok(needsMarker(two, 0) && needsMarker(two, 1));

  const many = [point("a", 7, 4), point("b", 7, 4), point("c", 2, null), point("d", 7, 3), point("e", 2, null)];
  assert.equal(needsMarker(many, 0), false, "a point on a drawn segment needs no marker");
  assert.equal(needsMarker(many, 3), true, "a point between two gaps would otherwise be invisible");
  assert.equal(needsMarker(many, 2), false, "a withheld point has nothing to mark");

  const line = shape(buildSurveyTrendOption({ series: many, style: "eu", env: ENV })).series[1]!;
  assert.deepEqual(line.data[3], { value: 3, symbolSize: 8 });
  assert.deepEqual(line.data[0], { value: 4, symbolSize: 0 });
});

test("the tooltip carries the date in the platform's order, the count and — unless withheld — the average", () => {
  assert.equal(surveyTrendTooltip(point("2026-10-05", 7, 4.2), "eu"), "<strong>05/10/2026</strong><br>7 responses<br>Average 4.2★");
  assert.equal(surveyTrendTooltip(point("2026-10-05", 1, null), "us"), "<strong>10/05/2026</strong><br>1 response");
  assert.equal(surveyTrendTooltip(undefined, "eu"), "");
});

test("the screen-reader summary names the span and the latest bucket, withheld or not", () => {
  const series = [point("2026-10-05", 7, 4.2), point("2026-10-06", 9, 3.8)];
  assert.equal(
    surveyTrendAriaDescription(series, "eu"),
    "Average overall satisfaction and responses, 2 periods from 05/10/2026 to 06/10/2026. Latest: an average of 3.8 out of 5 from 9 responses.",
  );
  assert.ok(
    surveyTrendAriaDescription([point("2026-10-05", 3, null)], "us").endsWith("Latest: 3 responses, too few to show an average."),
  );
  const o = buildSurveyTrendOption({ series, style: "eu", env: ENV }) as { aria?: { label?: { description?: string } } };
  assert.equal(o.aria?.label?.description, surveyTrendAriaDescription(series, "eu"));
});

test("the date axis uses the platform's order and there is no zoom", () => {
  const o = shape(buildSurveyTrendOption({ series: [point("2026-10-05", 7, 4.2)], style: "us", env: ENV }));
  assert.equal(o.xAxis.axisLabel.formatter("2026-10-05"), "10/05/2026");
  assert.equal(o.dataZoom, undefined, "week and month buckets are not zoomed");
});
