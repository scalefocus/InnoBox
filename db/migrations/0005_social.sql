-- 0005_social.sql — Phase 3 (INNOBOX_SPEC.md §10.2, §12): comments and follows.
-- Comments/likes are never anonymous (§9) — author_id is always the real user.

CREATE TABLE IF NOT EXISTS comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_type  text NOT NULL CHECK (parent_type IN ('challenge','solution')),
  parent_id    uuid NOT NULL,
  author_id    uuid NOT NULL REFERENCES users(id),
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz,
  deleted_at   timestamptz,
  deleted_by   uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments (parent_type, parent_id, created_at);
CREATE INDEX IF NOT EXISTS comments_author_idx ON comments (author_id);

CREATE TABLE IF NOT EXISTS follows (
  user_id      uuid NOT NULL REFERENCES users(id),
  parent_type  text NOT NULL CHECK (parent_type IN ('challenge','solution')),
  parent_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, parent_type, parent_id)
);
CREATE INDEX IF NOT EXISTS follows_parent_idx ON follows (parent_type, parent_id);

-- No DELETE on comments: soft-delete only (deleted_at/deleted_by), §10.2.
GRANT SELECT, INSERT, UPDATE ON comments TO innobox_app;
GRANT SELECT, INSERT, DELETE ON follows  TO innobox_app;
