-- 0035_outbox_retry_backoff.sql — e-mail retry with backoff (INNOBOX_SPEC.md §12.1:
-- "at-least-once, retry with backoff").
--
-- The worker's notification sweep runs every 30 s. Before this migration a failed outbox row was
-- retried on every sweep, so a transport outage or a Graph 429 burned all retry attempts within
-- about two minutes. Now each failure pushes the row's next_attempt_at out exponentially
-- (1, 2, 4, 8 … minutes, capped at 60), and the sweep only picks up a failed row once it is due.
--   * next_attempt_at null = due now (pending rows, and failed rows written before this column).
--   * The partial index serves the sweep's `status = 'failed' and next_attempt_at <= now()` arm;
--     pending rows keep using notification_outbox_pending_idx (0006).
-- Column-level privileges: the table-level UPDATE grant from 0006 already covers the new column.

ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;

CREATE INDEX IF NOT EXISTS notification_outbox_retry_idx
  ON notification_outbox (next_attempt_at)
  WHERE status = 'failed';
