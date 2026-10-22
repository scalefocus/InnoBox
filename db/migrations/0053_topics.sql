-- 0053_topics.sql — curated topics a person can follow (INNOBOX_SPEC.md §34, §34.8).
--
--   topics            — the platform-admin-curated list (§34.2): a name unique case-insensitively
--                       across every topic, retired ones included, an optional description and an
--                       active flag. No seed: a deployment starts with none. DELETE serves the
--                       retired-topic delete only.
--   challenge_topics  — the up-to-three topics of each challenge (§34.3). The cap is the API's, as
--                       the access list's is. DELETE: a topic is removed from a challenge by
--                       deleting its row; the §10.3 cascade and the topic delete use it too.
--   topic_follows     — who follows which topic (§34.4). Private: no surface lists the followers.
--   topic_notices     — one row per person ever told about a challenge (§34.5, §12.1 event 18),
--                       written with the event's inbox row or with event 15's. DELETE serves the
--                       §10.3 cascade and the §3 erasure only.
--
-- The FKs to challenges and users carry no ON DELETE action: the §10.3 cascade and the §3
-- erasure remove these rows explicitly, as they do every other child row.

CREATE TABLE IF NOT EXISTS topics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  description  text CHECK (description IS NULL OR char_length(description) <= 200),
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS topics_name_lower_idx ON topics (lower(name));

CREATE TABLE IF NOT EXISTS challenge_topics (
  challenge_id  uuid NOT NULL REFERENCES challenges(id),
  topic_id      uuid NOT NULL REFERENCES topics(id),
  added_by      uuid REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, topic_id)
);
CREATE INDEX IF NOT EXISTS challenge_topics_topic_idx ON challenge_topics (topic_id);

CREATE TABLE IF NOT EXISTS topic_follows (
  user_id     uuid NOT NULL REFERENCES users(id),
  topic_id    uuid NOT NULL REFERENCES topics(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, topic_id)
);
CREATE INDEX IF NOT EXISTS topic_follows_topic_idx ON topic_follows (topic_id);

CREATE TABLE IF NOT EXISTS topic_notices (
  challenge_id  uuid NOT NULL REFERENCES challenges(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  notified_at   timestamptz NOT NULL DEFAULT now(),
  via           text NOT NULL CHECK (via IN ('opening', 'topic_added', 'widened', 'shared')),
  PRIMARY KEY (challenge_id, user_id)
);
CREATE INDEX IF NOT EXISTS topic_notices_user_idx ON topic_notices (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON topics           TO innobox_app;
GRANT SELECT, INSERT, DELETE         ON challenge_topics TO innobox_app;
GRANT SELECT, INSERT, DELETE         ON topic_follows    TO innobox_app;
GRANT SELECT, INSERT, DELETE         ON topic_notices    TO innobox_app;  -- DELETE: §10.3 cascade + §3 erasure only
