-- 0042_comment_replies.sql — one-level comment replies (INNOBOX_SPEC.md §10.2, §5). Idempotent.
--
--   thread_root_id — the top-level comment a reply belongs to; null on a top-level comment.
--   reply_to_id    — the comment the reply answers: the root itself or another reply in the same
--                    thread; null on a top-level comment.
--
-- Both are null together or set together. Every comment that existed before this migration stays
-- top-level (both null). The write path (api/comments/store.ts) checks that the target is on the
-- same parent and not soft-deleted, and files a reply-to-a-reply under the same root.
--
-- The self-FKs are NO ACTION: comment rows are hard-deleted only by the §10.3 parent cascade,
-- which removes a parent's whole thread in one statement (threads never span parents), and NO
-- ACTION is checked at the end of that statement.

ALTER TABLE comments ADD COLUMN IF NOT EXISTS thread_root_id uuid REFERENCES comments(id);
ALTER TABLE comments ADD COLUMN IF NOT EXISTS reply_to_id    uuid REFERENCES comments(id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_reply_pair_chk') THEN
    ALTER TABLE comments ADD CONSTRAINT comments_reply_pair_chk
      CHECK ((thread_root_id IS NULL) = (reply_to_id IS NULL));
  END IF;
END $$;

-- The thread view groups replies under their root; the coalesced notification counts replies
-- answering a recipient's comments by looking the target up by id (primary key).
CREATE INDEX IF NOT EXISTS comments_thread_root_idx ON comments (thread_root_id, created_at) WHERE thread_root_id IS NOT NULL;
