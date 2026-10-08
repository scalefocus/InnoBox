-- 0013_quick_start.sql — Quick start onboarding page (INNOBOX_SPEC.md §13.7).
-- Nullable "seen" marker: NULL means the user has never completed the /quick-start
-- walkthrough, and the app shell redirects them there on their next sign-in. Existing
-- rows are backfilled to this migration's run time so current users are treated as
-- already onboarded — only users who sign in for the first time after this ships see it.
alter table users add column if not exists quick_start_seen_at timestamptz;
update users set quick_start_seen_at = now() where quick_start_seen_at is null;
