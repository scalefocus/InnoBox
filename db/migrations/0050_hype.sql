-- 0050_hype.sql — the scarce weekly endorsement (INNOBOX_SPEC.md §26, §26.10).
--
--   hypes — one row per (person, item), immutable: INSERT and SELECT for the app role, plus
--           DELETE solely for the §10.3 platform-admin delete cascade (which removes a deleted
--           item's child rows itself, as it does for likes — 0020). No UPDATE: a hype is never
--           edited, never taken back (§26 decision 3). `weight` is fixed at insert time (2 inside
--           the item's first 7 days, else 1 — §26.4) so an item's number never drifts.
--           parent_id carries no FK, like likes.parent_id, because it points at either table.
--           The week (budget, board) is computed from created_at against Monday 00:00 UTC —
--           nothing is scheduled and nothing is stored per week (§26.2).
--   gamification_ledger.reason gains hype_received (3 points, the first 10 a day) and the
--           0-point hype_fulfilled that drives the Talent Scout badge (§26.7).
--   notifications gains the coalescing index for event 16 (type `hyped`), the twin of the
--           comment_posted one in 0026 (§26.6).
--   platform_settings gains hype_enabled, default false (§26.8).

CREATE TABLE IF NOT EXISTS hypes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  parent_type  text NOT NULL CHECK (parent_type IN ('challenge','solution')),
  parent_id    uuid NOT NULL,
  weight       smallint NOT NULL CHECK (weight IN (1, 2)),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, parent_type, parent_id)
);
CREATE INDEX IF NOT EXISTS hypes_parent_idx       ON hypes (parent_type, parent_id);
CREATE INDEX IF NOT EXISTS hypes_user_created_idx ON hypes (user_id, created_at);
CREATE INDEX IF NOT EXISTS hypes_created_idx      ON hypes (created_at);

GRANT SELECT, INSERT, DELETE ON hypes TO innobox_app;  -- DELETE: the §10.3 cascade only

-- §26.7: the two new ledger reasons. Rewritten whole, as 0044 did.
ALTER TABLE gamification_ledger DROP CONSTRAINT IF EXISTS gamification_ledger_reason_check;
ALTER TABLE gamification_ledger ADD CONSTRAINT gamification_ledger_reason_check CHECK (reason IN (
  'challenge_submitted', 'challenge_validated', 'challenge_solved', 'assignment_solved',
  'solution_proposed', 'solution_validated', 'solution_implemented',
  'like_received', 'comment_posted', 'agent_connected',
  'hype_received', 'hype_fulfilled'));

-- §26.6: one unread "hyped" inbox row per recipient per item, refreshed in place (see 0026).
CREATE UNIQUE INDEX IF NOT EXISTS notifications_hyped_coalesce_idx
  ON notifications (user_id, (payload->>'parentType'), (payload->>'parentId'))
  WHERE read_at IS NULL AND type = 'hyped';
CREATE INDEX IF NOT EXISTS notifications_hyped_challenge_idx
  ON notifications (user_id, (payload->>'challengeId'))
  WHERE read_at IS NULL AND type = 'hyped';

-- §26.8: the switch ships off. Re-running never flips an admin's choice back.
INSERT INTO platform_settings (key, value) VALUES ('hype_enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;
