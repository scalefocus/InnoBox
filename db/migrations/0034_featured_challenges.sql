-- 0034_featured_challenges.sql — Home "Featured" pins (INNOBOX_SPEC.md §13.2, §5, §14.3).
--
--   challenges.featured_at — when a platform admin pinned the challenge to the Home dashboard
--                            (NULL = not featured). The Featured section orders by it, newest first.
--   challenges.featured_by — the pinning admin. Kept through GDPR erasure (§3): it keeps pointing
--                            at the scrubbed row, which renders as "Deleted User".
--
-- The two are set and cleared together, and a pin may exist only while the challenge is `valid`
-- or `solved` — both DB-checked, so any status write that forgot the §13.2 auto-unpin fails
-- loudly instead of leaving an ineligible pin behind. Curation is not content: writing these
-- columns never bumps updated_at / edited_at / status_changed_at (enforced in the app layer).
--
-- The cap (`featured_limit`, default 3, range 1–6) lives in platform_settings (key/value, no DDL).
-- The app role already holds table-level SELECT/UPDATE on challenges, so no extra grant is needed.
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS featured_at timestamptz;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS featured_by uuid REFERENCES users(id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'challenges_featured_pair_chk') THEN
    ALTER TABLE challenges ADD CONSTRAINT challenges_featured_pair_chk
      CHECK ((featured_at IS NULL) = (featured_by IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'challenges_featured_status_chk') THEN
    ALTER TABLE challenges ADD CONSTRAINT challenges_featured_status_chk
      CHECK (featured_at IS NULL OR status IN ('valid', 'solved'));
  END IF;
END $$;

-- The Featured section and the cap count read only pinned rows (≤ 6) — a tiny partial index.
CREATE INDEX IF NOT EXISTS challenges_featured_at_idx ON challenges (featured_at DESC) WHERE featured_at IS NOT NULL;
