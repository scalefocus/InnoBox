-- 0037_feedback_survey.sql — the anonymous feedback survey (INNOBOX_SPEC.md §13.10) and its
-- platform-admin results (§14.11). All idempotent.
--
--   users.surveys_enabled      — the random-prompt opt-out (profile switch). Default on.
--   users.survey_last_shown_at — when the last RANDOM survey was shown; the 30-day floor and the
--                                90-day fallback run from it. Kept when the offer ends.
--   users.survey_offer         — the open offer, or NULL: { surveyVersion, trigger, feature,
--                                rotating, closed }. Cleared on submit, opt-out (random only),
--                                switch-off, expiry, or a SURVEY_VERSION change.
--   users.survey_self_shown_at — the on-demand cooldown, stamped when a self offer OPENS (never
--                                on submit, so it says nothing about whether the user answered).
--   user_feature_uses          — first use per (user, feature). A fresh insert is a first use.
--   survey_responses           — the answers' envelope, with NO user column and NO timestamp:
--                                only the UTC date. `id` is random (gen_random_uuid), so ordering
--                                by it reveals nothing. Immutable; the only delete is the §14.11
--                                admin delete.
--   survey_answers             — one row per ANSWERED question (never a 0).
--   survey_daily               — the funnel, aggregate only: no user and no feature dimension, so
--                                it can never be joined back to a person.
--
-- `answered_on` and `survey_daily.day` are `date`, a deliberate carve-out from invariant 10
-- (precedent: presence_daily, 0019): a time of day would defeat the anonymity. UTC calendar days.

ALTER TABLE users ADD COLUMN IF NOT EXISTS surveys_enabled      boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS survey_last_shown_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS survey_offer         jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS survey_self_shown_at timestamptz;

CREATE TABLE IF NOT EXISTS user_feature_uses (
  user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature       text        NOT NULL,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature)
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  answered_on    date NOT NULL,
  survey_version integer NOT NULL,
  trigger        text NOT NULL CHECK (trigger IN ('feature', 'visit', 'self')),
  feature        text,
  segment        text NOT NULL CHECK (segment IN ('admin', 'committee', 'member')),
  via            text NOT NULL CHECK (via IN ('popup', 'menu')),
  free_text      text CHECK (free_text IS NULL OR char_length(free_text) <= 2000)
);
CREATE INDEX IF NOT EXISTS survey_responses_answered_on_idx ON survey_responses (answered_on);

CREATE TABLE IF NOT EXISTS survey_answers (
  response_id  uuid     NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
  question_key text     NOT NULL,
  stars        smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  PRIMARY KEY (response_id, question_key)
);

CREATE TABLE IF NOT EXISTS survey_daily (
  day                 date PRIMARY KEY,
  shown               integer NOT NULL DEFAULT 0,
  closed              integer NOT NULL DEFAULT 0,
  submitted           integer NOT NULL DEFAULT 0,
  submitted_from_menu integer NOT NULL DEFAULT 0,
  shown_self          integer NOT NULL DEFAULT 0,
  submitted_self      integer NOT NULL DEFAULT 0
);

-- Least privilege. Responses and answers: no UPDATE path at all (immutable); DELETE serves only
-- the admin delete (answers go by cascade). user_feature_uses: DELETE for the §3 erasure.
-- survey_daily: UPDATE for the ON CONFLICT bumps, never DELETE. users already carries
-- table-level UPDATE (0003).
GRANT SELECT, INSERT, DELETE         ON user_feature_uses TO innobox_app;
GRANT SELECT, INSERT, DELETE         ON survey_responses  TO innobox_app;
GRANT SELECT, INSERT, DELETE         ON survey_answers    TO innobox_app;
GRANT SELECT, INSERT, UPDATE         ON survey_daily      TO innobox_app;

-- The platform switch (§14.11), on by default. platform_settings is key/value (0007).
INSERT INTO platform_settings (key, value) VALUES ('survey_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── Backfill first uses ───────────────────────────────────────────────────────────────────
-- Earliest known timestamp per user × feature. `search` and `leaderboard` have no history and
-- start empty; `triage` is approximate (the last visit stands in for the first).

INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT author_id, 'submit_challenge', min(created_at) FROM challenges GROUP BY author_id
ON CONFLICT DO NOTHING;

INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT author_id, 'propose_solution', min(created_at) FROM solutions GROUP BY author_id
ON CONFLICT DO NOTHING;

-- Soft-deleted comments included: posting is what counts.
INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT author_id, 'comment', min(created_at) FROM comments GROUP BY author_id
ON CONFLICT DO NOTHING;

INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT user_id, 'like', min(created_at) FROM likes GROUP BY user_id
ON CONFLICT DO NOTHING;

-- Only EXPLICIT follows count: the automatic follows of an item's author and of the assignee
-- (§12.3) are excluded — a solution's assignee being the parent challenge's.
INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT f.user_id, 'follow', min(f.created_at)
  FROM follows f
  LEFT JOIN challenges c  ON f.parent_type = 'challenge' AND c.id = f.parent_id
  LEFT JOIN solutions s   ON f.parent_type = 'solution'  AND s.id = f.parent_id
  LEFT JOIN challenges sc ON sc.id = s.challenge_id
 WHERE NOT (f.parent_type = 'challenge' AND (c.author_id = f.user_id OR c.assignee_id IS NOT DISTINCT FROM f.user_id))
   AND NOT (f.parent_type = 'solution'  AND (s.author_id = f.user_id OR sc.assignee_id IS NOT DISTINCT FROM f.user_id))
 GROUP BY f.user_id
ON CONFLICT DO NOTHING;

INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT uploaded_by, 'attachments', min(created_at) FROM attachments GROUP BY uploaded_by
ON CONFLICT DO NOTHING;

-- Enforced (non-override) moves by the actor; an author's resubmission is not a review.
INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT a.actor_user_id, 'review', min(a.created_at)
  FROM audit_log a
  JOIN users u ON u.id = a.actor_user_id
 WHERE a.action IN ('challenge.status_changed', 'solution.status_changed')
   AND a.after ->> 'override' = 'false'
   AND coalesce(a.after ->> 'trigger', '') <> 'author_resubmit'
 GROUP BY a.actor_user_id
ON CONFLICT DO NOTHING;

INSERT INTO user_feature_uses (user_id, feature, first_used_at)
SELECT id, 'triage', triage_seen_at FROM users WHERE triage_seen_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- ── Launch stagger ────────────────────────────────────────────────────────────────────────
-- Spread first eligibility over the month after release instead of everyone on day one. Runs
-- once (a marker in platform_settings), touches only rows never stamped, and is NOT counted as
-- "shown" in the funnel — survey_daily starts empty.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'survey_launch_staggered') THEN
    UPDATE users
       SET survey_last_shown_at = now() - random() * interval '30 days'
     WHERE survey_last_shown_at IS NULL
       AND active
       AND scrubbed_at IS NULL
       AND quick_start_seen_at IS NOT NULL;
    INSERT INTO platform_settings (key, value) VALUES ('survey_launch_staggered', to_jsonb(now()));
  END IF;
END $$;
