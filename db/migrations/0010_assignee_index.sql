-- 0010_assignee_index.sql — hardening pass: the §14.1 triage queue filters on
-- challenges.assignee_id (including "Unassigned" via IS NULL), which had no supporting
-- index — only namespace_id/status/author_id were indexed by 0004_challenges.sql.

CREATE INDEX IF NOT EXISTS challenges_assignee_idx ON challenges (assignee_id);
