// Unit tests for the §15 audit hash chain: canonical form v1, hash recomputation (known-answer
// vectors shared with the web dbtest, which checks the database trigger against the same values),
// and the verification state machine's first-break reporting.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_CHAIN_GENESIS_PREV_HASH,
  AUDIT_CHAIN_TEST_VECTORS,
  AuditChainVerifier,
  auditRowHash,
  canonicalAuditRow,
  parseGenesisAfter,
  type AuditChainRowText,
  type AuditChainStoredRow,
} from "./audit-chain.js";

test("canonical form v1: version line, ten length-prefixed fields, ~ for SQL NULL", () => {
  const row: AuditChainRowText = {
    chainSeq: "3",
    id: "10",
    createdAt: "2026-01-01T00:00:00.000000Z",
    actorUserId: null,
    action: "a.b",
    targetType: "t",
    targetId: "",
    before: "null",
    after: '{"k": "é"}',
    prevHash: "f".repeat(64),
  };
  assert.equal(
    canonicalAuditRow(row),
    "innobox-audit-v1\n" +
      "1:3\n" +
      "2:10\n" +
      "27:2026-01-01T00:00:00.000000Z\n" +
      "~\n" +
      "3:a.b\n" +
      "1:t\n" +
      "0:\n" + // the empty string is distinct from NULL
      "4:null\n" + // JSON null is the four-byte string, not ~
      "11:{\"k\": \"é\"}\n" + // length in UTF-8 BYTES (é is two)
      `64:${"f".repeat(64)}\n`,
  );
});

test("the length prefix makes embedded newlines and colons unambiguous", () => {
  const base: AuditChainRowText = {
    chainSeq: "1",
    id: "1",
    createdAt: "2026-01-01T00:00:00.000000Z",
    actorUserId: null,
    action: "x",
    targetType: "y",
    targetId: "a\n1:b",
    before: null,
    after: null,
    prevHash: AUDIT_CHAIN_GENESIS_PREV_HASH,
  };
  const shifted = { ...base, targetId: "a", before: "b" };
  assert.notEqual(auditRowHash(base), auditRowHash(shifted));
  assert.notEqual(auditRowHash({ ...base, targetId: null }), auditRowHash({ ...base, targetId: "" }));
});

test("known-answer vectors (the dbtest checks the trigger against the same values)", () => {
  for (const v of AUDIT_CHAIN_TEST_VECTORS) {
    const h = auditRowHash(v.row);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, v.rowHash, `vector chain_seq ${v.row.chainSeq}`);
  }
});

// ── Verifier ──

function chain(n: number, unchained = { count: 2, last: "5" }): AuditChainStoredRow[] {
  const rows: AuditChainStoredRow[] = [];
  let prev = AUDIT_CHAIN_GENESIS_PREV_HASH;
  for (let i = 1; i <= n; i++) {
    const text: AuditChainRowText = {
      chainSeq: String(i),
      id: String(100 + i),
      createdAt: "2026-02-03T04:05:06.123456Z",
      actorUserId: i === 1 ? null : "11111111-2222-4333-8444-555555555555",
      action: i === 1 ? "audit.chain_started" : `test.row_${i}`,
      targetType: i === 1 ? "audit_log" : "test",
      targetId: i === 1 ? null : `t-${i}`,
      before: null,
      after: i === 1 ? JSON.stringify({ unchainedCount: unchained.count, lastUnchainedId: Number(unchained.last) }) : `{"i": ${i}}`,
      prevHash: prev,
    };
    const rowHash = auditRowHash(text);
    rows.push({ ...text, rowHash });
    prev = rowHash;
  }
  return rows;
}

function run(rows: AuditChainStoredRow[]): AuditChainVerifier {
  const v = new AuditChainVerifier();
  for (const r of rows) if (!v.push(r)) break;
  return v;
}

test("an intact chain verifies every row and passes the unchained baseline", () => {
  const v = run(chain(6));
  assert.equal(v.firstBreak, null);
  assert.equal(v.checked, 6);
  assert.deepEqual(v.genesis, { unchainedCount: 2, lastUnchainedId: "5" });
  assert.equal(v.checkUnchained(2, null), true);
  assert.equal(v.firstBreak, null);
});

test("content: an edited payload breaks at that row, with both hashes", () => {
  const rows = chain(5);
  rows[2] = { ...rows[2]!, after: '{"i": 999}' };
  const v = run(rows);
  assert.equal(v.checked, 2);
  assert.equal(v.firstBreak?.check, "content");
  assert.equal(v.firstBreak?.id, "103");
  assert.equal(v.firstBreak?.chainSeq, 3);
  assert.equal(v.firstBreak?.actual, rows[2]!.rowHash);
  assert.equal(v.firstBreak?.expected, auditRowHash(rows[2]!));
});

test("sequence: a removed row breaks at the next one (expected vs actual seq)", () => {
  const rows = chain(5);
  rows.splice(2, 1);
  const v = run(rows);
  assert.deepEqual(v.firstBreak, { id: "104", chainSeq: 4, check: "sequence", expected: 3, actual: 4 });
});

test("link: a row whose prev_hash is not the previous row_hash (even if self-consistent)", () => {
  const rows = chain(4);
  const forged = { ...rows[3]!, prevHash: "c".repeat(64) };
  forged.rowHash = auditRowHash(forged);
  rows[3] = forged;
  const v = run(rows);
  assert.equal(v.firstBreak?.check, "link");
  assert.equal(v.firstBreak?.expected, rows[2]!.rowHash);
  assert.equal(v.firstBreak?.actual, "c".repeat(64));
});

test("genesis: chain_seq 1, the genesis action and an all-zero prev_hash are required", () => {
  const rows = chain(3);
  assert.equal(run(rows.slice(1)).firstBreak?.check, "sequence", "genesis removed");
  const wrongAction = { ...rows[0]!, action: "test.other" };
  wrongAction.rowHash = auditRowHash(wrongAction);
  assert.equal(run([wrongAction]).firstBreak?.check, "genesis");
  const v = new AuditChainVerifier();
  v.markEmpty();
  assert.equal(v.firstBreak?.check, "genesis");
});

test("unchained: a row slipped in without the trigger, or a vanished pre-chain row", () => {
  const v1 = run(chain(3));
  assert.equal(v1.checkUnchained(3, "999"), false);
  assert.deepEqual(v1.firstBreak, { id: "999", chainSeq: null, check: "unchained", expected: "5", actual: "999" });
  const v2 = run(chain(3));
  assert.equal(v2.checkUnchained(1, null), false);
  assert.deepEqual(v2.firstBreak, { id: null, chainSeq: null, check: "unchained", expected: 2, actual: 1 });
});

test("only the first break is reported", () => {
  const rows = chain(6);
  rows[1] = { ...rows[1]!, after: '{"x": 1}' };
  rows[4] = { ...rows[4]!, after: '{"x": 2}' };
  const v = new AuditChainVerifier();
  for (const r of rows) v.push(r);
  assert.equal(v.firstBreak?.chainSeq, 2);
  assert.equal(v.checkUnchained(0, "1"), false);
  assert.equal(v.firstBreak?.chainSeq, 2, "a later check never overwrites the first break");
});

test("parseGenesisAfter accepts the migration's shape only", () => {
  assert.deepEqual(parseGenesisAfter('{"unchainedCount": 0, "lastUnchainedId": null}'), { unchainedCount: 0, lastUnchainedId: null });
  assert.deepEqual(parseGenesisAfter('{"unchainedCount": 12, "lastUnchainedId": 40}'), { unchainedCount: 12, lastUnchainedId: "40" });
  assert.equal(parseGenesisAfter(null), null);
  assert.equal(parseGenesisAfter("[]"), null);
  assert.equal(parseGenesisAfter('{"unchainedCount": -1, "lastUnchainedId": null}'), null);
  assert.equal(parseGenesisAfter("not json"), null);
});
