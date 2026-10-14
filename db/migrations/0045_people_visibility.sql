-- 0045_people_visibility.sql — challenges shared with specific people (INNOBOX_SPEC.md §4.3, §5,
-- §12.1 event 15, §24.3).
--
--   challenges.visibility gains 'people': readable by the people on the challenge's access list,
--     the namespace's admins and committee, the assignee and platform admins — nobody else in the
--     namespace. Only an admin sets it (the §24.5 Accept dialog or a later visibility change).
--   challenge_access — the access list. An entry is a user (user_id) or a PENDING e-mail (email,
--     lower-cased) that matched no user when it was added; a pending entry grants nothing until a
--     user with that address is written by SCIM, JIT sign-in or reconciliation, which binds it.
--     notified_at pins event 15 to once per entry. Rows exist only while the challenge is
--     'people' (switching away deletes them); at most 100 per challenge, enforced by the API.
--   public_submissions.requested_visibility / requested_emails / requested_teams — the outside
--     submitter's "Who should see this?" REQUEST (§24.3). The admin settles the real visibility on
--     accept; the two arrays are emptied by the §24.8 erasure along with the contact details.
--
-- The app role gets full DML on challenge_access: removing someone and switching away from
-- 'people' delete rows, and the §10.3 cascade removes a purged challenge's list (ON DELETE CASCADE).

-- ── challenges.visibility: org | namespace | people ──────────────────────────────────────────
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_visibility_check;
ALTER TABLE challenges ADD CONSTRAINT challenges_visibility_check CHECK (visibility IN ('org', 'namespace', 'people'));

-- ── challenge_access ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS challenge_access (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  email         text CHECK (email IS NULL OR (char_length(email) BETWEEN 3 AND 254 AND email = lower(email))),
  added_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  notified_at   timestamptz,
  CONSTRAINT challenge_access_entry_chk CHECK ((user_id IS NULL) <> (email IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS challenge_access_user_key ON challenge_access (challenge_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS challenge_access_email_key ON challenge_access (challenge_id, email) WHERE email IS NOT NULL;
-- The per-request "challenges shared with me" read (resolveRolesForUser) and pending-entry binding.
CREATE INDEX IF NOT EXISTS challenge_access_user_idx ON challenge_access (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS challenge_access_pending_idx ON challenge_access (email) WHERE email IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON challenge_access TO innobox_app;

-- ── public_submissions: the submitter's visibility request ───────────────────────────────────
ALTER TABLE public_submissions ADD COLUMN IF NOT EXISTS requested_visibility text NOT NULL DEFAULT 'org';
ALTER TABLE public_submissions ADD COLUMN IF NOT EXISTS requested_emails text[] NOT NULL DEFAULT '{}';
ALTER TABLE public_submissions ADD COLUMN IF NOT EXISTS requested_teams text[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_submissions_requested_visibility_chk') THEN
    ALTER TABLE public_submissions ADD CONSTRAINT public_submissions_requested_visibility_chk
      CHECK (requested_visibility IN ('org', 'people', 'teams'));
  END IF;
  -- At most 20 addresses and 10 team names. An erased row keeps its requested_visibility but has
  -- both arrays emptied, so "non-empty iff the matching option" holds only until the erasure.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'public_submissions_requested_lists_chk') THEN
    ALTER TABLE public_submissions ADD CONSTRAINT public_submissions_requested_lists_chk CHECK (
      coalesce(array_length(requested_emails, 1), 0) <= 20
      AND coalesce(array_length(requested_teams, 1), 0) <= 10
      AND (requested_visibility = 'people' OR coalesce(array_length(requested_emails, 1), 0) = 0)
      AND (requested_visibility = 'teams' OR coalesce(array_length(requested_teams, 1), 0) = 0)
    );
  END IF;
END $$;
