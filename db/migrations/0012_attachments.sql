-- 0012_attachments.sql — §11 Attachments (INNOBOX_SPEC.md §5, §11). Objects live immutably
-- in MinIO; this table carries the metadata + scan_status. Rows are NEVER hard-deleted:
-- infected and author-removed rows stay as tombstones (scan_status='infected' / removed_at
-- set), the MinIO object purged in both cases (invariant 4 / §11) — so the app role gets
-- INSERT/SELECT/UPDATE, no DELETE. Idempotent (create ... if not exists).

CREATE TABLE IF NOT EXISTS attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_type  text NOT NULL CHECK (parent_type IN ('challenge','solution')),
  parent_id    uuid NOT NULL,
  filename     text NOT NULL,
  size_bytes   bigint NOT NULL,
  mime         text NOT NULL,
  object_key   text NOT NULL UNIQUE,
  scan_status  text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected')),
  scanned_at   timestamptz,
  removed_at   timestamptz,
  uploaded_by  uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_parent_idx      ON attachments (parent_type, parent_id);
CREATE INDEX IF NOT EXISTS attachments_scan_status_idx ON attachments (scan_status);

-- No DELETE: infected & author-removed rows are retained as tombstones (§11); the MinIO
-- object is purged in both cases, but the metadata row stays for the audit trail.
GRANT SELECT, INSERT, UPDATE ON attachments TO innobox_app;
