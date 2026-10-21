// The real-user-monitoring chart as a pure ECharts option (INNOBOX_SPEC.md §14.12): page views as
// bars on the left axis and p75 LCP and p75 INP as lines on a right-hand milliseconds axis, per UTC
// day. No data-zoom — the page's range buttons choose the window. Pure: data + resolved tokens in,
// option out; the shared wrapper (components/EChart.tsx) owns the DOM, the theme and `useUTC`.
import type { ComposeOption } from "echarts/core";
import type { BarSeriesOption, LineSeriesOption } from "echarts/charts";
import type { AriaComponentOption, GridComponentOption, LegendComponentOption, TooltipComponentOption } from "echarts/components";
import { calendarDayMs, formatCalendarDay, formatCalendarDayShort, utcCalendarDay } from "@innobox/shared/calendar-day";
import type { RumSeriesPoint } from "@innobox/shared/rum";
import { formatRumMs } from "../rum-format";
import { escapeHtml, type ChartEnv } from "./chart-env";
import { isolatedPoints } from "./presence-chart";

export type RumChartOption = ComposeOption<
  BarSeriesOption | LineSeriesOption | GridComponentOption | LegendComponentOption | TooltipComponentOption | AriaComponentOption
>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The three series. The lines differ by dash as well as colour, so neither relies on colour. */
export const RUM_SERIES = [
  { key: "views", name: "Page views", kind: "bar" },
  { key: "p75Lcp", name: "p75 LCP", kind: "line", color: "accent", dash: "solid" },
  { key: "p75Inp", name: "p75 INP", kind: "line", color: "anchor", dash: "dashed" },
] as const;

interface AxisTooltipItem {
  seriesName?: string;
  marker?: unknown;
  axisValue?: unknown;
  value?: unknown;
}

export function rumTooltip(items: readonly AxisTooltipItem[], style: "eu" | "us"): string {
  const first = items[0];
  if (!first) return "";
  const day = utcCalendarDay(Number(first.axisValue));
  const rows = items.map((item) => {
    const value = Array.isArray(item.value) ? item.value[1] : null;
    const shown = typeof value !== "number" ? "—" : item.seriesName === "Page views" ? String(value) : formatRumMs(value);
    const marker = typeof item.marker === "string" ? item.marker : "";
    return `${marker}${escapeHtml(String(item.seriesName ?? ""))} <strong>${escapeHtml(shown)}</strong>`;
  });
  return [`<strong>${escapeHtml(formatCalendarDay(day, style))} (UTC)</strong>`, ...rows].join("<br>");
}

/** The screen-reader summary: what the chart shows, its span and where it ends. */
export function rumAriaDescription(points: readonly RumSeriesPoint[], style: "eu" | "us"): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return "Page views and p75 LCP and INP per UTC day. No days recorded yet.";
  const views = points.reduce((n, p) => n + p.views, 0);
  return (
    `Page views as bars and p75 LCP and p75 INP as lines per UTC day, ${points.length} days from ` +
    `${formatCalendarDay(first.day, style)} to ${formatCalendarDay(last.day, style)}, ${views} views in all. ` +
    `Latest day: ${last.views} views, p75 LCP ${formatRumMs(last.p75Lcp)}, p75 INP ${formatRumMs(last.p75Inp)}.`
  );
}

export function buildRumOption({ points, style, env }: { points: readonly RumSeriesPoint[]; style: "eu" | "us"; env: ChartEnv }): RumChartOption {
  const { tokens } = env;
  const dayLabel = (ms: number) => formatCalendarDayShort(utcCalendarDay(ms), style);
  const first = points[0];
  const last = points.at(-1);
  const axisLabel = { color: tokens.faint, fontSize: 11 };

  return {
    aria: { label: { description: rumAriaDescription(points, style) } },
    grid: { left: 8, right: 8, top: 40, bottom: 8, containLabel: true },
    legend: { top: 0, left: 0, itemWidth: 22, textStyle: { color: tokens.muted, fontSize: 12 }, data: RUM_SERIES.map((s) => s.name) },
    tooltip: {
      trigger: "axis",
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
      textStyle: { color: tokens.ink, fontSize: 12.5 },
      axisPointer: { type: "shadow", shadowStyle: { color: tokens.accentSoft, opacity: 0.35 } },
      formatter: (params) => rumTooltip((Array.isArray(params) ? params : [params]) as AxisTooltipItem[], style),
    },
    xAxis: {
      type: "time",
      // Half a day of margin on each side, so the first and last bars are not cut in half.
      min: first ? calendarDayMs(first.day) - DAY_MS / 2 : undefined,
      max: last ? calendarDayMs(last.day) + DAY_MS / 2 : undefined,
      minInterval: DAY_MS,
      axisLine: { lineStyle: { color: tokens.line } },
      axisTick: { show: false },
      axisLabel: { ...axisLabel, hideOverlap: true, formatter: (value: number) => dayLabel(value) },
      splitLine: { show: false },
    },
    yAxis: [
      { type: "value", name: "views", minInterval: 1, nameTextStyle: axisLabel, axisLabel, splitLine: { lineStyle: { color: tokens.line, type: [3, 4] } } },
      {
        type: "value",
        name: "ms",
        position: "right",
        nameTextStyle: axisLabel,
        axisLabel: { ...axisLabel, formatter: (value: number) => (value >= 1000 ? `${value / 1000} s` : `${value} ms`) },
        splitLine: { show: false },
      },
    ],
    series: RUM_SERIES.map((s) => {
      if (s.kind === "bar") {
        return {
          name: s.name,
          type: "bar" as const,
          yAxisIndex: 0,
          barMaxWidth: 14,
          itemStyle: { color: tokens.line, borderRadius: [2, 2, 0, 0] },
          emphasis: { itemStyle: { color: tokens.faint } },
          data: points.map((p) => [calendarDayMs(p.day), p.views]),
        };
      }
      const values = points.map((p) => p[s.key]);
      const lone = isolatedPoints(values);
      return {
        name: s.name,
        type: "line" as const,
        yAxisIndex: 1,
        // A day with no measure is a break in the line, never a zero and never bridged.
        connectNulls: false,
        showSymbol: lone.size > 0,
        symbol: "circle",
        symbolSize: lone.size > 0 ? (_: unknown, params: { dataIndex: number }) => (lone.has(params.dataIndex) ? 6 : 0) : 6,
        smooth: false,
        lineStyle: { color: tokens[s.color], width: 2, type: s.dash },
        itemStyle: { color: tokens[s.color] },
        emphasis: { focus: "series" as const },
        data: points.map((p, i) => [calendarDayMs(p.day), values[i] ?? null]),
      };
    }),
  };
}
