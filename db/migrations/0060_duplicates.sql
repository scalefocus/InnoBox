-- 0060_duplicates.sql — Mark as duplicate (INNOBOX_SPEC.md §42, §42.9).
--
--   challenges.status gains `duplicate` — a terminal status reached only through Mark as duplicate
--       (§42.2); never through the status PATCH, the dropdowns or the bulk status set.
--   challenges.duplicate_of_id — the original the duplicate points to. ON DELETE SET NULL: a hard
--       delete of the original (§10.3) leaves its duplicates closed with no link (§42.7), so the
--       check below is "only while duplicate", not "iff duplicate".
--   challenges.duplicate_note — the marker's optional note (≤ 500), shown only to viewers who can see
--       the original (§42.5). Neither column is content: writing them bumps neither updated_at nor
--       edited_at. A transition out of `duplicate` clears both.
--   public_submissions.merge_mailed_at — the §42.6 "Your submission joins an existing challenge" mail,
--       sent at most once per submission.
--   The partial index serves the original's "Also raised as" line, the re-pointing of a chain, the
--       outside-submitter outcome fan-out and the delete warning — all "who points at X?".
--
-- No new grant: the mark is UPDATEs on challenges, INSERT/DELETE on follows and INSERT on
-- challenge_affected, all already held by innobox_app.

ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_status_check;
ALTER TABLE challenges ADD CONSTRAINT challenges_status_check CHECK (status IN (
  'awaiting_triage','in_review','needs_improvement','meeting_scheduled',
  'valid','solved','rejected','withdrawn','duplicate'
));

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS duplicate_of_id uuid REFERENCES challenges(id) ON DELETE SET NULL;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS duplicate_note text;

ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_duplicate_of_only_while_duplicate;
ALTER TABLE challenges ADD CONSTRAINT challenges_duplicate_of_only_while_duplicate
  CHECK (duplicate_of_id IS NULL OR status = 'duplicate');
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_duplicate_note_only_while_duplicate;
ALTER TABLE challenges ADD CONSTRAINT challenges_duplicate_note_only_while_duplicate
  CHECK (duplicate_note IS NULL OR (status = 'duplicate' AND char_length(duplicate_note) BETWEEN 1 AND 500));
ALTER TABLE challenges DROP CONSTRAINT IF EXISTS challenges_duplicate_of_not_self;
ALTER TABLE challenges ADD CONSTRAINT challenges_duplicate_of_not_self
  CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id);

CREATE INDEX IF NOT EXISTS challenges_duplicate_of_idx ON challenges (duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;

ALTER TABLE public_submissions ADD COLUMN IF NOT EXISTS merge_mailed_at timestamptz;
