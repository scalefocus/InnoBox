-- 0029_channel_webhooks.sql — per-namespace channel webhooks (INNOBOX_SPEC.md §12.4, §5).
-- Idempotent.
--
--   challenges.first_valid_at — set on a challenge's FIRST transition into `valid`, never
--                               cleared. It pins the `challenge.validated` webhook to once per
--                               challenge (a challenge that leaves `valid` and returns — the §10.3
--                               `solved → valid` revert included — never posts it again).
--                               Backfilled below from the audit trail.
--   channel_webhooks          — the configured receivers, at most 5 per namespace (enforced by
--                               the web store under a per-namespace advisory lock). The URL is a
--                               bearer secret: stored only as AES-256-GCM ciphertext under
--                               WEBHOOK_ENC_KEY (`v1:iv:tag:ct`), next to a plaintext hint (host +
--                               last 4 characters) which is the only form any API returns.
--   webhook_deliveries        — the webhook outbox, written by the web tier per enabled webhook of
--                               the item's namespace and drained by the worker's leader-only
--                               sweep. Mutable working data: terminal rows are trimmed 30 days
--                               after `finished_at`; rows of a deleted subtree go with the §10.3
--                               cascade; a deleted webhook takes its rows with it (FK cascade).
--                               `last_reason` is a fixed reason code — never the URL.

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS first_valid_at timestamptz;

-- Backfill (only rows still null, so a re-run is a no-op): the earliest
-- `challenge.status_changed` audit row whose target status is `valid` …
UPDATE challenges c
   SET first_valid_at = a.first_at
  FROM (
        SELECT target_id, min(created_at) AS first_at
          FROM audit_log
         WHERE action = 'challenge.status_changed'
           AND target_type = 'challenge'
           AND after->>'status' = 'valid'
         GROUP BY target_id
       ) a
 WHERE c.first_valid_at IS NULL
   AND a.target_id = c.id::text;

-- … falling back to status_changed_at for challenges that are currently `valid` or `solved`
-- (and so must have been valid at some point) without such an audit row.
UPDATE challenges
   SET first_valid_at = status_changed_at
 WHERE first_valid_at IS NULL
   AND status IN ('valid', 'solved');

CREATE TABLE IF NOT EXISTS channel_webhooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id  uuid NOT NULL REFERENCES namespaces(id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  format        text NOT NULL CHECK (format IN ('json', 'teams_workflows')),
  url_enc       text NOT NULL,            -- AES-256-GCM under WEBHOOK_ENC_KEY, never plaintext
  url_hint      text NOT NULL,            -- host + last 4 characters, the only form ever shown
  enabled       boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_webhooks_namespace_idx ON channel_webhooks (namespace_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- also the X-InnoBox-Delivery header
  webhook_id        uuid NOT NULL REFERENCES channel_webhooks(id) ON DELETE CASCADE,
  event             text NOT NULL CHECK (event IN ('challenge.validated', 'solution.implemented', 'challenge.solved')),
  entity_type       text NOT NULL CHECK (entity_type IN ('challenge', 'solution')),
  entity_id         uuid NOT NULL,        -- no FK: the §10.3 cascade removes these rows explicitly
  event_status      text NOT NULL,        -- snapshotted at enqueue
  occurred_at       timestamptz NOT NULL, -- the transition time, snapshotted at enqueue
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_http_status  integer,
  last_reason       text,                 -- fixed reason code, never the URL
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

-- The sweep's due scan, the 30-day trim, the §10.3 cascade lookup, and the admin card's
-- "latest delivery" per webhook.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx      ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_finished_idx ON webhook_deliveries (finished_at) WHERE status <> 'pending';
CREATE INDEX IF NOT EXISTS webhook_deliveries_entity_idx   ON webhook_deliveries (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx  ON webhook_deliveries (webhook_id, finished_at DESC);

-- Least-privilege grants: the web tier creates/edits/deletes webhooks and enqueues deliveries;
-- the worker updates delivery rows and trims them; the §10.3 cascade deletes a subtree's rows.
-- The app role already holds UPDATE on challenges, so first_valid_at needs no extra grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON channel_webhooks   TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_deliveries TO innobox_app;
