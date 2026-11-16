-- 0061_user_first_synced_at.sql — the first directory sync's marker (INNOBOX_SPEC.md §3).
--
-- A user row is created with only part of what Entra knows: a JIT sign-in writes the token's name
-- and e-mail, a SCIM create adds department and job title but no office and no photo. The worker's
-- first directory sync (every 30 s, leader-only) runs reconciliation's per-user step once, early,
-- for each new row, so a new colleague's directory profile and photo no longer wait for the hourly
-- pass.
--
-- `first_synced_at` is when reconciliation first read the row from Microsoft Graph successfully;
-- NULL means "not yet". Every insert path leaves it NULL by default, so none of them changes. It is
-- never shown and nothing outside reconciliation reads it. Rows that predate this migration are
-- stamped by the first hourly pass after the upgrade — there is deliberately no backfill, and the
-- sweep's 5-minute `created_at` window keeps it away from them meanwhile.
alter table users add column if not exists first_synced_at timestamptz;

-- The sweep's query: pending rows, newest first. Partial, so it holds only rows no pass has read yet.
create index if not exists users_first_sync_pending_idx on users (created_at) where first_synced_at is null;
