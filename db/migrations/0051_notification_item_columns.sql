-- 0051_notification_item_columns.sql — what an inbox row is about, as real columns
-- (INNOBOX_SPEC.md §5 `notifications`, §12.1 read-time gate, §10.4 trash, v1.18).
--
--   notifications gains challenge_id and solution_id (nullable uuid). A challenge row sets
--   challenge_id; a solution row sets solution_id AND its parent's challenge_id; comment and hype
--   rows the same way from their parent; a bound attachment's scan failure from the attachment's
--   parent. Rows that name no item (achievements, staged scan failures, system.error,
--   assignments_transferred) leave both null. Lookup keys, not foreign keys: the §10.3 cascade
--   deletes the rows explicitly, as it always has.
--
--   They are DERIVED, never supplied: the BEFORE INSERT / UPDATE OF payload trigger
--   notifications_item_ids computes both from the payload's target keys on every write (any
--   value a caller passes is overwritten), so no writer — web, worker, shared, a test fixture —
--   can forget them, and a coalescing upsert keeps them right. The derivation, in order:
--     1. parentType 'solution' + parentId  → that solution and its challenge;
--     2. parentType 'challenge' + parentId → that challenge;
--     3. challengeId (comment/hype rows)   → that challenge;
--     4. the deep link, for rows that carry nothing else: '/challenges/<n>' → challenge n,
--        '…#SOL-<m>' → solution m under it.
--   An id that does not resolve to an existing row leaves the column null.
--
--   The read-time gates (§12.1 visibility, §10.4 trash) and the §10.3 cascade now join on these
--   columns by primary key instead of matching payload text against every challenge.
--
--   Indexes: (user_id, challenge_id) WHERE read_at IS NULL serves "opening the challenge reads its
--   rows" (comment_posted + hyped) and replaces the two per-type payload-expression indexes from
--   0026 and 0050; (challenge_id) and (solution_id) partials serve the cascade and trash lookups.
--   The coalescing UNIQUE indexes on the payload keys stay — they key the upsert, not a filter.
--
-- Idempotent: IF NOT EXISTS columns/indexes, CREATE OR REPLACE function, DROP IF EXISTS + CREATE
-- trigger, and the backfill only touches rows whose columns are still both null.

BEGIN;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS challenge_id uuid;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS solution_id  uuid;

-- The derivation, shared by the trigger and the backfill. STABLE: reads challenges/solutions only.
-- OUT parameters are prefixed so they can never be confused with the challenge_id columns.
CREATE OR REPLACE FUNCTION notification_item_ids(p jsonb, OUT out_challenge_id uuid, OUT out_solution_id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  uuid_re  constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  ptype    text := p->>'parentType';
  pid      uuid;
  cid      uuid;
  link     text := p->>'link';
  ch_num   text;
  sol_num  text;
BEGIN
  IF p->>'parentId' ~ uuid_re THEN pid := (p->>'parentId')::uuid; END IF;
  IF p->>'challengeId' ~ uuid_re THEN cid := (p->>'challengeId')::uuid; END IF;

  IF ptype = 'solution' AND pid IS NOT NULL THEN
    SELECT s.id, s.challenge_id INTO out_solution_id, out_challenge_id FROM solutions s WHERE s.id = pid;
  ELSIF ptype = 'challenge' AND pid IS NOT NULL THEN
    SELECT c.id INTO out_challenge_id FROM challenges c WHERE c.id = pid;
  END IF;

  IF out_challenge_id IS NULL AND cid IS NOT NULL THEN
    SELECT c.id INTO out_challenge_id FROM challenges c WHERE c.id = cid;
  END IF;

  IF out_challenge_id IS NULL AND link IS NOT NULL THEN
    ch_num := substring(link from '^/challenges/([0-9]{1,18})(?:#|$)');
    IF ch_num IS NOT NULL THEN
      SELECT c.id INTO out_challenge_id FROM challenges c WHERE c.number = ch_num::bigint;
      sol_num := substring(link from '#SOL-([0-9]{1,18})$');
      IF out_challenge_id IS NOT NULL AND out_solution_id IS NULL AND sol_num IS NOT NULL THEN
        SELECT s.id INTO out_solution_id FROM solutions s
         WHERE s.number = sol_num::bigint AND s.challenge_id = out_challenge_id;
      END IF;
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION notifications_item_ids() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT d.out_challenge_id, d.out_solution_id INTO NEW.challenge_id, NEW.solution_id
    FROM notification_item_ids(NEW.payload) d;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notifications_item_ids ON notifications;
CREATE TRIGGER notifications_item_ids
  BEFORE INSERT OR UPDATE OF payload ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_item_ids();

-- Backfill once. Only the id columns are written, so the UPDATE OF payload trigger does not fire.
UPDATE notifications n
   SET challenge_id = d.out_challenge_id, solution_id = d.out_solution_id
  FROM notifications src
  CROSS JOIN LATERAL notification_item_ids(src.payload) d
 WHERE src.id = n.id
   AND n.challenge_id IS NULL AND n.solution_id IS NULL
   AND (d.out_challenge_id IS NOT NULL OR d.out_solution_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS notifications_user_challenge_unread_idx
  ON notifications (user_id, challenge_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_challenge_idx
  ON notifications (challenge_id) WHERE challenge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_solution_idx
  ON notifications (solution_id) WHERE solution_id IS NOT NULL;

-- Superseded by notifications_user_challenge_unread_idx (no query filters on payload->>'challengeId').
DROP INDEX IF EXISTS notifications_comment_challenge_idx;
DROP INDEX IF EXISTS notifications_hyped_challenge_idx;

COMMIT;
