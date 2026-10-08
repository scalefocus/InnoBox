-- 0015_triage_attention.sql — triage attention badge (INNOBOX_SPEC.md §14.4) + the timestamp
-- it reads from. Two additions, both idempotent:
--
--   users.triage_seen_at        — last time the user opened the triage queue. NULL until the
--                                 first visit (so the badge counts everything currently
--                                 actionable on a first-ever view). Stamped by
--                                 POST /api/admin/triage/seen.
--   {challenges,solutions}.status_changed_at — when the row last entered its current status.
--                                 Defaults to created_at at genesis, bumped on every transition
--                                 (see api/challenges/store.ts). The badge counts actionable
--                                 items whose status_changed_at is newer than the viewer's
--                                 triage_seen_at, so an item that RE-enters an actionable state
--                                 (e.g. an admin override back to awaiting_triage) re-surfaces.
--
-- The app role already holds table-level UPDATE on users/challenges/solutions (email prefs,
-- edits, transitions), so the new columns need no additional grants.

ALTER TABLE users ADD COLUMN IF NOT EXISTS triage_seen_at timestamptz;

-- challenges.status_changed_at: add nullable, backfill existing rows to created_at, then pin
-- the default + NOT NULL so new inserts and future transitions always carry a value.
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
UPDATE challenges SET status_changed_at = created_at WHERE status_changed_at IS NULL;
ALTER TABLE challenges ALTER COLUMN status_changed_at SET DEFAULT now();
ALTER TABLE challenges ALTER COLUMN status_changed_at SET NOT NULL;

ALTER TABLE solutions ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
UPDATE solutions SET status_changed_at = created_at WHERE status_changed_at IS NULL;
ALTER TABLE solutions ALTER COLUMN status_changed_at SET DEFAULT now();
ALTER TABLE solutions ALTER COLUMN status_changed_at SET NOT NULL;

-- Partial indexes for the attention count (§14.4) — only the actionable rows are ever scanned.
CREATE INDEX IF NOT EXISTS challenges_awaiting_triage_idx
  ON challenges (namespace_id, status_changed_at) WHERE status = 'awaiting_triage';
CREATE INDEX IF NOT EXISTS solutions_proposed_idx
  ON solutions (challenge_id, status_changed_at) WHERE status = 'proposed';
