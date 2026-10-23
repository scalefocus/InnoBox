-- 0057_feature_idea_titles.sql — a title of the proposer's own on every feature-idea proposal
-- (INNOBOX_SPEC.md §38.4, §38.13).
--
--   feature_ideas.proposal_title — the proposer's title (≤ 60), sent with the text and never changed.
--       It is not the published `title`, which a platform admin writes on approval (§38.5). Null
--       exactly when `description` is: the seeded entries have neither, and the §3 erasure clears
--       both from a planned idea (§38.12).
--
-- Every existing row with a description is given the title the Approve dialog pre-filled from its
-- text until now (`titlePrefill` in @innobox/shared/feature-ideas): the first sentence — up to the
-- first `.`, `!` or `?` followed by whitespace or the end, or the first line break — without its
-- closing mark, cut at a word boundary to 60 characters with an ellipsis; when that leaves nothing,
-- the text's start, cut the same way. The two helpers live in pg_temp, for this session only.
-- The published `title` is left alone, and nothing is notified or audited: a migration is not an
-- actor (§15).
--
-- Idempotent: the column is IF NOT EXISTS, the backfill touches only rows still without a title,
-- and the CHECK is added only when missing.

ALTER TABLE feature_ideas ADD COLUMN IF NOT EXISTS proposal_title text CHECK (char_length(proposal_title) <= 60);

-- cutAtWord: whitespace runs collapsed; over `max_len`, cut before the last space past a third of
-- the room (or hard), trailing punctuation dropped, and an ellipsis (U+2026, written as chr(8230)
-- so the file reads the same under any client encoding) added.
CREATE OR REPLACE FUNCTION pg_temp.feature_idea_cut_at_word(t text, max_len int) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  flat text := btrim(regexp_replace(t, '\s+', ' ', 'g'));
  room text;
  space_at int;
BEGIN
  IF char_length(flat) <= max_len THEN
    RETURN flat;
  END IF;
  room := left(flat, max_len - 1);
  -- The 0-based index of the last space, as String.prototype.lastIndexOf; -1 for none.
  space_at := CASE WHEN strpos(reverse(room), ' ') = 0 THEN -1 ELSE char_length(room) - strpos(reverse(room), ' ') END;
  IF space_at > max_len / 3.0 THEN
    room := left(room, space_at);
  END IF;
  RETURN rtrim(room, ' ,;:.!?-') || chr(8230);
END $$;

-- titlePrefill: the first sentence of the first line, without its closing mark, cut to 60.
CREATE OR REPLACE FUNCTION pg_temp.feature_idea_title_prefill(t text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  first_line text := rtrim(split_part(btrim(t, E' \t\r\n'), E'\n', 1), E'\r');
  sentence text := first_line;
  n int := char_length(first_line);
  prefill text;
BEGIN
  FOR i IN 1..n LOOP
    IF substr(first_line, i, 1) IN ('.', '!', '?') AND (i = n OR substr(first_line, i + 1, 1) ~ '\s') THEN
      sentence := left(first_line, i);
      EXIT;
    END IF;
  END LOOP;
  prefill := pg_temp.feature_idea_cut_at_word(rtrim(sentence, '.!?'), 60);
  IF prefill = '' THEN
    prefill := pg_temp.feature_idea_cut_at_word(t, 60);
  END IF;
  RETURN prefill;
END $$;

UPDATE feature_ideas SET proposal_title = pg_temp.feature_idea_title_prefill(description)
 WHERE proposal_title IS NULL AND description IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_ideas_proposal_title') THEN
    ALTER TABLE feature_ideas ADD CONSTRAINT feature_ideas_proposal_title CHECK ((proposal_title IS NULL) = (description IS NULL));
  END IF;
END $$;

DROP FUNCTION IF EXISTS pg_temp.feature_idea_title_prefill(text);
DROP FUNCTION IF EXISTS pg_temp.feature_idea_cut_at_word(text, int);
