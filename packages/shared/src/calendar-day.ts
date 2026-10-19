// Bare UTC calendar days (`YYYY-MM-DD`, a Postgres `date`) shown in the platform's EU/US date
// order — INNOBOX_SPEC.md §2. A `date` has no time zone, so these are rearranged as text and
// NEVER passed through `new Date()` + Intl: parsed as UTC midnight and formatted in the viewer's
// zone, every day would read one day early west of UTC. Used by the survey dates (§14.11) and
// by both admin charts (§14.5).
//
// Client-safe subpath export (`@innobox/shared/calendar-day`): pure string work, no node deps.

export type CalendarDayStyle = "eu" | "us";

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-10-05` → `05/10/2026` (EU) / `10/05/2026` (US). Anything else is returned unchanged. */
export function formatCalendarDay(day: string, style: CalendarDayStyle): string {
  const m = DAY.exec(day);
  if (!m) return day;
  const [, y, mo, d] = m;
  return style === "us" ? `${mo}/${d}/${y}` : `${d}/${mo}/${y}`;
}

/** The short day-month form for chart axis ticks: `2026-10-05` → `05/10` (EU) / `10/05` (US). */
export function formatCalendarDayShort(day: string, style: CalendarDayStyle): string {
  const m = DAY.exec(day);
  if (!m) return day;
  const [, , mo, d] = m;
  return style === "us" ? `${mo}/${d}` : `${d}/${mo}`;
}

/** The UTC calendar day of an epoch-millisecond instant — how a chart's time axis hands its
 *  tick values back to the formatters above (the axis runs in UTC). */
export function utcCalendarDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch milliseconds of a calendar day's UTC midnight — the inverse of utcCalendarDay. */
export function calendarDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}
