-- 0047_bug_reports.sql — bug reports in the feedback survey (INNOBOX_SPEC.md §13.10 *Bug reports*,
-- §14.11).
--
--   A bug report is one survey_responses row with trigger = 'bug': no feature, no star answers, a
--   required description in free_text, and two bug-only columns —
--     page_path   — the page the reporter was on (path only: never a query string or fragment),
--                   validated and capped server-side; NULL when what the browser sent was invalid;
--     app_version — the server's own APP_VERSION at submit time, never client-supplied.
--   Like every response it carries NO reference to its author.
--
--   survey_daily.submitted_bug — bug reports per UTC day. A bug report bumps nothing else, so the
--     prompted and self-initiated funnels stay about surveys.
--
--   platform_settings.bug_reports_enabled — the platform switch, on by default. survey_enabled
--     stays the master: either one off turns bug reports off.
--
-- No grant changes: the 0037 grants cover the new columns, and survey_responses still has no UPDATE.

ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_trigger_check;
ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_trigger_check
  CHECK (trigger IN ('feature', 'visit', 'self', 'bug'));

ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS page_path text;
ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS app_version text;

ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_page_path_len;
ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_page_path_len
  CHECK (page_path IS NULL OR char_length(page_path) <= 512);

-- The shape of a bug row, and of every other row: a bug report always has text and never a
-- feature; only a bug report carries a page path or an app version.
ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_bug_shape;
ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_bug_shape
  CHECK (trigger <> 'bug' OR (free_text IS NOT NULL AND feature IS NULL));
ALTER TABLE survey_responses DROP CONSTRAINT IF EXISTS survey_responses_bug_only_columns;
ALTER TABLE survey_responses ADD CONSTRAINT survey_responses_bug_only_columns
  CHECK (trigger = 'bug' OR (page_path IS NULL AND app_version IS NULL));

ALTER TABLE survey_daily ADD COLUMN IF NOT EXISTS submitted_bug integer NOT NULL DEFAULT 0;

INSERT INTO platform_settings (key, value) VALUES ('bug_reports_enabled', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;
