-- 0063_comment_mentions.sql — mentions in a comment (INNOBOX_SPEC.md §44, §44.9).
--
--   comment_mentions — one row per (comment, mentioned person): who mentioned them and when. Unlike
--       solution_mentions (0062) there is no settled_at: a comment can only mention people who can
--       read its thread right now, so everyone is told at the save (§44 decision 8) and a row
--       exists only for someone already told or passed over. An edit never deletes a row — it is
--       the marker that this person has had their one notice for this comment (§44 decision 12).
--       The app role updates only mentioned_by (nulled when the commenter is erased); DELETE serves
--       the §10.3 cascade (ON DELETE CASCADE with the comment) and the §3 erasure. The caps (10 per
--       comment; 30 new a UTC day per author, ONE budget with solution_mentions) are the API's,
--       under the per-author advisory lock of §43.5.
--   comments.body — from this migration on it holds STORED text (§44.5): the Markdown as written,
--       with each mention the character U+E000, the person's user id and the character U+E001 —
--       never their name. The API strips both characters from every submitted body, and existing
--       rows contain neither, so nothing is rewritten. There is no format column (§44 decision 5):
--       every comment renders as Markdown.
--   The two partial indexes serve §44.6 "a removed comment": deleting a comment deletes its
--       event-27 inbox rows and its unsent outbox rows, found by the comment's id in the payload.
--
-- `notifications.type` is unconstrained, so the new `mentioned_in_comment` type (event 27) needs no
-- DDL. users.notify_mentions (0062) is reused as the one *Mentions* preference (§44.6).

CREATE TABLE IF NOT EXISTS comment_mentions (
  comment_id    uuid NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id),
  mentioned_by  uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id),
  CONSTRAINT comment_mentions_not_self CHECK (mentioned_by IS NULL OR mentioned_by <> user_id)
);
-- The daily cap counts by sender and day; the erasure finds a person's rows by either side.
CREATE INDEX IF NOT EXISTS comment_mentions_sender_idx ON comment_mentions (mentioned_by, created_at);
CREATE INDEX IF NOT EXISTS comment_mentions_user_idx ON comment_mentions (user_id);

GRANT SELECT, INSERT, DELETE ON comment_mentions TO innobox_app;  -- DELETE: §10.3, §3
GRANT UPDATE (mentioned_by) ON comment_mentions TO innobox_app;

CREATE INDEX IF NOT EXISTS notifications_comment_mention_idx
  ON notifications ((payload->>'commentId'))
  WHERE type = 'mentioned_in_comment';
CREATE INDEX IF NOT EXISTS notification_outbox_comment_mention_idx
  ON notification_outbox ((payload->>'commentId'))
  WHERE type = 'mentioned_in_comment';
