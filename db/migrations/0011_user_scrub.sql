-- 0011_user_scrub.sql — GDPR erasure support (INNOBOX_SPEC.md §3).
-- A `scrubbed_at` marker lets the platform-admin "Delete user info" action de-identify a
-- user's row (display name -> "Deleted User", personal fields nulled), and lets Entra
-- reconciliation know never to restore a scrubbed user's attributes. Idempotent.
alter table users add column if not exists scrubbed_at timestamptz;
