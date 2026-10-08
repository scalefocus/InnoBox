-- 0003_identity.sql — Phase 1 identity schema (ENTRA_AUTH_SPEC.md §4; INNOBOX_SPEC.md §3–§4).
-- Users mirror Entra (OIDC JIT + SCIM/reconciliation), groups mirror synced Entra groups,
-- role_mappings bind Entra group object ids to roles (invariant 1: roles resolve from
-- SCIM-synced membership, never token claims). Users are soft-deactivated, never deleted.

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE NOT NULL,          -- Entra object id == OIDC oid == SCIM externalId
  user_name     text NOT NULL,                 -- UPN as sent (compared case-insensitively)
  email         text,
  display_name  text NOT NULL DEFAULT '',
  department    text,
  job_title     text,
  photo         bytea,                         -- 96px thumbnail via reconciliation (Graph)
  photo_etag    text,
  email_notifications_enabled boolean NOT NULL DEFAULT true,   -- §12 per-user e-mail opt-out
  active        boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  scim_synced   boolean NOT NULL DEFAULT false, -- false = JIT stub; true once SCIM/recon owns attributes
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_user_name_lower_idx ON users (lower(user_name));

CREATE TABLE IF NOT EXISTS groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE NOT NULL,          -- Entra group object id
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);

CREATE TABLE IF NOT EXISTS namespaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  display_name  text NOT NULL,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO namespaces (slug, display_name) VALUES ('global', 'Global')
  ON CONFLICT (slug) DO NOTHING;                -- §4.1 built-in namespace

CREATE TABLE IF NOT EXISTS role_mappings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_external_id  text NOT NULL,             -- Entra group object id (never display name)
  role               text NOT NULL CHECK (role IN ('platform_admin','namespace_admin','committee','member')),
  namespace_id       uuid REFERENCES namespaces(id),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_external_id, role, namespace_id),
  CHECK ((role = 'platform_admin') = (namespace_id IS NULL))
);
CREATE INDEX IF NOT EXISTS role_mappings_group_idx ON role_mappings (group_external_id);
-- Postgres treats NULL as distinct in UNIQUE constraints, so platform_admin mappings
-- (which always have namespace_id=NULL) are not protected by the above UNIQUE. Add a
-- partial unique index to enforce at-most-one platform_admin per group.
CREATE UNIQUE INDEX IF NOT EXISTS role_mappings_platform_admin_uniq ON role_mappings (group_external_id) WHERE role = 'platform_admin';

-- audit_log grew up in 0002 promising this FK once users existed. Users are never
-- hard-deleted (leaver = deactivate, GDPR scrub de-identifies in place), so no ON DELETE.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'audit_log_actor_fk' AND conrelid = 'audit_log'::regclass
  ) THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_fk
      FOREIGN KEY (actor_user_id) REFERENCES users(id);
  END IF;
END $$;

-- Least-privilege grants (no UPDATE where rows are immutable, no DELETE where soft):
GRANT SELECT, INSERT, UPDATE         ON users         TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON groups        TO innobox_app;  -- SCIM group DELETE is real
GRANT SELECT, INSERT,         DELETE ON group_members TO innobox_app;
GRANT SELECT, INSERT, UPDATE         ON namespaces    TO innobox_app;  -- archive, never drop
GRANT SELECT, INSERT,         DELETE ON role_mappings TO innobox_app;
