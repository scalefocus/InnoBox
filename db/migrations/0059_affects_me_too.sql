-- 0059_affects_me_too.sql — "This affects me too" (INNOBOX_SPEC.md §41, §41.9).
--
--   challenges.affected_estimate — the authors' answer to "How many people does this affect, you
--       included?" on the submit form (§41.2): a whole number 1–1,000, or null when left empty (the
--       authors then count as 1). Content: written on create and by an author edit only (§10.1).
--   challenge_affected — one row per (challenge, person), ever: a colleague's mark that the challenge
--       affects them, with their headcount (1–1,000, themselves included). Taking a mark back sets
--       removed_at instead of deleting the row, and marking again clears it — the row's existence is
--       what keeps the first-mark effects (the auto-follow and §12.1 event 24) to once per person per
--       challenge (§41.3, §41.6). The app role updates only the headcount and the two timestamps;
--       DELETE serves the §10.3 cascade alone (which deletes the rows itself so its audit row can
--       count them; ON DELETE CASCADE is the backstop). Erasure keeps the rows (§41.7).
--   notifications gains the coalescing index for event 24 (type `affected`), the twin of the
--       comment_posted (0026) and hyped (0050) ones (§41.6).

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS affected_estimate smallint;
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_affected_estimate_range;
ALTER TABLE challenges ADD CONSTRAINT challenges_affected_estimate_range
  CHECK (affected_estimate IS NULL OR affected_estimate BETWEEN 1 AND 1000);

CREATE TABLE IF NOT EXISTS challenge_affected (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  headcount     smallint NOT NULL CHECK (headcount BETWEEN 1 AND 1000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  CONSTRAINT challenge_affected_once UNIQUE (challenge_id, user_id)
);
-- The counts (reach, people) read the current marks of a challenge.
CREATE INDEX IF NOT EXISTS challenge_affected_current_idx ON challenge_affected (challenge_id) WHERE removed_at IS NULL;

GRANT SELECT, INSERT, DELETE ON challenge_affected TO innobox_app;  -- DELETE: the §10.3 cascade only
GRANT UPDATE (headcount, updated_at, removed_at) ON challenge_affected TO innobox_app;

-- §41.6: one unread "affected" inbox row per recipient per challenge, refreshed in place (see 0026).
CREATE UNIQUE INDEX IF NOT EXISTS notifications_affected_coalesce_idx
  ON notifications (user_id, (payload->>'parentType'), (payload->>'parentId'))
  WHERE read_at IS NULL AND type = 'affected';
