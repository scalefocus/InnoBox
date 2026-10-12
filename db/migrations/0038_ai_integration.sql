-- 0038_ai_integration.sql — the AI provider connection and its usage telemetry
-- (INNOBOX_SPEC.md §22.3). Idempotent.
--
--   ai_integration — ONE row (the 0007 single-row convention): provider, normalized base URL,
--                    model, and the API token as AES-256-GCM ciphertext under AI_TOKEN_ENC_KEY
--                    (`v1:iv:tag:ct`) next to its last 4 characters. No row = not configured;
--                    *Remove* hard-deletes the row, token included. `last_test_*` is the latest
--                    test of exactly the saved configuration (`last_test_model` = the model the
--                    provider echoed, shown on the card's *Last test* panel); `last_call_*` the
--                    latest runtime call; `last_failure_logged_at` the platform-wide 15-minute
--                    system-log throttle watermark, claimed by a conditional UPDATE so web and
--                    worker never double-log.
--   ai_usage       — one row per provider call (a retried call is one row): counts only, NEVER
--                    the prompt, the response, the base URL or the token. `feature` is a registry
--                    key or `test`; `user_id` the person the call ran for (null for background
--                    work), nulled by GDPR erasure. 365-day retention, pruned hourly by the
--                    worker. Survives *Remove*. Never exposed per person (aggregates only).
--
-- The display name, timeouts and switches are platform_settings rows (no DDL).

CREATE TABLE IF NOT EXISTS ai_integration (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled                 boolean NOT NULL DEFAULT false,
  provider                text NOT NULL CHECK (provider IN ('openwebui', 'openai')),
  base_url                text NOT NULL CHECK (char_length(base_url) BETWEEN 1 AND 500),
  model                   text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  token_enc               text NOT NULL,          -- AES-256-GCM under AI_TOKEN_ENC_KEY, never plaintext
  token_last4             text NOT NULL,
  last_test_at            timestamptz,
  last_test_ok            boolean,
  last_test_error         text,
  last_test_latency_ms    integer,
  last_test_model         text,
  last_call_at            timestamptz,
  last_call_ok            boolean,
  last_call_error         text,
  last_failure_logged_at  timestamptz,
  updated_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id             bigserial PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  feature        text NOT NULL,
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  provider       text NOT NULL,
  model          text NOT NULL,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer NOT NULL DEFAULT 0,
  ok             boolean NOT NULL,
  error_code     text
);

-- The 30-day usage panel, the per-feature breakdown and the retention prune.
CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_feature_idx ON ai_usage (feature, created_at DESC);
-- GDPR erasure nulls user_id by person.
CREATE INDEX IF NOT EXISTS ai_usage_user_idx ON ai_usage (user_id) WHERE user_id IS NOT NULL;

-- Least-privilege grants: the admin card upserts and removes the single row; the helper updates
-- last_call_* and the throttle watermark. ai_usage: insert per call, UPDATE for erasure,
-- DELETE for the prune.
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_integration TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_usage       TO innobox_app;
GRANT USAGE, SELECT ON SEQUENCE ai_usage_id_seq        TO innobox_app;
