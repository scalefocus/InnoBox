-- 0044_agent_access.sql — agent access through an MCP server (INNOBOX_SPEC.md §25.13).
--
--   oauth_clients — one row per dynamically registered MCP client (RFC 7591, public clients only).
--     logo_uri is stored, never fetched or shown. blocked_at is the platform admin's per-client
--     block (§25.10): its grants stay, so unblocking restores them.
--   oauth_grants — a person's approval of one client. One LIVE grant per (person, client); approving
--     again refreshes it. Revocation stamps revoked_at (and revoked_by for a person's own revoke).
--   oauth_tokens — authorization codes, access tokens and refresh tokens, stored ONLY as SHA-256
--     hashes. rotated_from_id links a refresh token to the one it replaced, so presenting an
--     already-rotated refresh token is detected as reuse. code_challenge / redirect_uri / resource
--     are set for codes only.
--   oauth_pending_authorizations — the validated /oauth/authorize request, keyed by an opaque
--     handle the consent form carries instead of the request itself: single-use, 10 minutes, bound
--     to its person (§25.3).
--   challenges / solutions / comments.mcp_client_name — the client name at creation time for
--     anything created through MCP (null for the browser) — the "via agent" tag (§25.8).
--   gamification_ledger.via_mcp — whether the item (or comment) an award is about was created
--     through MCP; the new 0-point, item-less `agent_connected` reason (§25.12).
--   platform_settings — the four mcp_* settings, each written only if absent.
--
-- The app role gets full DML on the four oauth_* tables (rows are revoked, rotated and swept);
-- the ledger stays INSERT/SELECT(+DELETE for erasure) — via_mcp is set at insert, never updated.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         text NOT NULL UNIQUE,
  client_name       text NOT NULL,
  client_uri        text,
  logo_uri          text,
  redirect_uris     text[] NOT NULL,
  software_id       text,
  software_version  text,
  registered_ip     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_used_at      timestamptz,
  blocked_at        timestamptz
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  scope         text NOT NULL DEFAULT 'mcp',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
-- One live grant per (person, client); consenting again refreshes it.
CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_live_idx ON oauth_grants (user_id, client_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_grants_client_idx ON oauth_grants (client_id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id         uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  token_hash       text NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  rotated_from_id  uuid REFERENCES oauth_tokens(id) ON DELETE SET NULL,
  code_challenge   text,
  redirect_uri     text,
  resource         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_expires_idx ON oauth_tokens (expires_at);

CREATE TABLE IF NOT EXISTS oauth_pending_authorizations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  request      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  consumed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_pending_created_idx ON oauth_pending_authorizations (created_at);

-- §25.8: the client name at creation time, null for everything created in the browser.
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS mcp_client_name text;
ALTER TABLE solutions  ADD COLUMN IF NOT EXISTS mcp_client_name text;
ALTER TABLE comments   ADD COLUMN IF NOT EXISTS mcp_client_name text;

-- §25.12: via_mcp on every award row, and the item-less agent_connected reason.
ALTER TABLE gamification_ledger ADD COLUMN IF NOT EXISTS via_mcp boolean NOT NULL DEFAULT false;
ALTER TABLE gamification_ledger DROP CONSTRAINT IF EXISTS gamification_ledger_reason_check;
ALTER TABLE gamification_ledger ADD CONSTRAINT gamification_ledger_reason_check CHECK (reason IN (
  'challenge_submitted', 'challenge_validated', 'challenge_solved', 'assignment_solved',
  'solution_proposed', 'solution_validated', 'solution_implemented',
  'like_received', 'comment_posted', 'agent_connected'));
ALTER TABLE gamification_ledger ALTER COLUMN item_type DROP NOT NULL;
ALTER TABLE gamification_ledger ALTER COLUMN item_id DROP NOT NULL;
-- The item is null exactly for agent_connected.
ALTER TABLE gamification_ledger DROP CONSTRAINT IF EXISTS gamification_ledger_item_check;
ALTER TABLE gamification_ledger ADD CONSTRAINT gamification_ledger_item_check CHECK (
  CASE WHEN reason = 'agent_connected' THEN item_type IS NULL AND item_id IS NULL
       ELSE item_type IS NOT NULL AND item_id IS NOT NULL END);

-- §25.10: off by default. Re-running never flips an admin's choice back.
INSERT INTO platform_settings (key, value) VALUES ('mcp_enabled', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('mcp_restricted_content_enabled', 'false'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('mcp_access_token_ttl_minutes', '60'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('mcp_refresh_token_ttl_days', '90'::jsonb) ON CONFLICT (key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_clients                TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_grants                 TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_tokens                 TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_pending_authorizations TO innobox_app;
