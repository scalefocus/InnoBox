-- 0022_audit_truncate_guard.sql — append-only covers TRUNCATE too (INNOBOX_SPEC.md §15,
-- §2.1 invariant 5). The 0002 mutation-blocking trigger is a ROW trigger (UPDATE, DELETE),
-- and TRUNCATE bypasses row triggers. The app role holds no TRUNCATE grant; this
-- statement-level BEFORE TRUNCATE trigger closes the path for the owner role as well, so
-- emptying audit_log requires deliberately dropping the trigger first (itself a DDL change
-- visible in migrations), never an accidental TRUNCATE.
--
-- Idempotent: CREATE OR REPLACE for the function, DROP IF EXISTS + CREATE for the trigger.

CREATE OR REPLACE FUNCTION audit_log_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (TRUNCATE refused)';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();
