-- 0027_identity_sync.sql — identity sync diagnostics (INNOBOX_SPEC.md §14.10, §5).
--
-- groups.scim_synced — true once a SCIM group write (create / replace / patch) has touched the
-- row. Reconciliation's mirroring of a mapped group leaves it false, so a working safety net can
-- never mask missing group provisioning on the platform-admin "Identity sync" card.
--
-- Backfill: a group is SCIM-originated when one of its `scim.group_created` / `scim.group_renamed`
-- audit rows has no `via: reconciliation` marker (reconciliation files `scim.group_created` with
-- `after.via = 'reconciliation'`; the SCIM router never sets `via`). The backfill only ever sets
-- the flag to true, so re-running it is harmless.
--
-- The `scim_last_request_at` stamp lives in platform_settings (key/value, no DDL needed); the app
-- role already holds SELECT/INSERT/UPDATE there and table-level UPDATE on groups (0003).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS scim_synced boolean NOT NULL DEFAULT false;

UPDATE groups g
   SET scim_synced = true
 WHERE NOT g.scim_synced
   AND EXISTS (
         SELECT 1
           FROM audit_log a
          WHERE a.target_type = 'group'
            AND a.target_id = g.id::text
            AND a.action IN ('scim.group_created', 'scim.group_renamed')
            AND coalesce(a.after->>'via', '') <> 'reconciliation'
       );
