-- 0016_attachment_uploads.sql — chunked-upload sessions (INNOBOX_SPEC.md §11).
-- A file larger than the configured chunk size is uploaded ONE CHUNK AT A TIME through the
-- server (never direct-to-store — invariant 4), which relays each chunk to a MinIO multipart
-- upload and reassembles it on complete. This table tracks ONE in-flight session between
-- `initiate` and `complete`/`abort`: the pre-allocated attachment id (which forms the eventual
-- object_key), the MinIO multipart-upload id, the declared metadata, and the chunk size. Unlike
-- `attachments`, these are TRANSIENT working rows — deleted on complete (the attachments row
-- takes over) or on abort — so the app role gets DELETE here. Abandoned sessions (>2h) are
-- aborted at the next initiate and by the worker housekeeping sweep. Idempotent.

CREATE TABLE IF NOT EXISTS attachment_uploads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id       uuid NOT NULL,
  parent_type         text NOT NULL CHECK (parent_type IN ('challenge','solution')),
  parent_id           uuid,
  draft_key           uuid,
  filename            text NOT NULL,
  mime                text NOT NULL,
  declared_size_bytes bigint NOT NULL,
  object_key          text NOT NULL,
  s3_upload_id        text NOT NULL,
  chunk_size_bytes    bigint NOT NULL,
  uploaded_by         uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Exactly one target, mirroring `attachments` (§11 staged XOR bound).
  CONSTRAINT attachment_uploads_parent_xor_draft CHECK ((parent_id IS NULL) <> (draft_key IS NULL))
);

-- Supports the stale-session sweep (caller's own at initiate; all sessions at the worker backstop).
CREATE INDEX IF NOT EXISTS attachment_uploads_uploader_idx ON attachment_uploads (uploaded_by, created_at);

-- Transient working state — DELETE is granted here (unlike the tombstoned `attachments` table).
GRANT SELECT, INSERT, UPDATE, DELETE ON attachment_uploads TO innobox_app;
