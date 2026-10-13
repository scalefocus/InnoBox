-- 0042_public_submissions.sql — challenges from outside the organization (INNOBOX_SPEC.md §24, §5).
--
--   public_submissions — the §24 intake queue. A row is NOT a challenge: no number, namespace or
--     visibility, and it is read by nothing but the platform-admin review queue (§24.5). Status
--     unconfirmed → pending_review (the submitter clicked the e-mailed link) → accepted | declined.
--     A discarded row is deleted outright. Only the SHA-256 of the confirmation token is stored,
--     and cleared once used. `pow_salt` is unique, so a solved proof-of-work challenge buys exactly
--     one row (§24.4). `submitter_name` / `submitter_email` are nulled by the §24.8 erasure, which
--     stamps `contact_erased_at`; `contact_erase_due_at` is set when the accepted challenge first
--     reaches solved or rejected (and doubles as the "outcome mail sent" flag, §24.7).
--   challenges.public_submission_id — set only on a challenge accepted from the queue. Such a
--     challenge has a NULL author_id: exactly one of the two is non-null (checked below), so every
--     other challenge keeps a real author.
--   notification_outbox.recipient_email — an outbox row may address an outside submitter by
--     e-mail instead of a user (§24.7): exactly one of user_id and recipient_email is set.
--   platform_settings public_submissions_enabled (default false) and public_privacy_notice
--     (default empty) — the §24.2 switch and the notice shown on the form.
--
-- The app role gets full DML on the intake table: discarding deletes a row, and the §10.3 delete
-- cascade takes an accepted challenge's row with it.

CREATE TABLE IF NOT EXISTS public_submissions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status                text NOT NULL DEFAULT 'unconfirmed'
                          CHECK (status IN ('unconfirmed', 'pending_review', 'accepted', 'declined')),
  title                 text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description           text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 10000),
  submitter_name        text CHECK (char_length(submitter_name) <= 120),
  submitter_email       text CHECK (char_length(submitter_email) <= 254),
  company               text CHECK (char_length(company) <= 200),
  confirm_token_hash    text UNIQUE,
  confirm_expires_at    timestamptz NOT NULL,
  pow_salt              text NOT NULL UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  confirmed_at          timestamptz,
  decided_at            timestamptz,
  decided_by            uuid REFERENCES users(id),
  decline_note          text CHECK (char_length(decline_note) <= 1000),
  contact_erase_due_at  timestamptz,
  contact_erased_at     timestamptz,
  -- Name and e-mail are erased together, and only by the erasure that stamps contact_erased_at.
  CONSTRAINT public_submissions_contact_chk CHECK (
    (contact_erased_at IS NULL AND submitter_name IS NOT NULL AND submitter_email IS NOT NULL)
    OR (contact_erased_at IS NOT NULL AND submitter_name IS NULL AND submitter_email IS NULL)
  ),
  CONSTRAINT public_submissions_decided_chk CHECK ((status IN ('accepted', 'declined')) = (decided_at IS NOT NULL))
);

-- The review queue (pending oldest first, decided newest first) and the console count.
CREATE INDEX IF NOT EXISTS public_submissions_status_idx ON public_submissions (status, confirmed_at);
-- §24.4 per-address cap (3 per address per 24 h, compared lower-cased) and the platform ceiling
-- (100 confirmation e-mails per hour).
CREATE INDEX IF NOT EXISTS public_submissions_email_idx ON public_submissions (lower(submitter_email), created_at);
CREATE INDEX IF NOT EXISTS public_submissions_created_idx ON public_submissions (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON public_submissions TO innobox_app;

-- ── challenges: an accepted outside submission has no author ─────────────────────────────────
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS public_submission_id uuid REFERENCES public_submissions(id);
ALTER TABLE challenges ALTER COLUMN author_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'challenges_public_submission_key') THEN
    ALTER TABLE challenges ADD CONSTRAINT challenges_public_submission_key UNIQUE (public_submission_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'challenges_author_or_public_chk') THEN
    ALTER TABLE challenges ADD CONSTRAINT challenges_author_or_public_chk
      CHECK ((author_id IS NULL) <> (public_submission_id IS NULL));
  END IF;
END $$;

-- ── notification_outbox: e-mails to an outside submitter ─────────────────────────────────────
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS recipient_email text;
ALTER TABLE notification_outbox ALTER COLUMN user_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_outbox_recipient_chk') THEN
    ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_recipient_chk
      CHECK ((user_id IS NULL) <> (recipient_email IS NULL));
  END IF;
END $$;

-- ── §24.2 settings: off, with no notice (each deployment writes its own) ─────────────────────
INSERT INTO platform_settings (key, value) VALUES ('public_submissions_enabled', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('public_privacy_notice', '""'::jsonb) ON CONFLICT (key) DO NOTHING;
