-- 0025_notification_preferences.sql — per-event notification preferences (INNOBOX_SPEC.md §12.1).
--
-- Three profile toggles, all default ON (existing users included, via the default), that remove
-- the user from the recipient set of a follower-derived event AT INSERT TIME — no inbox row and
-- no outbox row, so neither the bell nor e-mail ever sees it. The e-mail switch
-- (email_notifications_enabled) stays channel-level and orthogonal.
--
--   notify_followed_comments  — event 6, every recipient route (author, commenters, followers)
--   notify_followed_status    — event 3, followers and authors (never events 4/5/7/8/11)
--   notify_followed_solutions — event 2, challenge author + followers (admins/committee exempt)
--
-- The admin attention events (1, 2, 9, 10 to namespace/platform admins) are never mutable.
-- The app role already holds table-level UPDATE on users, so no extra grant is needed.
alter table users add column if not exists notify_followed_comments  boolean not null default true;
alter table users add column if not exists notify_followed_status    boolean not null default true;
alter table users add column if not exists notify_followed_solutions boolean not null default true;
