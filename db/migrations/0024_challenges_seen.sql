-- 0024_challenges_seen.sql — "New since your last visit" markers (INNOBOX_SPEC.md §13.1).
--
--   users.challenges_seen_at — when the user last LEFT the Challenges surface (/challenges and its
--                              detail pages). A challenge created after this instant, and visible
--                              to the user, is "new to them": counted in the nav bubble and tagged
--                              on its card. Advanced on leaving, never on entry, so a visit's count
--                              and tags stay stable.
--
-- Backfilled to this migration's run time so nobody lands on a "9+" bubble at roll-out — only
-- challenges created after this ships are ever new to anyone. The app role already holds
-- table-level UPDATE on users, so no extra grant is needed.
alter table users add column if not exists challenges_seen_at timestamptz;
update users set challenges_seen_at = now() where challenges_seen_at is null;
