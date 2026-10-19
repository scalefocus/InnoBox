-- 0048_presence_rolling_counts.sql — the weekly and monthly lines on the "Currently online"
-- active-users chart (INNOBOX_SPEC.md §14.5 "Weekly / monthly history").
--
--   presence_daily.wau / .mau — the rolling 7- and 30-day distinct-user counts, SAMPLED once
--                               per closed UTC day by the worker's hourly housekeeping sweep
--                               from users.last_seen_at, with the DAU/WAU/MAU tiles' own
--                               formula. last_seen_at only moves forward, so "last seen within
--                               the trailing N days" at any instant is exactly the distinct
--                               people active in the N days ending then.
--
-- NULLABLE on purpose: NULL means "never sampled" — every day before this migration, and any
-- day the worker did not sweep during the following UTC day — and the chart draws it as a
-- break, never as zero. Write-once: a later sample would measure a later window and silently
-- move the point, so the sweep only fills a NULL.
--
-- Counts only, like the rest of presence_daily: no user ids, and no backfill is possible or
-- attempted (nothing retains who was active on a past day beyond the 3-day detail window).
-- presence_daily already grants SELECT/INSERT/UPDATE to innobox_app (0019), so no new grant.

ALTER TABLE presence_daily ADD COLUMN IF NOT EXISTS wau integer CHECK (wau >= 0);
ALTER TABLE presence_daily ADD COLUMN IF NOT EXISTS mau integer CHECK (mau >= 0);
