// Audit hash chain (INNOBOX_SPEC.md §15 "Hash chain", invariant 5): the canonical serialization
// v1 and the INDEPENDENT recomputation the web "Verify integrity" run uses. The database computes
// row_hash in the `audit_log_chain` trigger (db/migrations/0028_audit_chain.sql); this module
// reproduces it from the fields read as text, never by calling the trigger's function, so a
// defect or tampering in that function surfaces as a break instead of being reproduced.
// Server-only (node:crypto) — not exposed at a client subpath.
import { createHash } from "node:crypto";

/** The first line of every canonical form (the version tag). */
export const AUDIT_CHAIN_VERSION_LINE = "innobox-audit-v1\n";
/** The genesis row's `prev_hash`: 64 zeros. */
export const AUDIT_CHAIN_GENESIS_PREV_HASH = "0".repeat(64);
/** The genesis row's action, written once by the chain migration. */
export const AUDIT_CHAIN_GENESIS_ACTION = "audit.chain_started";
/** Keyset page size for the verification walk. */
export const AUDIT_VERIFY_PAGE_SIZE = 5_000;
/** A `progress` NDJSON line is emitted every this many checked rows. */
export const AUDIT_VERIFY_PROGRESS_EVERY = 10_000;

export const AUDIT_HASH_RE = /^[0-9a-f]{64}$/;

/** One chained row as the verifier reads it: every field as TEXT, exactly as §15 defines —
 *  `chain_seq::text`, `id::text`, `to_char(created_at at time zone 'UTC', …US"Z")`,
 *  `actor_user_id::text`, the stored strings, and `before::text` / `after::text` (PostgreSQL's
 *  own jsonb output, never a re-serialized parsed object). SQL NULL is `null`. */
export interface AuditChainRowText {
  chainSeq: string;
  id: string;
  createdAt: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  before: string | null;
  after: string | null;
  prevHash: string;
}

function field(value: string | null): string {
  if (value === null) return "~\n";
  return `${Buffer.byteLength(value, "utf8")}:${value}\n`;
}

/** The canonical form C (v1): the version line, then ten length-prefixed fields in fixed order. */
export function canonicalAuditRow(row: AuditChainRowText): string {
  return (
    AUDIT_CHAIN_VERSION_LINE +
    field(row.chainSeq) +
    field(row.id) +
    field(row.createdAt) +
    field(row.actorUserId) +
    field(row.action) +
    field(row.targetType) +
    field(row.targetId) +
    field(row.before) +
    field(row.after) +
    field(row.prevHash)
  );
}

/** row_hash = lowercase hex sha256(utf8(C)). */
export function auditRowHash(row: AuditChainRowText): string {
  return createHash("sha256").update(canonicalAuditRow(row), "utf8").digest("hex");
}

/** Known-answer vectors for canonical form v1. The shared unit test checks the JS recomputation
 *  against them and the web dbtest checks the database's `audit_log_row_hash()` against the same
 *  values, so the trigger and the verifier provably agree. Covers a multi-byte value, an embedded
 *  newline, SQL NULL vs the empty string, and SQL NULL vs JSON `null`. */
export const AUDIT_CHAIN_TEST_VECTORS: ReadonlyArray<{ row: AuditChainRowText; rowHash: string }> = [
  {
    row: {
      chainSeq: "42",
      id: "1337",
      createdAt: "2026-01-02T03:04:05.000006Z",
      actorUserId: "0f8e2c4a-1b2d-4e5f-8a9b-0c1d2e3f4a5b",
      action: "challenge.status_changed",
      targetType: "challenge",
      targetId: "line1\nline2 é",
      before: null,
      after: '{"to": "valid", "from": "awaiting_triage", "note": "Ünïcødé ✓"}',
      prevHash: "ab".repeat(32),
    },
    rowHash: "948d2b97fc8730af22001ae4aa382abb120093dcb5f674483cbe6328cac660d4",
  },
  {
    row: {
      chainSeq: "1",
      id: "7",
      createdAt: "2025-12-31T23:59:59.000000Z",
      actorUserId: null,
      action: "audit.chain_started",
      targetType: "audit_log",
      targetId: "",
      before: "null",
      after: null,
      prevHash: "0".repeat(64),
    },
    rowHash: "05d0d13300fb988db512f14ff6b5e19014efd4a4e7ac13ab5f827355b7cc60cd",
  },
];

// ── The verification state machine (pure; the web store feeds it rows in chain_seq order) ──

export type AuditChainCheck = "genesis" | "sequence" | "link" | "content" | "unchained";

export interface AuditChainBreak {
  /** The offending row's id (null for a count-only `unchained` break or an empty chain). */
  id: string | null;
  chainSeq: number | null;
  check: AuditChainCheck;
  expected: string | number | null;
  actual: string | number | null;
}

/** A chained row plus its stored row_hash. */
export interface AuditChainStoredRow extends AuditChainRowText {
  rowHash: string;
}

export interface AuditGenesisInfo {
  unchainedCount: number;
  lastUnchainedId: string | null;
}

/** Feeds rows in chain_seq order; reports the FIRST failure and nothing after it. */
export class AuditChainVerifier {
  private prev: { chainSeq: number; rowHash: string } | null = null;
  private _checked = 0;
  private _break: AuditChainBreak | null = null;
  private _genesis: AuditGenesisInfo | null = null;

  get checked(): number {
    return this._checked;
  }
  get firstBreak(): AuditChainBreak | null {
    return this._break;
  }
  /** The genesis row's unchained-row baseline (once the genesis row has been checked). */
  get genesis(): AuditGenesisInfo | null {
    return this._genesis;
  }

  /** Checks one row. Returns false once a break is found (stop feeding). */
  push(row: AuditChainStoredRow): boolean {
    if (this._break) return false;
    const seq = Number(row.chainSeq);
    const fail = (check: AuditChainCheck, expected: string | number | null, actual: string | number | null): false => {
      this._break = { id: row.id, chainSeq: Number.isFinite(seq) ? seq : null, check, expected, actual };
      return false;
    };

    if (this.prev === null) {
      // The genesis row: chain_seq 1, action audit.chain_started, an all-zero prev_hash.
      if (seq !== 1) return fail("sequence", 1, seq);
      if (row.prevHash !== AUDIT_CHAIN_GENESIS_PREV_HASH) return fail("link", AUDIT_CHAIN_GENESIS_PREV_HASH, row.prevHash);
      if (row.action !== AUDIT_CHAIN_GENESIS_ACTION) return fail("genesis", AUDIT_CHAIN_GENESIS_ACTION, row.action);
      const computed = auditRowHash(row);
      if (computed !== row.rowHash) return fail("content", computed, row.rowHash);
      const info = parseGenesisAfter(row.after);
      if (!info) return fail("genesis", "unchainedCount", row.after);
      this._genesis = info;
    } else {
      if (seq !== this.prev.chainSeq + 1) return fail("sequence", this.prev.chainSeq + 1, seq);
      if (row.prevHash !== this.prev.rowHash) return fail("link", this.prev.rowHash, row.prevHash);
      const computed = auditRowHash(row);
      if (computed !== row.rowHash) return fail("content", computed, row.rowHash);
    }
    this.prev = { chainSeq: seq, rowHash: row.rowHash };
    this._checked += 1;
    return true;
  }

  /** The final check over the pre-chain rows. `offendingId` is the lowest unchained id above the
   *  genesis row's `lastUnchainedId` (null when none). Returns false on a break. */
  checkUnchained(actualCount: number, offendingId: string | null): boolean {
    if (this._break) return false;
    if (!this._genesis) return true;
    if (offendingId !== null) {
      this._break = { id: offendingId, chainSeq: null, check: "unchained", expected: this._genesis.lastUnchainedId, actual: offendingId };
      return false;
    }
    if (actualCount !== this._genesis.unchainedCount) {
      this._break = { id: null, chainSeq: null, check: "unchained", expected: this._genesis.unchainedCount, actual: actualCount };
      return false;
    }
    return true;
  }

  /** An empty chain (no genesis row at all) is itself a break. */
  markEmpty(): void {
    if (!this._break) this._break = { id: null, chainSeq: null, check: "genesis", expected: AUDIT_CHAIN_GENESIS_ACTION, actual: null };
  }
}

/** Reads `{ unchainedCount, lastUnchainedId }` off the genesis row's `after` text. */
export function parseGenesisAfter(after: string | null): AuditGenesisInfo | null {
  if (after === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(after);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const count = o.unchainedCount;
  const last = o.lastUnchainedId;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  if (last !== null && typeof last !== "number" && typeof last !== "string") return null;
  return { unchainedCount: count, lastUnchainedId: last === null ? null : String(last) };
}
