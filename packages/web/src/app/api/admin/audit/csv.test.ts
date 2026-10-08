// Unit test for the §15 audit CSV shape: the hash-chain columns follow `after`, empty for
// pre-chain rows; before/after stay raw JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_CSV_COLUMNS, auditCsvLines } from "./csv";
import type { AuditEntry } from "./store";

const base: AuditEntry = {
  id: "12",
  actorUserId: null,
  actorDisplayName: null,
  actorEmail: null,
  action: "audit.verified",
  targetType: "audit_log",
  targetId: null,
  targetNumber: null,
  before: null,
  after: { result: "intact" },
  createdAt: "2026-01-01T00:00:00.000Z",
  chainSeq: "7",
  prevHash: "a".repeat(64),
  rowHash: "b".repeat(64),
};

test("chain columns are appended after `after`", () => {
  assert.deepEqual(AUDIT_CSV_COLUMNS.slice(-4), ["after", "chain_seq", "prev_hash", "row_hash"]);
  const [header, line] = auditCsvLines([base]);
  assert.equal(header, AUDIT_CSV_COLUMNS.join(","));
  assert.ok(line!.endsWith(`,"{""result"":""intact""}",7,${"a".repeat(64)},${"b".repeat(64)}`), line!);
});

test("pre-chain rows export empty chain cells", () => {
  const [, line] = auditCsvLines([{ ...base, chainSeq: null, prevHash: null, rowHash: null }]);
  assert.ok(line!.endsWith(",,,"), line!);
});
