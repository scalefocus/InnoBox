-- 0055_coming_soon_in_db.sql — What's new's Coming soon lives only in the database (INNOBOX_SPEC.md
-- §38.9, §38.13).
--
-- Until v1.21.0 the features the spec defined but had not built were teased from a list in code
-- (`UPCOMING`, keyed by slug) and voted on by key (`feature_idea_votes.spec_key`). This moves them:
--
--   feature_ideas       — the ten teasers become `planned` rows with no proposer (author_id null,
--                         description null, decided_by null), with fixed ids and decided_at/created_at
--                         one second apart from a fixed instant in the list's former order, so ties on
--                         votes keep that order (§38.2). author_id may now be null, but only on a
--                         planned row.
--   feature_idea_votes  — every vote on one of the ten keys moves to its row (keeping created_at);
--                         a vote on any other key is dropped. Then spec_key, the one-target CHECK and
--                         the spec_key indexes go, and idea_id becomes NOT NULL with a plain unique key.
--   merged_into         — `spec:<key>` → the seeded row's id, `idea:<uuid>` → the bare id (§38.2).
--   coming_soon_teasers — the worker's mirror of the teasers, dropped with the sweep that read it.
--
-- Nothing is announced (no event 20, no award) and nothing is audited: a migration is not an actor.
-- Idempotent: the seed, the vote move and the merged_into rewrite run only while spec_key still
-- exists — on the first application, never again, so a re-run can never bring back an entry a
-- platform admin has since deleted — and every DDL statement is IF [NOT] EXISTS.

-- ── feature_ideas: a planned entry may have no proposer ─────────────────────────────────────────
ALTER TABLE feature_ideas ALTER COLUMN author_id DROP NOT NULL;
ALTER TABLE feature_ideas DROP CONSTRAINT IF EXISTS feature_ideas_author;
ALTER TABLE feature_ideas ADD CONSTRAINT feature_ideas_author CHECK (author_id IS NOT NULL OR status = 'planned');

-- ── The ten former teasers, in their former order ───────────────────────────────────────────────
CREATE TEMP TABLE IF NOT EXISTS coming_soon_seed (
  n         int PRIMARY KEY,
  key       text NOT NULL UNIQUE,
  id        uuid NOT NULL UNIQUE,
  title     text NOT NULL,
  teaser    text NOT NULL,
  audience  text NOT NULL
);
INSERT INTO coming_soon_seed (n, key, id, title, teaser, audience) VALUES
  (1, 'co-authors', '599302bc-d2a0-4a62-b076-055af9bd8dce', 'Co-authors',
   'Write a challenge or a solution together with up to four colleagues. Everyone on the team can edit it, and everyone earns the credit when it succeeds.', 'everyone'),
  (2, 'impact-tracking', 'febbd673-37e8-49f4-9b8d-b4fb50a0ca11', 'Impact tracking',
   'Record what an implemented solution actually delivered, such as hours saved, costs avoided or revenue won, and see the value delivered so far on Home.', 'everyone'),
  (3, 'affects-me-too', 'e64258fd-c86f-494d-8cc1-6487549b3fef', 'This affects me too',
   'Tell reviewers a challenge affects you, and how many people, so the problems with the widest reach stand out in triage.', 'everyone'),
  (4, 'mark-as-duplicate', '7a7c21c4-f2ff-43f7-8275-9ff7945d4f62', 'Mark as duplicate',
   'Close a duplicate challenge in one step: its followers move to the original, and its author is told where the discussion continues.', 'admins'),
  (5, 'stuck-item-alerts', '714e2378-9db6-4f10-992e-bb82b2380015', 'Stuck-item alerts',
   'See how long each item has waited in its status, highlighted against your targets, plus a weekly e-mail listing what is stuck.', 'admins'),
  (6, 'implementation-board', 'df81a49d-26ba-4734-87f4-5696450b4ea9', 'Implementation board',
   'Follow accepted solutions on a board, from acceptance to implementation. Reviewers move the cards along; everyone else sees the roadmap.', 'everyone'),
  (7, 'invite-a-solver', 'f8b3ce3f-186a-4e95-83ae-fa61d6a07612', 'Invite a solver',
   'Know someone who could crack a challenge? Invite them to propose a solution, and earn a badge when they do.', 'everyone'),
  (8, 'campaigns', '90ca47b8-245d-4c22-913c-c820f1a78967', 'Campaigns',
   'Time-boxed calls for challenges on one theme, such as cutting cloud costs, with a banner on Home while they run and a report when they close.', 'everyone'),
  (9, 'year-in-review', 'b6ab8ab7-1aeb-4e45-9906-9d1d214510ca', 'Your year in review',
   'A personal recap of your year in InnoBox: what you raised, what you solved, and the badges you earned along the way.', 'everyone'),
  (10, 'namespace-pulse', '12ccadcd-0bb6-482f-97bc-930b0de60b92', 'Namespace pulse',
   'A weekly AI-written brief of your namespace: emerging themes, items that have waited longest, and challenges that look like duplicates.', 'admins')
ON CONFLICT (n) DO NOTHING;

-- ── The rows, then the votes and merge targets move to them (only while spec_key exists) ────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'feature_idea_votes' AND column_name = 'spec_key'
  ) THEN
    INSERT INTO feature_ideas (id, author_id, description, status, title, teaser, audience, decided_by, decided_at, created_at, updated_at)
    SELECT s.id, NULL, NULL, 'planned', s.title, s.teaser, s.audience, NULL,
           timestamptz '2026-10-22 00:00:00+00' + s.n * interval '1 second',
           timestamptz '2026-10-22 00:00:00+00' + s.n * interval '1 second',
           now()
      FROM coming_soon_seed s
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO feature_idea_votes (user_id, idea_id, created_at)
    SELECT v.user_id, s.id, v.created_at
      FROM feature_idea_votes v JOIN coming_soon_seed s ON s.key = v.spec_key
    ON CONFLICT DO NOTHING;
    DELETE FROM feature_idea_votes WHERE spec_key IS NOT NULL;

    UPDATE feature_ideas f SET merged_into = s.id::text
      FROM coming_soon_seed s
     WHERE f.merged_into = 'spec:' || s.key;
    UPDATE feature_ideas SET merged_into = substring(merged_into FROM 6)
     WHERE merged_into LIKE 'idea:%';
  END IF;
END $$;

-- ── feature_idea_votes: one target, the row ─────────────────────────────────────────────────────
ALTER TABLE feature_idea_votes DROP CONSTRAINT IF EXISTS feature_idea_votes_one_target;
DROP INDEX IF EXISTS feature_idea_votes_spec_uniq;
DROP INDEX IF EXISTS feature_idea_votes_spec_idx;
ALTER TABLE feature_idea_votes DROP COLUMN IF EXISTS spec_key;
ALTER TABLE feature_idea_votes ALTER COLUMN idea_id SET NOT NULL;
DROP INDEX IF EXISTS feature_idea_votes_idea_uniq;
DROP INDEX IF EXISTS feature_idea_votes_idea_idx;
CREATE UNIQUE INDEX IF NOT EXISTS feature_idea_votes_uniq ON feature_idea_votes (user_id, idea_id);
CREATE INDEX IF NOT EXISTS feature_idea_votes_idea_id_idx ON feature_idea_votes (idea_id);

-- ── The worker's mirror of the teasers goes with its sweep ──────────────────────────────────────
DROP TABLE IF EXISTS coming_soon_teasers;

DROP TABLE IF EXISTS coming_soon_seed;
