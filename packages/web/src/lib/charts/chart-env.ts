// What the shared chart wrapper (components/EChart.tsx) hands each chart's option builder —
// INNOBOX_SPEC.md §14.5 "The chart wrapper (shared)".
//
// ECharts derives hover and emphasis shades from a colour VALUE, so it cannot take
// `var(--accent)`: the wrapper resolves the §2.2 tokens with getComputedStyle and passes the
// results here, re-resolving whenever the theme flips. The builders themselves are pure
// functions of this environment plus their data, which is what lets them be unit-tested
// without a DOM.

export interface ChartTokens {
  accent: string;
  accentSoft: string;
  anchor: string;
  muted: string;
  faint: string;
  line: string;
  ink: string;
  surface: string;
  fontBody: string;
}

export interface ChartEnv {
  tokens: ChartTokens;
  /** A touch-first device: drag on the plot must scroll the page, not pan the chart. */
  coarsePointer: boolean;
  /** The chart host's width in px, coarsened to 40px steps — for layout that ECharts does not
   *  do itself, such as making room for a legend that wraps on a narrow card. */
  width: number;
}

/** The CSS custom properties each token is read from. */
export const CHART_TOKEN_VARS: Record<keyof ChartTokens, string> = {
  accent: "--accent",
  accentSoft: "--accent-soft",
  anchor: "--anchor",
  muted: "--muted",
  faint: "--faint",
  line: "--line",
  ink: "--ink",
  surface: "--surface",
  fontBody: "--font-body",
};

/** ECharts renders tooltip content as HTML. Nothing user-supplied reaches a tooltip (numbers and
 *  formatted dates only), but every interpolated value is escaped regardless. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
