-- 0023_system_log.sql — the operational system log (INNOBOX_SPEC.md §14.7) + the nav badge
-- marker it reads from. Idempotent.
--
--   system_events            — user-facing HTTP errors the platform returned (every 5xx; of 4xx
--                              only 403/409/413/422/429; the worker's SCIM 401/403 carve-out).
--                              Deliberately NOT the audit log: high-volume, MUTABLE operational
--                              telemetry — trimmed at 90 days by the worker and scrubbed by GDPR
--                              erasure (§3), so it carries no append-only trigger. Never holds a
--                              body, header, query string or stack trace.
--   users.system_log_seen_at — when a platform admin last opened the log; drives the 1–9+ badge
--                              on the console card (the §14.4 mechanism).
--
-- `path` stores the ROUTE TEMPLATE instead of the concrete path when the request targeted an
-- anonymous challenge/solution (§9, §14.5 rule) — decided at insert by the web wrapper.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS system_events (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       integer NOT NULL CHECK (status BETWEEN 100 AND 599),
  method       text NOT NULL,
  route        text NOT NULL,            -- matched template, e.g. /api/challenges/[number]
  path         text NOT NULL,            -- concrete path, NO query string (template when masked)
  user_id      uuid REFERENCES users(id),
  actor_name   text,                     -- point-in-time snapshot (nulled by GDPR erasure)
  actor_email  text,
  error_code   text,
  message      text NOT NULL DEFAULT '', -- one sanitized line, never a stack
  request_id   text,
  duration_ms  integer,
  source       text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'worker'))
);

-- Newest-first listing, the status chips, the per-user filter, and the retention trim.
CREATE INDEX IF NOT EXISTS system_events_created_idx ON system_events (created_at DESC);
CREATE INDEX IF NOT EXISTS system_events_status_idx  ON system_events (status, created_at DESC);
CREATE INDEX IF NOT EXISTS system_events_user_idx    ON system_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- Substring search over the human-meaningful fields. The store's ILIKE predicate uses this exact
-- expression so the planner can pick the index.
CREATE INDEX IF NOT EXISTS system_events_search_trgm_idx ON system_events
  USING gin ((coalesce(path, '') || ' ' || coalesce(error_code, '') || ' ' || coalesce(message, '')
              || ' ' || coalesce(actor_email, '') || ' ' || coalesce(actor_name, '')) gin_trgm_ops);

ALTER TABLE users ADD COLUMN IF NOT EXISTS system_log_seen_at timestamptz;

-- Least-privilege grants: INSERT (capture), SELECT (the admin page), UPDATE (the GDPR scrub
-- nulls the actor snapshot), DELETE (the 90-day trim). The app role already holds UPDATE on
-- users, so the new column needs no extra grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON system_events TO innobox_app;
GRANT USAGE, SELECT ON SEQUENCE system_events_id_seq TO innobox_app;
