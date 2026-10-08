-- 0001_app_role.sql — least-privilege application role (db/migrations/README.md).
-- Web and worker connect as innobox_app; migrate.sh sets its password from
-- INNOBOX_APP_PASSWORD after every run. Table privileges are granted per table in
-- the migration that creates each table — never a blanket ALL.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'innobox_app') THEN
    CREATE ROLE innobox_app LOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO innobox_app;
