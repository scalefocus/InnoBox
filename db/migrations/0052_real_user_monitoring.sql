-- 0052_real_user_monitoring.sql — real user monitoring (INNOBOX_SPEC.md §14.12).
--
--   rum_views          — one row per page view, sent by the browser collector. NO user id and no
--                        FK to anything: session_id is a random per-tab id joined to nothing, and
--                        route is the matched template, never a concrete path (§14.12 decisions 2
--                        and 3). Mutable working data: the worker deletes rows older than 7 days.
--   rum_daily          — (day, route) → views, sessions and the p75 of each measure, plus one
--                        row per day with route '*' over all views. Aggregate only, kept forever;
--                        the worker recomputes the open 7-day window every hour.
--   rum_client_errors  — browser errors deduplicated by fingerprint. Deleted 90 days after
--                        last_seen.
--   platform_settings  — rum_enabled (default false) and rum_sample_rate (default 100).
--
-- None of the three is touched by the §10.3 delete cascade or the §3 erasure: nothing in them
-- references a challenge, a solution or a person.

CREATE TABLE IF NOT EXISTS rum_views (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at    timestamptz NOT NULL DEFAULT now(),
  day            date NOT NULL,
  session_id     text NOT NULL,
  route          text NOT NULL,
  hard_load      boolean NOT NULL,
  lcp_ms         integer,
  inp_ms         integer,
  nav_ms         integer,
  ttfb_ms        integer,
  cls            numeric(6,4),
  api_ms         integer[] NOT NULL DEFAULT '{}',
  api_calls      integer NOT NULL DEFAULT 0,
  api_errors     integer NOT NULL DEFAULT 0,
  client_errors  integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rum_views_day_route_idx ON rum_views (day, route);

GRANT SELECT, INSERT, DELETE ON rum_views TO innobox_app;  -- DELETE: the worker's 7-day trim

CREATE TABLE IF NOT EXISTS rum_daily (
  day            date NOT NULL,
  route          text NOT NULL,
  views          integer NOT NULL,
  sessions       integer NOT NULL,
  p75_lcp_ms     integer,
  p75_inp_ms     integer,
  p75_cls        numeric(6,4),
  p75_ttfb_ms    integer,
  p75_nav_ms     integer,
  p75_api_ms     integer,
  api_calls      integer NOT NULL,
  api_errors     integer NOT NULL,
  client_errors  integer NOT NULL,
  PRIMARY KEY (day, route)
);

GRANT SELECT, INSERT, UPDATE ON rum_daily TO innobox_app;

CREATE TABLE IF NOT EXISTS rum_client_errors (
  fingerprint  text PRIMARY KEY,
  message      text NOT NULL,
  source       text NOT NULL,
  frame        text NOT NULL,
  route        text NOT NULL,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS rum_client_errors_last_seen_idx ON rum_client_errors (last_seen);

GRANT SELECT, INSERT, UPDATE, DELETE ON rum_client_errors TO innobox_app;  -- DELETE: the 90-day trim

-- The switch ships off; the sample rate ships at 100 %. Re-running never flips an admin's choice.
INSERT INTO platform_settings (key, value) VALUES ('rum_enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('rum_sample_rate', '100'::jsonb)
  ON CONFLICT (key) DO NOTHING;
