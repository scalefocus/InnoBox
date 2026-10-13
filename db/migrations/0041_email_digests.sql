-- 0041_email_digests.sql — e-mail digests (INNOBOX_SPEC.md §12.1, §5).
--
--   users.email_delivery — the digest choice: 'immediate' (the default, and the behaviour before
--     this migration), 'daily' or 'weekly'. Existing users get 'immediate' via the default.
--   notification_outbox.digest_due_at — set when a follower-type event's outbox row is written
--     for a recipient on a digest: the recipient's next send slot (06:00 UTC daily, or Monday
--     06:00 UTC weekly). The per-event sweep skips every held row; the digest job sends a
--     recipient's due held rows as ONE e-mail. Null = an ordinary, immediate row.
--   The partial index serves the digest job's "held and due" scan; the per-event sweep keeps
--   using notification_outbox_pending_idx (0006) and notification_outbox_retry_idx (0035).
--
-- The held row names its inbox row in payload.notificationId (no column), so the job can drop
-- an update the recipient has already read. Column-level privileges: the table-level UPDATE
-- grants on users (0003) and notification_outbox (0006) already cover the new columns.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_delivery text NOT NULL DEFAULT 'immediate';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_email_delivery_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_email_delivery_check CHECK (email_delivery IN ('immediate', 'daily', 'weekly'));
  END IF;
END $$;

ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS digest_due_at timestamptz;

CREATE INDEX IF NOT EXISTS notification_outbox_digest_idx
  ON notification_outbox (digest_due_at)
  WHERE digest_due_at IS NOT NULL AND status <> 'sent';
