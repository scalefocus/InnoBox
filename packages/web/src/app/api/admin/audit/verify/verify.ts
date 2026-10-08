// "Verify integrity" (INNOBOX_SPEC.md §15): walks the audit hash chain in chain_seq order, in
// keyset pages of 5 000, up to the head captured when the run starts, and recomputes every row's
// hash INDEPENDENTLY in this process from the fields read as text (never by calling the trigger's
// function) — so a defect or tampering in that function shows up as a break. Stops at the first
// failure. Rows are immutable, so no long transaction is needed.
// Every run is audited as `audit.verified` (actor = the admin; aborted runs too) — the second
// audited read, deliberately. One run per web process at a time.
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import {
  AUDIT_VERIFY_PAGE_SIZE,
  AUDIT_VERIFY_PROGRESS_EVERY,
  AuditChainVerifier,
  appendAudit,
  type AuditChainBreak,
  type AuditChainStoredRow,
} from "@innobox/shared";

/** pg Pool / PoolClient / Client all satisfy this. */
export interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AuditChainHead {
  chainSeq: number;
  rowHash: string;
}

export interface AuditVerifyOutcome {
  result: "intact" | "broken" | "aborted";
  /** Chained rows that passed every check. */
  checked: number;
  /** The head captured when the run started (null when no chained row exists at all). */
  head: AuditChainHead | null;
  firstBreak: AuditChainBreak | null;
}

export interface VerifyOptions {
  signal?: AbortSignal;
  onStart?: (headChainSeq: number) => void;
  onProgress?: (checked: number) => void;
  pageSize?: number;
  progressEvery?: number;
}

interface ChainRow {
  chain_seq: string;
  id: string;
  created_at: string;
  actor_user_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before: string | null;
  after: string | null;
  prev_hash: string;
  row_hash: string;
}

// Every field as TEXT, exactly as the canonical form defines it (jsonb via ::text, never a
// re-serialized parsed object; created_at as UTC with six fractional digits). ORDER BY uses the
// QUALIFIED a.chain_seq: a bare name would bind to the ::text output alias and sort lexically.
const PAGE_SQL = `select chain_seq::text as chain_seq, id::text as id,
         to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
         actor_user_id::text as actor_user_id, action, target_type, target_id,
         before::text as before, after::text as after, prev_hash, row_hash
    from audit_log a
   where a.chain_seq is not null and a.chain_seq <= $1::bigint
     and (a.chain_seq, a.id) > ($2::bigint, $3::bigint)
   order by a.chain_seq, a.id
   limit $4`;

function toStored(r: ChainRow): AuditChainStoredRow {
  return {
    chainSeq: r.chain_seq,
    id: r.id,
    createdAt: r.created_at,
    actorUserId: r.actor_user_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    before: r.before,
    after: r.after,
    prevHash: r.prev_hash,
    rowHash: r.row_hash,
  };
}

/** Walks and checks the chain. Never writes. Returns `aborted` when the signal fires mid-run. */
export async function verifyAuditChain(db: Queryable, opts: VerifyOptions = {}): Promise<AuditVerifyOutcome> {
  const pageSize = Math.max(1, opts.pageSize ?? AUDIT_VERIFY_PAGE_SIZE);
  const progressEvery = Math.max(1, opts.progressEvery ?? AUDIT_VERIFY_PROGRESS_EVERY);
  const verifier = new AuditChainVerifier();

  const { rows: headRows } = await db.query<{ chain_seq: string; row_hash: string }>(
    `select chain_seq::text as chain_seq, row_hash from audit_log a where a.chain_seq is not null order by a.chain_seq desc limit 1`,
  );
  const head: AuditChainHead | null = headRows[0] ? { chainSeq: Number(headRows[0].chain_seq), rowHash: headRows[0].row_hash } : null;
  opts.onStart?.(head?.chainSeq ?? 0);

  const outcome = (result: AuditVerifyOutcome["result"]): AuditVerifyOutcome => ({
    result,
    checked: verifier.checked,
    head,
    firstBreak: result === "aborted" ? null : verifier.firstBreak,
  });

  if (!head) {
    verifier.markEmpty();
    return outcome("broken");
  }

  let cursor: { seq: string; id: string } = { seq: "0", id: "0" };
  let nextProgress = progressEvery;
  for (;;) {
    if (opts.signal?.aborted) return outcome("aborted");
    const { rows } = await db.query<ChainRow>(PAGE_SQL, [String(head.chainSeq), cursor.seq, cursor.id, pageSize]);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (!verifier.push(toStored(r))) return outcome("broken");
      if (verifier.checked >= nextProgress) {
        opts.onProgress?.(verifier.checked);
        nextProgress += progressEvery;
      }
    }
    const last = rows[rows.length - 1]!;
    cursor = { seq: last.chain_seq, id: last.id };
    if (rows.length < pageSize) break;
  }
  if (opts.signal?.aborted) return outcome("aborted");

  // The walk ended short of the captured head: the tail is missing.
  if (verifier.checked < head.chainSeq && !verifier.firstBreak) {
    // (Only reachable when rows at the end were removed after the head read; the head row itself
    // is then gone too — report it as a sequence break at the head position.)
    return {
      result: "broken",
      checked: verifier.checked,
      head,
      firstBreak: { id: null, chainSeq: head.chainSeq, check: "sequence", expected: head.chainSeq, actual: verifier.checked },
    };
  }

  // Finally, the pre-chain rows must be exactly the genesis row's baseline.
  const genesis = verifier.genesis;
  if (genesis) {
    const { rows: u } = await db.query<{ n: string; offending: string | null }>(
      `select count(*)::text as n,
              (select min(id)::text from audit_log where chain_seq is null and id > coalesce($1::bigint, 0)) as offending
         from audit_log where chain_seq is null`,
      [genesis.lastUnchainedId],
    );
    if (!verifier.checkUnchained(Number(u[0]?.n ?? 0), u[0]?.offending ?? null)) return outcome("broken");
  }
  return outcome(verifier.firstBreak ? "broken" : "intact");
}

// ── One run per web process ──

let active = false;

/** Claims the process-wide verification slot; false when a run is already active. */
export function tryBeginVerification(): boolean {
  if (active) return false;
  active = true;
  return true;
}

export function endVerification(): void {
  active = false;
}

/** Runs one verification and audits it as `audit.verified` — whatever the outcome, including a
 *  run the client abandoned (`aborted`) or one a database error cut short (also `aborted`; the
 *  error is rethrown after the audit row is written). The audit row joins the chain after the
 *  head it verified. */
export async function runAuditVerification(
  db: Queryable,
  actorUserId: string,
  opts: VerifyOptions = {},
): Promise<AuditVerifyOutcome> {
  let outcome: AuditVerifyOutcome = { result: "aborted", checked: 0, head: null, firstBreak: null };
  let failure: unknown = null;
  try {
    outcome = await verifyAuditChain(db, opts);
  } catch (err) {
    failure = err;
  }
  await appendAudit(db as Parameters<typeof appendAudit>[0], {
    actorUserId,
    action: "audit.verified",
    targetType: "audit_log",
    after: {
      result: outcome.result,
      checked: outcome.checked,
      headChainSeq: outcome.head?.chainSeq ?? null,
      firstBreak: outcome.firstBreak,
    },
  });
  if (failure) throw failure;
  return outcome;
}
