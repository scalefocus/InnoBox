-- 0019_presence.sql — presence tracking behind the "Currently online" admin panel
-- (INNOBOX_SPEC.md §14.5). Three additions, all idempotent.
--
--   users.last_seen_at   — last user-initiated request (throttled to one write per 60s in
--                          lib/presence-touch.ts). NULL until the user's first activity
--                          after this migration ships; there is no backfill.
--   users.last_route     — an opaque location TOKEN ("triage", "challenge:412"), never a
--                          rendered label: the display string and its anonymity masking
--                          are resolved at READ time (api/admin/presence/store.ts) so the
--                          hot write path stays a single UPDATE with no joins. Overwritten
--                          in place — InnoBox stores no per-user browsing history (§14.5).
--   user_activity_days   — the TRANSIENT per-person day set that makes "distinct users per
--                          day" computable. Purged beyond 3 days by the worker's hourly
--                          housekeeping sweep, which first rolls each closed UTC day into…
--   presence_daily       — …the aggregate daily active-user count behind the §14.5 chart.
--                          Carries NO user ids and is retained indefinitely, which is what
--                          keeps long-lived presence history non-personal.
--
-- Day buckets are UTC (invariant 8): `(now() AT TIME ZONE 'utc')::date`, never `current_date`,
-- whose value depends on the session TimeZone.

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_route   text;

-- The online list is "active since T, most recent first, capped" — a descending partial
-- index over the only rows it can ever return.
CREATE INDEX IF NOT EXISTS users_last_seen_idx
  ON users (last_seen_at DESC) WHERE last_seen_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_activity_days (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  PRIMARY KEY (user_id, day)
);
-- Both the nightly rollup (GROUP BY day) and the purge (day < cutoff) scan by day.
CREATE INDEX IF NOT EXISTS user_activity_days_day_idx ON user_activity_days (day);

CREATE TABLE IF NOT EXISTS presence_daily (
  day          date PRIMARY KEY,
  active_users integer NOT NULL CHECK (active_users >= 0)
);

-- Least-privilege grants. user_activity_days: INSERT (on activity) + DELETE (the purge),
-- never UPDATE — a row is a bare (user, day) fact with nothing to change. presence_daily:
-- UPDATE too, because the rollup re-writes a still-open day's count as it accrues.
-- users already carries table-level UPDATE (0003), so the new columns need no extra grant.
GRANT SELECT, INSERT,         DELETE ON user_activity_days TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON presence_daily     TO innobox_app;
