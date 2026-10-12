-- 0039_ai_results.sql — cached AI task output (INNOBOX_SPEC.md §22.11 triage assist, §22.13
-- discussion summary). Idempotent.
--
--   ai_results — ONE row per (kind, parent): the latest result for an item. `input_hash` is the
--                hash of exactly the inputs the result was made from — an item whose current hash
--                differs is stale (an edit, a new comment) and is re-run or marked so; a Re-run
--                clears it. `status` pending | ready | failed; `payload` the validated output
--                (plain text, rendered escaped); `error_code` a fixed AiError code on failure —
--                never provider text. Output inherits its item's visibility and lifecycle (§22.7):
--                the §10.3 delete cascade removes the rows (polymorphic parent, no FK), and a
--                withdrawn item's rows are deleted. Mutable working data — not audited.

CREATE TABLE IF NOT EXISTS ai_results (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('triage_assist', 'discussion_summary')),
  parent_type  text NOT NULL CHECK (parent_type IN ('challenge', 'solution')),
  parent_id    uuid NOT NULL,          -- no FK: the §10.3 cascade removes these rows explicitly
  input_hash   text,                   -- null = must re-run (Re-run, or a claim never finished)
  model        text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  payload      jsonb,
  error_code   text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,  -- who asked (summary, Re-run)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, parent_type, parent_id)
);

-- The §10.3 cascade and the withdrawn clean-up look rows up by parent.
CREATE INDEX IF NOT EXISTS ai_results_parent_idx ON ai_results (parent_type, parent_id);

-- The web tier reads results, records a Re-run and writes summaries; the worker claims and
-- completes triage runs; the cascade and the withdrawn clean-up delete.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_results TO innobox_app;
