// Unit test for the §15 audit CSV shape: the hash-chain columns follow `after`, empty for
// pre-chain rows; before/after are written verbatim as the stored jsonb text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUDIT_CSV_COLUMNS, auditCsvLines } from "./csv";
import type { AuditExportEntry } from "./store";

const base: AuditExportEntry = {
  id: "12",
  actorUserId: null,
  actorDisplayName: null,
  actorEmail: null,
  action: "audit.verified",
  targetType: "audit_log",
  targetId: null,
  targetNumber: null,
  targetHref: null,
  before: null,
  // PostgreSQL's jsonb::text spacing — not what JSON.stringify would produce.
  after: '{"result": "intact", "checked": 3}',
  createdAt: "2026-01-01T00:00:00.000Z",
  chainSeq: "7",
  prevHash: "a".repeat(64),
  rowHash: "b".repeat(64),
};

test("chain columns are appended after `after`", () => {
  assert.deepEqual(AUDIT_CSV_COLUMNS.slice(-4), ["after", "chain_seq", "prev_hash", "row_hash"]);
  const [header, line] = auditCsvLines([base]);
  assert.equal(header, AUDIT_CSV_COLUMNS.join(","));
  assert.ok(line!.endsWith(`,"{""result"": ""intact"", ""checked"": 3}",7,${"a".repeat(64)},${"b".repeat(64)}`), line!);
});

test("pre-chain rows export empty chain cells", () => {
  const [, line] = auditCsvLines([{ ...base, chainSeq: null, prevHash: null, rowHash: null }]);
  assert.ok(line!.endsWith(",,,"), line!);
});

test("before/after are written verbatim, never re-serialized", () => {
  const before = '{"b": 1, "a": [1, 2]}';
  const [, line] = auditCsvLines([{ ...base, before, after: null }]);
  assert.ok(line!.includes(`,"{""b"": 1, ""a"": [1, 2]}",,7,`), line!);
});
