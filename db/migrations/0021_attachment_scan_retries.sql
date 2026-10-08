-- 0021_attachment_scan_retries.sql — §11 scan retries (INNOBOX_SPEC.md §5, §11).
-- A file clamd keeps failing ON (clamd answered with an error for that stream, or the object
-- could not be read) is retried with exponential backoff and, after a bounded number of
-- attempts, moves to the terminal `unscannable` state — treated exactly like `infected` for
-- serving (never downloadable, object purged, row kept as a tombstone). An outage (clamd
-- unreachable) never counts as an attempt. So:
--   * scan_status gains 'unscannable';
--   * scan_attempts counts per-file failures (default 0);
--   * next_scan_at is the earliest time the sweep may retry (null = due now);
--   * the sweep's (scan_status) index becomes (scan_status, next_scan_at), matching its
--     `scan_status = 'pending' and (next_scan_at is null or next_scan_at <= now())` filter.
-- Grants are unchanged (0012: INSERT/SELECT/UPDATE, no DELETE). Idempotent.

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS scan_attempts int NOT NULL DEFAULT 0;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS next_scan_at timestamptz;

-- Re-create the status CHECK with the new terminal state. 0012 declared it inline, so it
-- carries Postgres's default name; drop-then-add is safe to re-run.
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_scan_status_check;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_scan_status_check
  CHECK (scan_status IN ('pending','clean','infected','unscannable'));

DROP INDEX IF EXISTS attachments_scan_status_idx;
CREATE INDEX IF NOT EXISTS attachments_scan_status_next_idx ON attachments (scan_status, next_scan_at);
