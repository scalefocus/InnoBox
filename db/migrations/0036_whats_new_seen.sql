-- 0036_whats_new_seen.sql — the What's new update notice (INNOBOX_SPEC.md §13.9).
--
--   users.whats_new_seen_version — the release the user has ACKNOWLEDGED (dismissed the notice
--     for, opened /whats-new on, or finished Quick start on), a strict x.y.z version. Null means
--     never stamped. Deliberately NOT back-filled: every existing, onboarded user sees the notice
--     once on their next page load.
--   users.whats_new_since_date — a ONE-TIME rollout snapshot: the UTC calendar day of the user's
--     last activity (§14.5 last_seen_at), or null when there is none. Read only while the marker
--     is null, so the first notice can still say what an existing user missed; the first stamp
--     clears it. A `date`, not a `timestamptz` — a deliberate carve-out from invariant 10,
--     because it is compared against the changelog's calendar dates.
--
-- The snapshot runs only in the same statement block that creates the column, so re-running
-- this file never moves the boundary. Column-level privileges: the table-level UPDATE grant on
-- users already covers both columns. Erasure (§3) nulls both (api/users/store.ts).
-- Numbered 0036 by reservation; the runner tracks applied files individually, so it applies
-- cleanly after 0038/0039 on an existing database.

ALTER TABLE users ADD COLUMN IF NOT EXISTS whats_new_seen_version text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'whats_new_since_date'
  ) THEN
    ALTER TABLE users ADD COLUMN whats_new_since_date date;
    UPDATE users
       SET whats_new_since_date = (last_seen_at AT TIME ZONE 'UTC')::date
     WHERE last_seen_at IS NOT NULL;
  END IF;
END $$;
