// Phase 4 domain logic (INNOBOX_SPEC.md §13.2-§13.4, §14.1, §14.3): pure helpers for the
// dashboard/leaderboard vocab, platform date-format setting, and CSV export escaping. DB
// queries (KPI counts, ranking, filtered rows) stay in the caller — this module only holds
// the bits with no DB dependency.

// ── Platform date format (§14.3) ────────────────────────────────────────────────────────
export const DATE_FORMATS = ["eu", "us"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function isDateFormat(value: string): value is DateFormat {
  return (DATE_FORMATS as readonly string[]).includes(value);
}

// ── Leaderboard (§13.3) ──────────────────────────────────────────────────────────────────
export const LEADERBOARD_METRICS = [
  "solutions_implemented",
  "challenges_submitted",
  "solutions_proposed",
  "likes_received",
] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

export function isLeaderboardMetric(value: string): value is LeaderboardMetric {
  return (LEADERBOARD_METRICS as readonly string[]).includes(value);
}

export const LEADERBOARD_WINDOWS = ["30d", "all"] as const;
export type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

export function isLeaderboardWindow(value: string): value is LeaderboardWindow {
  return (LEADERBOARD_WINDOWS as readonly string[]).includes(value);
}

// ── Search (§13.4) ───────────────────────────────────────────────────────────────────────
/** Matches the length ceiling on the free-text fields it searches (title/description) —
 *  no functional need for anything longer, and it bounds the cost of a plainto_tsquery
 *  parse / ILIKE pattern on adversarial input. */
export const SEARCH_QUERY_MAX = 200;

// ── CSV export (§14.1) ───────────────────────────────────────────────────────────────────

/** Leading characters a spreadsheet application treats as the start of a formula (§14.1
 *  *CSV formula neutralization*). Tab and carriage return are included because some
 *  spreadsheets strip them and then evaluate what follows. */
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Neutralize a would-be formula by prefixing a single quote (§14.1). Applied to every cell,
 *  header included, before RFC 4180 quoting — no per-column exceptions. */
export function neutralizeCsvFormula(value: string): string {
  return CSV_FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** One CSV cell: formula-neutralized (§14.1), then RFC 4180 escaped — quoted whenever the
 *  value contains a comma, quote, or newline; embedded quotes double up. */
export function escapeCsvField(raw: string): string {
  const value = neutralizeCsvFormula(raw);
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsvRow(fields: (string | number)[]): string {
  return fields.map((f) => escapeCsvField(String(f))).join(",");
}
