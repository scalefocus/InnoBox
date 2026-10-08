-- 0028_audit_chain.sql — hash-chained audit rows (INNOBOX_SPEC.md §15 "Hash chain", §5
-- audit_log, §2.1 invariant 5). Every audit row written from this migration onward carries
-- chain_seq / prev_hash / row_hash, computed IN THE DATABASE by the BEFORE INSERT trigger
-- audit_log_chain (never by the caller — any supplied value is overwritten). Rows written before
-- this migration stay unchained: back-filling them would need the very UPDATE invariant 5 forbids.
--
-- Canonical form v1 (§15): row_hash = lower-hex sha256(utf8(C)), C = 'innobox-audit-v1\n' then ten
-- fields in this order — chain_seq, id, created_at, actor_user_id, action, target_type, target_id,
-- before, after, prev_hash — each '~\n' when SQL NULL, else '<utf8 byte length>:<value>\n'.
-- created_at is UTC 'YYYY-MM-DDTHH:MM:SS.ffffffZ'; before/after are jsonb::text. The web verifier
-- (packages/shared/src/audit-chain.ts) recomputes this independently from the fields read as text.
--
-- Concurrency: the trigger takes a transaction-scoped advisory lock (held to commit) on
-- hashtextextended('innobox:audit_log_chain', 0) — distinct from the worker's leader key — so
-- audit writes from web and worker serialize and each reads a committed head. It refuses to run
-- outside READ COMMITTED. The chain trigger must NEVER be dropped or bypassed (README.md).
--
-- One transaction: the ALTER TABLE lock blocks concurrent audit writes until the genesis row is
-- in. Idempotent: IF NOT EXISTS columns/index, a guarded constraint, CREATE OR REPLACE functions,
-- DROP IF EXISTS + CREATE trigger, and the genesis row only when no chained row exists yet.
-- Grants are unchanged: innobox_app keeps SELECT, INSERT (0002) — the new columns are covered.

BEGIN;

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS row_hash  text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'audit_log'::regclass AND conname = 'audit_log_chain_shape'
  ) THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_chain_shape CHECK (
      (chain_seq IS NULL AND prev_hash IS NULL AND row_hash IS NULL)
      OR (chain_seq IS NOT NULL AND chain_seq >= 1
          AND prev_hash ~ '^[0-9a-f]{64}$' AND row_hash ~ '^[0-9a-f]{64}$')
    );
  END IF;
END $$;

-- Unique where set: a fork (two rows claiming one position) is impossible. Also the keyset index
-- the verification walk pages over.
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_seq_key ON audit_log (chain_seq) WHERE chain_seq IS NOT NULL;

-- One canonical field: '~\n' for SQL NULL, else '<utf8 byte length>:<value>\n'.
CREATE OR REPLACE FUNCTION audit_log_chain_field(v text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN v IS NULL THEN E'~\n'
              ELSE octet_length(convert_to(v, 'UTF8'))::text || ':' || v || E'\n' END
$$;

-- row_hash over the canonical form v1. Exposed as a function so the dbtest can check the shared
-- test vector against the database; the web verifier never calls it (independent recomputation).
CREATE OR REPLACE FUNCTION audit_log_row_hash(
  p_chain_seq bigint, p_id bigint, p_created_at timestamptz, p_actor_user_id uuid,
  p_action text, p_target_type text, p_target_id text, p_before jsonb, p_after jsonb,
  p_prev_hash text
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
           E'innobox-audit-v1\n'
           || audit_log_chain_field(p_chain_seq::text)
           || audit_log_chain_field(p_id::text)
           || audit_log_chain_field(to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
           || audit_log_chain_field(p_actor_user_id::text)
           || audit_log_chain_field(p_action)
           || audit_log_chain_field(p_target_type)
           || audit_log_chain_field(p_target_id)
           || audit_log_chain_field(p_before::text)
           || audit_log_chain_field(p_after::text)
           || audit_log_chain_field(p_prev_hash),
         'UTF8')), 'hex')
$$;

CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head_seq  bigint;
  head_hash text;
BEGIN
  -- Under a fixed snapshot the head read could be stale (the unique index would then reject the
  -- insert anyway); refuse outright so the failure is explicit.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit_log inserts must run under READ COMMITTED (audit hash chain)';
  END IF;

  -- Serialize chain appends; held until commit, so the next writer reads a committed head.
  PERFORM pg_advisory_xact_lock(hashtextextended('innobox:audit_log_chain', 0));

  -- A fresh snapshot per statement (READ COMMITTED, volatile function): sees the committed head
  -- and this transaction's own earlier rows, including earlier rows of a multi-row INSERT.
  SELECT a.chain_seq, a.row_hash INTO head_seq, head_hash
    FROM audit_log a
   WHERE a.chain_seq IS NOT NULL
   ORDER BY a.chain_seq DESC
   LIMIT 1;

  IF head_seq IS NULL THEN
    NEW.chain_seq := 1;                 -- the genesis row: the only head read that finds nothing
    NEW.prev_hash := repeat('0', 64);
  ELSE
    NEW.chain_seq := head_seq + 1;
    NEW.prev_hash := head_hash;
  END IF;

  -- Overwrites whatever an INSERT supplied.
  NEW.row_hash := audit_log_row_hash(
    NEW.chain_seq, NEW.id, NEW.created_at, NEW.actor_user_id, NEW.action, NEW.target_type,
    NEW.target_id, NEW.before, NEW.after, NEW.prev_hash);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- The genesis row (once): records the pre-chain baseline the verifier's final "unchained" check
-- compares against. Actor NULL (system); the trigger chains it as chain_seq 1.
DO $$
DECLARE
  n_unchained bigint;
  last_id     bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE chain_seq IS NOT NULL) THEN
    SELECT count(*), max(id) INTO n_unchained, last_id FROM audit_log WHERE chain_seq IS NULL;
    INSERT INTO audit_log (actor_user_id, action, target_type, target_id, before, after)
    VALUES (NULL, 'audit.chain_started', 'audit_log', NULL, NULL,
            jsonb_build_object('unchainedCount', n_unchained, 'lastUnchainedId', last_id));
  END IF;
END $$;

COMMIT;
