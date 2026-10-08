-- 0002_audit_log.sql — append-only audit log (INNOBOX_SPEC.md §2.1 invariant 5, §15).
-- Enforced append-only TWICE: the app role gets SELECT+INSERT only (no UPDATE/DELETE
-- grants), and a trigger blocks mutation regardless of role. Never edit this table's
-- rows; corrections are new entries.

CREATE TABLE IF NOT EXISTS audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Nullable: system/worker events (SCIM sync anomalies, scan verdicts) have no user
  -- actor. FK to users(id) is added when the users table lands (Phase 1) — audit must
  -- exist first (it records identity events from the very first sign-in).
  actor_user_id uuid,
  action        text        NOT NULL,
  target_type   text        NOT NULL,
  target_id     text,
  -- Structured payload halves: state before/after (field-level diffs for edits,
  -- from → to for status transitions, override flags, filter + row count for exports).
  before        jsonb,
  after         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_target_idx     ON audit_log (target_type, target_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx      ON audit_log (actor_user_id);

GRANT SELECT, INSERT ON audit_log TO innobox_app;  -- deliberately NO update/delete

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_mutation ON audit_log;
CREATE TRIGGER audit_log_no_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
