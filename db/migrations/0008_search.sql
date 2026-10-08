-- 0008_search.sql — Phase 4 (INNOBOX_SPEC.md §13.4): Postgres tsvector full-text search
-- over challenge title/description/client_name and solution description/cost_vs_benefits.
-- Generated STORED columns keep the vector always in sync with no app-side maintenance;
-- GIN indexes back the @@ queries. Exact CH-<n>/SOL-<n> lookup uses the existing number
-- indexes, not these vectors.

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(client_name, '')), 'C')
  ) STORED;
CREATE INDEX IF NOT EXISTS challenges_search_idx ON challenges USING GIN (search_vector);

ALTER TABLE solutions ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(description, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(cost_vs_benefits, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS solutions_search_idx ON solutions USING GIN (search_vector);
