-- 0026_comment_coalescing.sql — coalesced comment notifications (INNOBOX_SPEC.md §12.1, §5).
--
-- Comment notifications (event 6, type `comment_posted`) are ONE inbox row per recipient per item
-- while unread. This partial unique index is what lets the write path be a single atomic
-- `insert … on conflict … do update` — the first comment inserts the row (and its outbox row, so
-- one e-mail), every further comment on the same item refreshes it in place (count, latest
-- commenter, re-sorted to the top) without a new outbox row. Once read, the predicate no longer
-- matches and the next comment starts a fresh row.
--
-- Rows written before this migration carry no parentType/parentId in their payload; NULLs are
-- distinct in a unique index, so they can never collide and need no clean-up.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_comment_coalesce_idx
  ON notifications (user_id, (payload->>'parentType'), (payload->>'parentId'))
  WHERE read_at IS NULL AND type = 'comment_posted';

-- "Opening the challenge page reads its comment rows" looks rows up by the parent challenge.
CREATE INDEX IF NOT EXISTS notifications_comment_challenge_idx
  ON notifications (user_id, (payload->>'challengeId'))
  WHERE read_at IS NULL AND type = 'comment_posted';
