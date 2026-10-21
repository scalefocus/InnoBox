// Display formatting for the §14.12 monitoring page (INNOBOX_SPEC.md): milliseconds, layout
// shift, error rates and the three-step verdict dot. Pure, shared by the table and the chart.
import { apiErrorPercent, type RumMetric, type RumRouteSummary, type RumVerdict } from "@innobox/shared/rum";

/** "—" for no value; "85 ms" under a second; "2.39 s" from a second up. */
export function formatRumMs(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

/** Layout shift is unitless; three decimals is what the thresholds (0.1 / 0.25) need. */
export function formatRumCls(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

export function formatRumPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} %`;
}

/** The pill class carrying a verdict; the dot sits beside the number, never instead of it. */
export function verdictPillClass(verdict: RumVerdict): string {
  if (verdict === "good") return "pill-ok";
  return verdict === "needs-improvement" ? "pill-warn" : "pill-danger";
}

/** The verdict in words, for the cell's accessible name. */
export function verdictLabel(verdict: RumVerdict): string {
  if (verdict === "good") return "good";
  return verdict === "needs-improvement" ? "needs improvement" : "poor";
}

// ── The routes table ─────────────────────────────────────────────────────────────────────

export type RumSortKey = "name" | "views" | "sessions" | RumMetric | "apiErrors" | "clientErrors";

export const RUM_COLUMNS: { key: RumSortKey; label: string; metric?: RumMetric }[] = [
  { key: "name", label: "Route" },
  { key: "views", label: "Views" },
  { key: "sessions", label: "Sessions" },
  { key: "lcp", label: "p75 LCP", metric: "lcp" },
  { key: "inp", label: "p75 INP", metric: "inp" },
  { key: "cls", label: "p75 CLS", metric: "cls" },
  { key: "ttfb", label: "p75 TTFB", metric: "ttfb" },
  { key: "nav", label: "p75 Nav", metric: "nav" },
  { key: "api", label: "p75 API", metric: "api" },
  { key: "apiErrors", label: "API errors" },
  { key: "clientErrors", label: "Client errors" },
];

function sortValue(row: RumRouteSummary, key: RumSortKey): number | string | null {
  switch (key) {
    case "name":
      return row.name;
    case "views":
    case "sessions":
    case "clientErrors":
      return row[key];
    case "apiErrors":
      return apiErrorPercent(row.apiErrors, row.apiCalls);
    default:
      return row.p75[key];
  }
}

/** The routes table sorted by a column, as a copy. Nulls ("—") always sink to the bottom, whichever
 *  the direction. */
export function sortRoutes(rows: readonly RumRouteSummary[], key: RumSortKey, desc: boolean): RumRouteSummary[] {
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    const cmp = typeof va === "string" ? va.localeCompare(String(vb)) : va - (vb as number);
    return desc ? -cmp : cmp;
  });
}
