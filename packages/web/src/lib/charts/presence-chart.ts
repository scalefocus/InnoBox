// The "Currently online" active-users chart as a pure ECharts option (INNOBOX_SPEC.md §14.5):
// daily, weekly and monthly lines over UTC days, a UTC time axis labelled in the platform's
// EU/US order, an axis tooltip, and a zoom window driven by the 7d / 30d / 90d / All presets,
// the slider, drag-to-pan and Ctrl+wheel. Pure: data + resolved tokens in, option out — the
// wrapper (components/EChart.tsx) owns the DOM, the theme and the UTC switch.
import type { ComposeOption } from "echarts/core";
import type { LineSeriesOption } from "echarts/charts";
import type {
  AriaComponentOption,
  DataZoomComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import { calendarDayMs, formatCalendarDay, formatCalendarDayShort, utcCalendarDay } from "@innobox/shared/calendar-day";
import { rangeDays, type PresenceRange } from "../presence";
import { escapeHtml, type ChartEnv } from "./chart-env";

export type PresenceChartOption = ComposeOption<
  | LineSeriesOption
  | GridComponentOption
  | LegendComponentOption
  | TooltipComponentOption
  | DataZoomComponentOption
  | AriaComponentOption
>;

export interface PresenceChartPoint {
  day: string;
  activeUsers: number;
  wau: number | null;
  mau: number | null;
}

/** The visible span of the time axis, in epoch milliseconds (UTC midnights). */
export interface ZoomWindow {
  startMs: number;
  endMs: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The three lines: a dash pattern as well as a colour, so no line relies on colour alone. */
export const PRESENCE_SERIES = [
  { key: "activeUsers", name: "Daily active", tip: "Daily active", color: "accent", dash: "solid" },
  { key: "wau", name: "Weekly active (rolling 7 days)", tip: "Weekly active", color: "anchor", dash: "dashed" },
  { key: "mau", name: "Monthly active (rolling 30 days)", tip: "Monthly active", color: "muted", dash: "dotted" },
] as const;

/** Indexes of values with a break on both sides. A line draws nothing for a lone point, so
 *  these get a visible dot — a recorded sample must never vanish into its gaps. */
export function isolatedPoints(values: readonly (number | null)[]): Set<number> {
  const out = new Set<number>();
  values.forEach((v, i) => {
    if (v !== null && (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null) out.add(i);
  });
  return out;
}

/** The first and last day of the series, or null when there is nothing to draw. */
export function seriesExtent(points: readonly PresenceChartPoint[]): ZoomWindow | null {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  return { startMs: calendarDayMs(first.day), endMs: calendarDayMs(last.day) };
}

/** A preset's window: the trailing 7 / 30 / 90 days, or the whole series. A series shorter than
 *  the preset is shown whole — the buttons never change shape under the admin (§14.5). */
export function presetWindow(points: readonly PresenceChartPoint[], preset: PresenceRange): ZoomWindow | null {
  const extent = seriesExtent(points);
  if (!extent) return null;
  const days = rangeDays(preset);
  if (days === null) return extent;
  return { startMs: Math.max(extent.startMs, extent.endMs - days * DAY_MS), endMs: extent.endMs };
}

interface DataZoomRange {
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
}

/**
 * The window after a user zoom, from an ECharts `datazoom` event. The slider reports
 * `{ start, end }` directly, the inside (drag / wheel) zoom as `{ batch: [{ start, end }] }`;
 * either may carry percentages of the axis extent or explicit values.
 */
export function zoomWindowFromEvent(params: unknown, extent: ZoomWindow): ZoomWindow | null {
  if (!params || typeof params !== "object") return null;
  const batch = (params as { batch?: unknown }).batch;
  const range = (Array.isArray(batch) ? batch[0] : params) as DataZoomRange | undefined;
  if (!range) return null;
  const span = extent.endMs - extent.startMs;
  const at = (value: number | undefined, pct: number | undefined, fallback: number) =>
    typeof value === "number" ? value : typeof pct === "number" ? extent.startMs + (pct / 100) * span : fallback;
  const startMs = at(range.startValue, range.start, extent.startMs);
  const endMs = at(range.endValue, range.end, extent.endMs);
  return { startMs: Math.min(startMs, endMs), endMs: Math.max(startMs, endMs) };
}

/** What a user zoom does to the panel's zoom state: the window follows the event, and the
 *  pressed preset is released — no button is pressed until one is clicked again (§14.5). */
export function applyManualZoom(
  params: unknown,
  extent: ZoomWindow,
  current: ZoomWindow | null,
): { window: ZoomWindow | null; pressed: null } {
  return { window: zoomWindowFromEvent(params, extent) ?? current, pressed: null };
}

interface AxisTooltipItem {
  seriesName?: string;
  marker?: unknown;
  axisValue?: unknown;
  value?: unknown;
}

/** The axis tooltip: the UTC day in the platform's order, then one line per visible series. */
export function presenceTooltip(items: readonly AxisTooltipItem[], style: "eu" | "us"): string {
  const first = items[0];
  if (!first) return "";
  const day = utcCalendarDay(Number(first.axisValue));
  const rows = items.map((item) => {
    const series = PRESENCE_SERIES.find((s) => s.name === item.seriesName);
    const value = Array.isArray(item.value) ? item.value[1] : null;
    const shown = typeof value === "number" ? String(value) : "—";
    // `marker` is ECharts' own coloured-dot HTML; everything we interpolate is escaped.
    const marker = typeof item.marker === "string" ? item.marker : "";
    return `${marker}${escapeHtml(series?.tip ?? String(item.seriesName ?? ""))} <strong>${escapeHtml(shown)}</strong>`;
  });
  return [`<strong>${escapeHtml(formatCalendarDay(day, style))} (UTC)</strong>`, ...rows].join("<br>");
}

/** The screen-reader summary. ECharts' generated description would read the raw axis values
 *  aloud — epoch milliseconds — so the chart says what it shows, its span and where it ends. */
export function presenceAriaDescription(points: readonly PresenceChartPoint[], style: "eu" | "us"): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return "Daily, weekly and monthly active users per UTC day. No days recorded yet.";
  const count = (n: number | null) => (n === null ? "no" : String(n));
  return (
    `Daily, weekly and monthly active users per UTC day, ${points.length} days from ` +
    `${formatCalendarDay(first.day, style)} to ${formatCalendarDay(last.day, style)}. ` +
    `Latest day: ${last.activeUsers} daily, ${count(last.wau)} weekly and ${count(last.mau)} monthly active users.`
  );
}

export interface PresenceChartInput {
  points: readonly PresenceChartPoint[];
  /** The zoom window to show; null shows the whole series. */
  window: ZoomWindow | null;
  style: "eu" | "us";
  env: ChartEnv;
}

/** How many lines the legend wraps onto at a host width (measured with the brand font: the
 *  three entries need ~720px on one line, and the first two ~360px). */
export function legendRows(width: number): number {
  if (width <= 0) return 2; // not measured yet — the common case on a desktop card
  if (width >= 720) return 1;
  return width >= 360 ? 2 : 3;
}

export function buildPresenceOption({ points, window, style, env }: PresenceChartInput): PresenceChartOption {
  const { tokens, coarsePointer } = env;
  const extent = seriesExtent(points);
  const shown = window ?? extent;
  const dayLabel = (ms: number) => formatCalendarDayShort(utcCalendarDay(ms), style);
  const zoomRange = shown ? { startValue: shown.startMs, endValue: shown.endMs } : {};

  return {
    aria: { label: { description: presenceAriaDescription(points, style) } },
    // right: room for the "UTC" axis name, which containLabel does not reserve. top: room for
    // the legend, which wraps on a narrow card and which ECharts does not lay out around.
    grid: { left: 8, right: 40, top: 16 + legendRows(env.width) * 20, bottom: 56, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      itemWidth: 22,
      textStyle: { color: tokens.muted, fontSize: 12 },
      data: PRESENCE_SERIES.map((s) => s.name),
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: tokens.surface,
      borderColor: tokens.line,
      textStyle: { color: tokens.ink, fontSize: 12.5 },
      axisPointer: { type: "line", lineStyle: { color: tokens.faint } },
      formatter: (params) => presenceTooltip((Array.isArray(params) ? params : [params]) as AxisTooltipItem[], style),
    },
    xAxis: {
      type: "time",
      min: extent?.startMs,
      max: extent?.endMs,
      // Never a sub-day tick: each point IS a day, and a noon tick would repeat its label.
      minInterval: DAY_MS,
      name: "UTC",
      nameLocation: "end",
      nameTextStyle: { color: tokens.faint, fontSize: 11 },
      axisLine: { lineStyle: { color: tokens.line } },
      axisTick: { show: false },
      axisLabel: { color: tokens.faint, fontSize: 11, hideOverlap: true, formatter: (value: number) => dayLabel(value) },
      splitLine: { show: false },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: tokens.faint, fontSize: 11 },
      splitLine: { lineStyle: { color: tokens.line, type: [3, 4] } },
    },
    dataZoom: [
      {
        type: "inside",
        // On touch, a drag over the plot must scroll the page; the slider is the control there.
        disabled: coarsePointer,
        // A bare wheel scrolls the page, never the chart.
        zoomOnMouseWheel: "ctrl",
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        minValueSpan: 2 * DAY_MS,
        // Keep out-of-window points: the default filter drops them, so a line would stop short
        // of the window's edge (and a sample just inside it would have nothing to join). Also
        // keeps the y-scale steady while panning.
        filterMode: "none",
        ...zoomRange,
      },
      {
        type: "slider",
        filterMode: "none",
        height: 22,
        bottom: 6,
        minValueSpan: 2 * DAY_MS,
        brushSelect: false,
        borderColor: tokens.line,
        backgroundColor: "transparent",
        fillerColor: tokens.accentSoft,
        handleStyle: { color: tokens.surface, borderColor: tokens.accent },
        moveHandleStyle: { color: tokens.line },
        dataBackground: { lineStyle: { color: tokens.faint }, areaStyle: { color: tokens.line } },
        selectedDataBackground: { lineStyle: { color: tokens.accent }, areaStyle: { color: tokens.accentSoft } },
        textStyle: { color: tokens.faint, fontSize: 11 },
        labelFormatter: (value: number) => dayLabel(value),
        ...zoomRange,
      },
    ],
    series: PRESENCE_SERIES.map((s) => {
      const values = points.map((p) => p[s.key]);
      const lone = isolatedPoints(values);
      return {
        name: s.name,
        type: "line",
        // A missing weekly/monthly sample is null → a break in the line, never 0, never bridged.
        connectNulls: false,
        // Symbols stay hover-only, unless the series has a lone sample: then that one is drawn
        // as a dot (and the rest sized 0, so the line still reads as a line).
        showSymbol: lone.size > 0,
        symbol: "circle",
        symbolSize: lone.size > 0 ? (_: unknown, params: { dataIndex: number }) => (lone.has(params.dataIndex) ? 6 : 0) : 6,
        lineStyle: { color: tokens[s.color], width: 2, type: s.dash },
        itemStyle: { color: tokens[s.color] },
        emphasis: { focus: "series" },
        data: points.map((p, i) => [calendarDayMs(p.day), values[i] ?? null]),
      };
    }),
  };
}
