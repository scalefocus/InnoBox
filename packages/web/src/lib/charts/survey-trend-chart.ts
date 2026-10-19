// The survey "Satisfaction trend" as a pure ECharts option (INNOBOX_SPEC.md §14.11): the
// average of "Overall" (1–5★) as a line, the response count as bars on a second axis, one
// category per bucket. A withheld average (fewer than 5 responses) is a BREAK in the line,
// never interpolated; with fewer than 3 points, and on any point with no drawn neighbour, the
// line gets visible markers. No zoom — the buckets already adapt to the range.
import type { ComposeOption } from "echarts/core";
import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import type { AriaComponentOption, GridComponentOption, TooltipComponentOption } from "echarts/components";
import { formatCalendarDay } from "@innobox/shared/calendar-day";
import { escapeHtml, type ChartEnv } from "./chart-env";

export type SurveyTrendOption = ComposeOption<
  BarSeriesOption | LineSeriesOption | GridComponentOption | TooltipComponentOption | AriaComponentOption
>;

export interface SurveyTrendPoint {
  date: string;
  n: number;
  overallAvg: number | null;
}

/** Bars stay in the lower part of the plot, under the line, as the hand-rolled chart had them. */
const BAR_HEADROOM = 0.6;

/** Whether a point needs its own marker: few points, or no drawn neighbour on either side (a
 *  one-point segment would otherwise be invisible). */
export function needsMarker(series: readonly SurveyTrendPoint[], i: number): boolean {
  if (series[i]?.overallAvg === null || series[i] === undefined) return false;
  if (series.length < 3) return true;
  return (series[i - 1]?.overallAvg ?? null) === null && (series[i + 1]?.overallAvg ?? null) === null;
}

export function surveyTrendTooltip(point: SurveyTrendPoint | undefined, style: "eu" | "us"): string {
  if (!point) return "";
  const lines = [
    `<strong>${escapeHtml(formatCalendarDay(point.date, style))}</strong>`,
    escapeHtml(`${point.n} response${point.n === 1 ? "" : "s"}`),
  ];
  if (point.overallAvg !== null) lines.push(escapeHtml(`Average ${point.overallAvg}★`));
  return lines.join("<br>");
}

/** The screen-reader summary, in place of ECharts' generated one (which reads bar indexes and
 *  raw values aloud): what the chart shows, its span, and the latest bucket. */
export function surveyTrendAriaDescription(series: readonly SurveyTrendPoint[], style: "eu" | "us"): string {
  const first = series[0];
  const last = series.at(-1);
  if (!first || !last) return "Average overall satisfaction over time. No responses yet.";
  const latest =
    last.overallAvg === null
      ? `${last.n} response${last.n === 1 ? "" : "s"}, too few to show an average`
      : `an average of ${last.overallAvg} out of 5 from ${last.n} response${last.n === 1 ? "" : "s"}`;
  return (
    `Average overall satisfaction and responses, ${series.length} period${series.length === 1 ? "" : "s"} from ` +
    `${formatCalendarDay(first.date, style)} to ${formatCalendarDay(last.date, style)}. Latest: ${latest}.`
  );
}

export interface SurveyTrendInput {
  series: readonly SurveyTrendPoint[];
  style: "eu" | "us";
  env: ChartEnv;
}

export function buildSurveyTrendOption({ series, style, env }: SurveyTrendInput): SurveyTrendOption {
  const { tokens } = env;
  const peakN = Math.max(1, ...series.map((p) => p.n));

  return {
    aria: { label: { description: surveyTrendAriaDescription(series, style) } },
    grid: { left: 8, right: 8, top: 12, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
      textStyle: { color: tokens.ink, fontSize: 12.5 },
      axisPointer: { type: "shadow", shadowStyle: { color: tokens.accentSoft, opacity: 0.4 } },
      formatter: (params) => {
        const first = (Array.isArray(params) ? params[0] : params) as { dataIndex?: number } | undefined;
        return surveyTrendTooltip(series[first?.dataIndex ?? -1], style);
      },
    },
    xAxis: {
      type: "category",
      data: series.map((p) => p.date),
      axisLine: { lineStyle: { color: tokens.line } },
      axisTick: { show: false },
      axisLabel: { color: tokens.faint, fontSize: 11, hideOverlap: true, formatter: (d: string) => formatCalendarDay(d, style) },
    },
    yAxis: [
      {
        type: "value",
        min: 1,
        max: 5,
        interval: 1,
        axisLabel: { color: tokens.faint, fontSize: 11, formatter: "{value}★" },
        splitLine: { lineStyle: { color: tokens.line, type: [3, 4] } },
      },
      {
        // The response-count axis: scaled so the tallest bar uses 60% of the height, unlabelled
        // (the tooltip carries the count) so the plot keeps one readable scale.
        type: "value",
        min: 0,
        max: Math.ceil(peakN / BAR_HEADROOM),
        axisLabel: { show: false },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "Responses",
        type: "bar",
        yAxisIndex: 1,
        barMaxWidth: 28,
        itemStyle: { color: tokens.accentSoft, borderRadius: [2, 2, 0, 0] },
        data: series.map((p) => p.n),
      },
      {
        name: "Average overall",
        type: "line",
        yAxisIndex: 0,
        connectNulls: false,
        showSymbol: true,
        showAllSymbol: true,
        symbol: "circle",
        lineStyle: { color: tokens.accent, width: 2 },
        itemStyle: { color: tokens.accent },
        data: series.map((p, i) => (p.overallAvg === null ? null : { value: p.overallAvg, symbolSize: needsMarker(series, i) ? 8 : 0 })),
      },
    ],
  };
}
