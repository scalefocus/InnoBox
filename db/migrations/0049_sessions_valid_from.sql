-- 0049_sessions_valid_from.sql — "Sign out everywhere" (INNOBOX_SPEC.md §3, added in v1.16).
--
--   users.sessions_valid_from — a session token issued BEFORE this instant is no session:
--                               getSessionUser() (lib/auth.ts) compares the token's issue time
--                               with it and answers as for an inactive user. Stamped to now() by
--                               POST /api/me/sign-out-everywhere (the account menu item), by the
--                               GDPR erasure (scrubUser) and by SCIM deactivation
--                               (ENTRA_AUTH_SPEC.md §5 leaver semantics).
--
-- NULLABLE on purpose: NULL means "never stamped" and accepts every token, exactly as before
-- this migration. The column is never shown and is used for nothing else. No new grant:
-- users already grants SELECT/INSERT/UPDATE to innobox_app (0003).

ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_from timestamptz;
