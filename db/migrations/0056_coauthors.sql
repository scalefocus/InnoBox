-- 0056_coauthors.sql — co-author teams (INNOBOX_SPEC.md §39, §39.13).
--
--   challenge_authors / solution_authors — one row per member of an item's team, the creator's
--       included, so every authored item has at least one. `author_id` on challenges/solutions
--       stays as the creator and never changes; every "is this person an author?" rule reads these
--       tables instead (§27.2, §27.12). `added_by` is null on the creator's own row and on the
--       backfilled rows. Members are listed by `added_at`, then user id. DELETE: a leave or a
--       removal deletes the row — a member row is working state, and the audit log keeps the
--       history (§27.13).
--   challenge_author_exits / solution_author_exits — who has LEFT a team (§27.4, decision 18). A
--       leave writes one, a removal by another member never does, and nothing undoes it: a person
--       with a row can't be added back to that item. SELECT and INSERT only.
--
-- All four cascade with their item (ON DELETE CASCADE, §27.11): the §10.3 purge deletes the
-- challenge or solution row and its team goes with it. The size cap of five, the one-member rule
-- for anonymous items, the creator's protection and the final leave are the API's, enforced inside
-- the transaction that locks the item's row (§27.4).

CREATE TABLE IF NOT EXISTS challenge_authors (
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  added_by      uuid REFERENCES users(id),
  PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX IF NOT EXISTS challenge_authors_user_idx ON challenge_authors (user_id);

CREATE TABLE IF NOT EXISTS solution_authors (
  solution_id  uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  added_at     timestamptz NOT NULL DEFAULT now(),
  added_by     uuid REFERENCES users(id),
  PRIMARY KEY (solution_id, user_id)
);
CREATE INDEX IF NOT EXISTS solution_authors_user_idx ON solution_authors (user_id);

CREATE TABLE IF NOT EXISTS challenge_author_exits (
  challenge_id  uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  left_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);

CREATE TABLE IF NOT EXISTS solution_author_exits (
  solution_id  uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  left_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (solution_id, user_id)
);

-- The creator's row is written in the create transaction (§27.2) — by a trigger, so every path that
-- inserts an item (the two submit forms, the MCP tools, test fixtures) gets it and none can forget.
-- A challenge accepted from the public form (§24.6) has no author and so no member.
CREATE OR REPLACE FUNCTION challenge_creator_member() RETURNS trigger AS $$
BEGIN
  IF NEW.author_id IS NOT NULL THEN
    INSERT INTO challenge_authors (challenge_id, user_id, added_at) VALUES (NEW.id, NEW.author_id, NEW.created_at)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS challenges_creator_member ON challenges;
CREATE TRIGGER challenges_creator_member AFTER INSERT ON challenges
  FOR EACH ROW EXECUTE FUNCTION challenge_creator_member();

CREATE OR REPLACE FUNCTION solution_creator_member() RETURNS trigger AS $$
BEGIN
  INSERT INTO solution_authors (solution_id, user_id, added_at) VALUES (NEW.id, NEW.author_id, NEW.created_at)
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS solutions_creator_member ON solutions;
CREATE TRIGGER solutions_creator_member AFTER INSERT ON solutions
  FOR EACH ROW EXECUTE FUNCTION solution_creator_member();

-- Backfill: every existing authored item gets its creator as its one member, added when the item
-- was created.
INSERT INTO challenge_authors (challenge_id, user_id, added_at)
SELECT id, author_id, created_at FROM challenges WHERE author_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO solution_authors (solution_id, user_id, added_at)
SELECT id, author_id, created_at FROM solutions
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, DELETE ON challenge_authors      TO innobox_app;
GRANT SELECT, INSERT, DELETE ON solution_authors       TO innobox_app;
GRANT SELECT, INSERT         ON challenge_author_exits TO innobox_app;  -- a leave is never undone
GRANT SELECT, INSERT         ON solution_author_exits  TO innobox_app;
