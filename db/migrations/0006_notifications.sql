-- 0006_notifications.sql — Phase 3 (INNOBOX_SPEC.md §12): in-app inbox + the e-mail
-- outbox. Every event fires both from the same logical write (§12.1); the in-app row is
-- delivered immediately, the outbox row is swept by the worker (at-least-once, retry).

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  type        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx ON notification_outbox (status, created_at) WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE ON notifications        TO innobox_app;
GRANT SELECT, INSERT, UPDATE ON notification_outbox  TO innobox_app;
