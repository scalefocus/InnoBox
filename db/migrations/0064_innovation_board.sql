-- 0064_innovation_board.sql — the innovation board (INNOBOX_SPEC.md §45, §45.9).
--
--   innovation_board_members — one row per member of the one platform-wide board: who added them and
--       when. A member reads `awaiting_triage` challenges and `proposed` solutions wherever the §4.3
--       visibility rule already admits them (§45.3) and is told of every new challenge and solution
--       (§12.1 events 1 and 2, §45.5). It is a grant made inside the app by a platform admin — like
--       a challenge's assignee and a `people` access list — and never a token claim (invariant 1).
--       The app role inserts and deletes rows (add, remove, the §3 erasure) and updates only
--       added_by, which the erasure nulls when the admin who added someone is erased. The cap of 100
--       is the API's, under an advisory lock (§45.10).
--
-- `notifications.type` is unconstrained, so the new `innovation_board_added` type (event 28) needs no
-- DDL. The board's rows of events 1 and 2 keep their existing types.

CREATE TABLE IF NOT EXISTS innovation_board_members (
  user_id   uuid PRIMARY KEY REFERENCES users(id),
  added_by  uuid REFERENCES users(id),
  added_at  timestamptz NOT NULL DEFAULT now()
);
-- The erasure finds the rows an admin added by `added_by`.
CREATE INDEX IF NOT EXISTS innovation_board_members_added_by_idx ON innovation_board_members (added_by);

GRANT SELECT, INSERT, DELETE ON innovation_board_members TO innobox_app;  -- DELETE: a removal, §3
GRANT UPDATE (added_by) ON innovation_board_members TO innobox_app;
