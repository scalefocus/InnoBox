-- 0040_gamification.sql — points, levels & badges (INNOBOX_SPEC.md §23).
--
--   gamification_ledger — one row per (user, award key): who earned how many points, for what,
--     and when the earning event happened (occurred_at, which drives the 30-day window). Rows
--     past a daily cap are still written, with 0 points, so event-counting badges see them.
--     item_id carries NO foreign key on purpose: the §10.3 delete cascade never touches the
--     ledger (a user never loses recognition), and the id is never returned by any API — it
--     exists only so the Points ranking can apply the live org-visible test (§13.3).
--   user_badges — the earned (badge, tier) rows; tier is 1/2/3 for a tiered badge and NULL for
--     a one-off. Permanent once earned.
--   users.gamification_public / notify_achievements / achievements_seen_at — the "show my level
--     and badges to others" switch, the Achievements notification preference, and the toast
--     marker (set by the worker backfill for every existing user, §23.11).
--   platform_settings gamification_enabled (default false) — the platform switch (§23.10).
--     gamification_enabled_at and gamification_backfilled_at are written by the app/worker.
--
-- Append-only: the app role gets INSERT/SELECT on both tables, plus DELETE solely for the §3
-- erasure — no UPDATE, ever.

CREATE TABLE IF NOT EXISTS gamification_ledger (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL CHECK (reason IN (
                 'challenge_submitted', 'challenge_validated', 'challenge_solved', 'assignment_solved',
                 'solution_proposed', 'solution_validated', 'solution_implemented',
                 'like_received', 'comment_posted')),
  points       smallint NOT NULL CHECK (points >= 0),
  award_key    text NOT NULL,
  item_type    text NOT NULL CHECK (item_type IN ('challenge', 'solution')),
  item_id      uuid NOT NULL,
  occurred_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS gamification_ledger_award_key_idx ON gamification_ledger (user_id, award_key);
CREATE INDEX IF NOT EXISTS gamification_ledger_user_reason_idx ON gamification_ledger (user_id, reason);
CREATE INDEX IF NOT EXISTS gamification_ledger_occurred_idx ON gamification_ledger (occurred_at);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id    uuid NOT NULL REFERENCES users(id),
  badge_key  text NOT NULL,
  tier       smallint CHECK (tier IN (1, 2, 3)),
  earned_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_badges_unique_idx ON user_badges (user_id, badge_key, (coalesce(tier, 0)));
CREATE INDEX IF NOT EXISTS user_badges_user_earned_idx ON user_badges (user_id, earned_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS gamification_public boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_achievements boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS achievements_seen_at timestamptz;

-- The switch ships off. Re-running never flips an admin's choice back.
INSERT INTO platform_settings (key, value) VALUES ('gamification_enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;

GRANT SELECT, INSERT, DELETE ON gamification_ledger TO innobox_app;  -- DELETE: §3 erasure only
GRANT SELECT, INSERT, DELETE ON user_badges         TO innobox_app;  -- DELETE: §3 erasure only
GRANT USAGE, SELECT ON SEQUENCE gamification_ledger_id_seq TO innobox_app;
