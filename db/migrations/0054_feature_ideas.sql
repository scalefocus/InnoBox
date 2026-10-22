-- 0053_feature_ideas.sql — upvotes and proposals on What's new's Coming soon (INNOBOX_SPEC.md §38,
-- §38.13).
--
--   feature_ideas       — a person's proposal: pending until a platform admin decides it, then
--                         planned (published with the admin's title, teaser and audience),
--                         declined or merged into another entry. Withdraw, the spam delete, the
--                         Planned-tab delete and the §3 erasure DELETE rows; nothing else does.
--                         `description` is null only for a planned idea whose author was erased
--                         (§38.12). No namespace: an idea is product feedback, not namespace content.
--   feature_idea_votes  — one upvote per (person, Coming soon entry): a specified teaser's key
--                         (`spec_key`, no FK — the teasers live in code) or a planned idea
--                         (`idea_id`, cascading with the idea). Added or removed, never changed.
--   coming_soon_teasers — the worker's mirror of the specified teasers' keys, titles and audiences
--                         (§38.9), so the release that drops a teaser can still name it to its voters
--                         — the ones it still applies to.
--   users.feature_ideas_named       — the §38.6 name switch, on by default.
--   platform_settings               — feature_ideas_enabled, on by default (§38.11).
--   gamification_ledger             — the item-less reasons idea_approved and idea_shipped (§38.10).
--
-- Idempotent: IF NOT EXISTS tables/columns/indexes, constraints dropped and re-added whole, and the
-- setting seeded ON CONFLICT DO NOTHING (a re-run never flips an admin's choice back).

CREATE TABLE IF NOT EXISTS feature_ideas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id       uuid NOT NULL REFERENCES users(id),
  description     text CHECK (char_length(description) <= 1000),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'planned', 'declined', 'merged')),
  title           text CHECK (char_length(title) <= 60),
  teaser          text CHECK (char_length(teaser) <= 280),
  audience        text CHECK (audience IN ('everyone', 'admins', 'platform_admin')),
  decision_note   text CHECK (char_length(decision_note) <= 1000),
  merged_into     text,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_ideas_planned_copy CHECK (status <> 'planned' OR (title IS NOT NULL AND teaser IS NOT NULL AND audience IS NOT NULL)),
  CONSTRAINT feature_ideas_decided_at CHECK (status = 'pending' OR decided_at IS NOT NULL),
  CONSTRAINT feature_ideas_merged_into CHECK (status <> 'merged' OR merged_into IS NOT NULL),
  CONSTRAINT feature_ideas_description CHECK (description IS NOT NULL OR status = 'planned')
);
CREATE INDEX IF NOT EXISTS feature_ideas_status_idx ON feature_ideas (status, created_at);
CREATE INDEX IF NOT EXISTS feature_ideas_author_idx ON feature_ideas (author_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON feature_ideas TO innobox_app;

CREATE TABLE IF NOT EXISTS feature_idea_votes (
  user_id     uuid NOT NULL REFERENCES users(id),
  spec_key    text,
  idea_id     uuid REFERENCES feature_ideas(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT feature_idea_votes_one_target CHECK ((spec_key IS NULL) <> (idea_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS feature_idea_votes_spec_uniq ON feature_idea_votes (user_id, spec_key) WHERE spec_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS feature_idea_votes_idea_uniq ON feature_idea_votes (user_id, idea_id) WHERE idea_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS feature_idea_votes_spec_idx ON feature_idea_votes (spec_key) WHERE spec_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS feature_idea_votes_idea_idx ON feature_idea_votes (idea_id) WHERE idea_id IS NOT NULL;

GRANT SELECT, INSERT, DELETE ON feature_idea_votes TO innobox_app;  -- no UPDATE: a vote is added or removed

CREATE TABLE IF NOT EXISTS coming_soon_teasers (
  key       text PRIMARY KEY,
  title     text NOT NULL,
  audience  text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone', 'admins', 'platform_admin')),
  seen_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON coming_soon_teasers TO innobox_app;

ALTER TABLE users ADD COLUMN IF NOT EXISTS feature_ideas_named boolean NOT NULL DEFAULT true;

-- §38.10: the two new ledger reasons, both item-less like agent_connected. Rewritten whole, as 0050 did.
ALTER TABLE gamification_ledger DROP CONSTRAINT IF EXISTS gamification_ledger_reason_check;
ALTER TABLE gamification_ledger ADD CONSTRAINT gamification_ledger_reason_check CHECK (reason IN (
  'challenge_submitted', 'challenge_validated', 'challenge_solved', 'assignment_solved',
  'solution_proposed', 'solution_validated', 'solution_implemented',
  'like_received', 'comment_posted', 'agent_connected',
  'hype_received', 'hype_fulfilled',
  'idea_approved', 'idea_shipped'));
ALTER TABLE gamification_ledger DROP CONSTRAINT IF EXISTS gamification_ledger_item_check;
ALTER TABLE gamification_ledger ADD CONSTRAINT gamification_ledger_item_check CHECK (
  CASE WHEN reason IN ('agent_connected', 'idea_approved', 'idea_shipped') THEN item_type IS NULL AND item_id IS NULL
       ELSE item_type IS NOT NULL AND item_id IS NOT NULL END);

-- §38.11: on by default.
INSERT INTO platform_settings (key, value) VALUES ('feature_ideas_enabled', 'true'::jsonb)
  ON CONFLICT (key) DO NOTHING;
