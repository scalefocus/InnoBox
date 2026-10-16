// Unit tests for the bare-calendar-day formatters (INNOBOX_SPEC.md §2, §14.5, §14.11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarDayMs, formatCalendarDay, formatCalendarDayShort, utcCalendarDay } from "./calendar-day.js";

test("calendar days are shown verbatim in the platform's date order, never shifted by a time zone", () => {
  assert.equal(formatCalendarDay("2026-10-05", "eu"), "05/10/2026");
  assert.equal(formatCalendarDay("2026-10-05", "us"), "10/05/2026");
  assert.equal(formatCalendarDay("garbage", "eu"), "garbage");
});

test("the short form drops the year and keeps the platform's day/month order", () => {
  assert.equal(formatCalendarDayShort("2026-07-13", "eu"), "13/07");
  assert.equal(formatCalendarDayShort("2026-07-13", "us"), "07/13");
  assert.equal(formatCalendarDayShort("not-a-day", "us"), "not-a-day");
});

test("a UTC-midnight instant maps back to its own day, whatever the process time zone", () => {
  // The bug this module exists to prevent: 2026-07-13T00:00Z is the 12th in any zone west of
  // UTC, so a Date-based local formatter would label the point a day early.
  const ms = calendarDayMs("2026-07-13");
  assert.equal(ms, Date.UTC(2026, 6, 13));
  assert.equal(utcCalendarDay(ms), "2026-07-13");
  // Any instant within the UTC day belongs to it.
  assert.equal(utcCalendarDay(ms + 23 * 3600 * 1000 + 59 * 60 * 1000), "2026-07-13");
  assert.equal(utcCalendarDay(ms - 1), "2026-07-12");
});
