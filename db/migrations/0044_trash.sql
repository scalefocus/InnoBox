-- 0044_trash.sql — the platform-admin trash for challenges and solutions (INNOBOX_SPEC.md §10.4).
--
-- A trashed item keeps every row it had; only its own row is flagged. The three columns are set
-- and cleared together (DB-checked). They are curation, not content: writing them bumps neither
-- updated_at nor edited_at. The visibility predicate (§4.3) hides a flagged item and everything
-- under it from every surface; the worker's daily job purges an item 30 days after trashed_at
-- through the §10.3 cascade.
--
-- Nothing new is granted: trash and restore are UPDATEs (the app role already has UPDATE on both
-- tables), and the purge reuses the 0020 DELETE grants. Idempotent.

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS trashed_at   timestamptz;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS trashed_by   uuid REFERENCES users(id);
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS trash_reason text;

ALTER TABLE solutions ADD COLUMN IF NOT EXISTS trashed_at   timestamptz;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS trashed_by   uuid REFERENCES users(id);
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS trash_reason text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'challenges_trash_chk') THEN
    ALTER TABLE challenges ADD CONSTRAINT challenges_trash_chk CHECK (
      (trashed_at IS NULL AND trashed_by IS NULL AND trash_reason IS NULL)
      OR (trashed_at IS NOT NULL AND trashed_by IS NOT NULL AND trash_reason IS NOT NULL AND char_length(trash_reason) <= 500)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'solutions_trash_chk') THEN
    ALTER TABLE solutions ADD CONSTRAINT solutions_trash_chk CHECK (
      (trashed_at IS NULL AND trashed_by IS NULL AND trash_reason IS NULL)
      OR (trashed_at IS NOT NULL AND trashed_by IS NOT NULL AND trash_reason IS NOT NULL AND char_length(trash_reason) <= 500)
    );
  END IF;
END $$;

-- The trash page and the purge job read only the flagged rows.
CREATE INDEX IF NOT EXISTS challenges_trashed_idx ON challenges (trashed_at) WHERE trashed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS solutions_trashed_idx  ON solutions  (trashed_at) WHERE trashed_at IS NOT NULL;
