# db/migrations — conventions (INNOBOX_SPEC.md §2, §15)

Plain-SQL migrations, applied **in filename order** by the `migrate` compose service
(`deploy/migrate.sh`), which tracks applied files in `_schema_migrations`.

## Rules

- **Naming:** `NNNN_short_name.sql`, zero-padded, strictly increasing (`0001_init.sql`, …).
- **Idempotent by construction:** the runner re-applies on drift and tolerates benign
  re-run noise — write every statement with `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`
  where possible. Any other SQL error aborts the deploy.
- **Never edit an applied migration.** A fix is a new migration.
- **Timestamps** are always `timestamptz` (UTC) — display conversion happens in the
  browser (CLAUDE.md "Conventions").

## Least-privilege app role (first migration must establish this)

Web and worker connect as **`innobox_app`** (password set by `migrate.sh` from
`INNOBOX_APP_PASSWORD`), NOT as the superuser. The bootstrap migration creates the
role and grants table-by-table privileges:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'innobox_app') THEN
    CREATE ROLE innobox_app LOGIN;
  END IF;
END $$;
-- then, per table: GRANT SELECT/INSERT/UPDATE/DELETE ... TO innobox_app;
```

## Append-only audit log (INNOBOX_SPEC.md §2.1 invariant 5, §15)

`audit_log` must be enforced append-only **twice**: the app role gets INSERT+SELECT
only (no UPDATE/DELETE grants), **and** a trigger blocks mutation regardless of role:

```sql
GRANT SELECT, INSERT ON audit_log TO innobox_app;  -- deliberately NO update/delete

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutation ON audit_log;
CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
```

The schema itself (challenges, solutions, comments, likes, follows, attachments,
notifications, namespaces, role_mappings, impact_areas, settings, users) is designed
during Phase 0/2 implementation against INNOBOX_SPEC.md §5 — spec first, then DDL.
