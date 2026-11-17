-- 0062_mentions.sql — mentions in a solution's text (INNOBOX_SPEC.md §43, §43.10).
--
--   solution_mentions — one row per (solution, mentioned person): who mentioned them, when, and
--       settled_at — null while the person is still to be told, stamped once they have been told or
--       passed over (§43.4). A settled row is never deleted by a save: it is the marker that this
--       person has had their one notice for this solution (§43 decision 7). The app role updates
--       only settled_at (the settling check) and mentioned_by (nulled when the sender is erased);
--       DELETE serves a pending mention taken back out of the text, the §10.3 cascade (ON DELETE
--       CASCADE with the solution) and the §3 erasure. The caps (10 per solution, 30 new a UTC day
--       per author) are the API's, under a per-author advisory lock (§43.5).
--   users.notify_mentions — the "Mentions in solutions" preference (§43.6), on by default: it gates
--       §12.1 event 26 when a mention is settled, like notify_invitations (0058) gates event 22.
--   solutions.search_vector — regenerated with every mention token replaced by a space, so a token
--       indexes nothing and a solution is not found by a mentioned person's name (§43.7). From this
--       migration on, description and cost_vs_benefits hold STORED text (§43.2): a mention is the
--       character U+E000, the person's user id and the character U+E001 — never their name. The API
--       strips both characters from every submitted text, and existing rows contain neither.
--
-- `notifications.type` is unconstrained, so the new `mentioned` type (event 26) needs no DDL.

CREATE TABLE IF NOT EXISTS solution_mentions (
  solution_id   uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  mentioned_by  uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  PRIMARY KEY (solution_id, user_id),
  CONSTRAINT solution_mentions_not_self CHECK (mentioned_by IS NULL OR mentioned_by <> user_id)
);
-- The daily cap counts by sender and day; the erasure finds a person's rows by either side.
CREATE INDEX IF NOT EXISTS solution_mentions_sender_idx ON solution_mentions (mentioned_by, created_at);
CREATE INDEX IF NOT EXISTS solution_mentions_user_idx ON solution_mentions (user_id);

GRANT SELECT, INSERT, DELETE ON solution_mentions TO innobox_app;  -- DELETE: a cancelled pending mention, §10.3, §3
GRANT UPDATE (settled_at, mentioned_by) ON solution_mentions TO innobox_app;

ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_mentions boolean NOT NULL DEFAULT true;

-- §43.7: the search column without mention tokens. Rebuilt once — the guard keeps a re-run from
-- rewriting the table again (the generation expression already strips tokens).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'solutions'::regclass
       AND a.attname = 'search_vector'
       AND pg_get_expr(d.adbin, d.adrelid) LIKE '%regexp_replace%'
  ) THEN
    DROP INDEX IF EXISTS solutions_search_idx;
    ALTER TABLE solutions DROP COLUMN IF EXISTS search_vector;
    ALTER TABLE solutions ADD COLUMN search_vector tsvector
      GENERATED ALWAYS AS (
        setweight(to_tsvector('english', regexp_replace(coalesce(description, ''), U&'\E000[^\E001]*\E001', ' ', 'g')), 'A') ||
        setweight(to_tsvector('english', regexp_replace(coalesce(cost_vs_benefits, ''), U&'\E000[^\E001]*\E001', ' ', 'g')), 'B')
      ) STORED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS solutions_search_idx ON solutions USING GIN (search_vector);
