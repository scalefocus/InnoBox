-- 0007_settings_email.sql — Phase 3/4 (INNOBOX_SPEC.md §12, §14.3): platform settings
-- key/value store and the single-row connected e-mail service account. Column shapes match
-- packages/shared/src/email-graph.ts exactly (carried-over, tested Graph engine).

CREATE TABLE IF NOT EXISTS platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A single-row table: id is always literal TRUE, enforced by the CHECK + PK.
CREATE TABLE IF NOT EXISTS email_service_account (
  id                        boolean PRIMARY KEY DEFAULT true CHECK (id),
  account_upn               text NOT NULL,
  account_display_name      text NOT NULL,
  account_oid               text NOT NULL,
  refresh_token_enc         text NOT NULL,
  access_token_enc          text,
  access_token_expires_at   timestamptz,
  connected_by_user_id      uuid REFERENCES users(id),
  connected_at              timestamptz NOT NULL DEFAULT now(),
  last_refresh_at           timestamptz,
  last_refresh_error        text,
  updated_at                timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE         ON platform_settings      TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_service_account  TO innobox_app;  -- disconnect hard-deletes
