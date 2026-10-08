// Hermetic unit tests for the append-only audit writer (lib/audit.ts): SQL shape,
// parameter mapping, defaults, and validation — against a capturing fake, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { appendAudit } from "./audit";

function capturingDb() {
  const calls: { text: string; params: unknown[] }[] = [];
  const db = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  return { db: db as unknown as Pool, calls };
}

test("appendAudit INSERTs into audit_log with the full parameter set", async () => {
  const { db, calls } = capturingDb();
  await appendAudit(db, {
    actorUserId: "6a2f6f3e-0000-0000-0000-000000000001",
    action: "challenge.status_changed",
    targetType: "challenge",
    targetId: "CH-1",
    before: { status: "in_review" },
    after: { status: "valid", override: false },
  });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.match(call.text, /insert into audit_log/i);
  assert.doesNotMatch(call.text, /update|delete/i); // writer is INSERT-only by construction
  assert.deepEqual(call.params, [
    "6a2f6f3e-0000-0000-0000-000000000001",
    "challenge.status_changed",
    "challenge",
    "CH-1",
    JSON.stringify({ status: "in_review" }),
    JSON.stringify({ status: "valid", override: false }),
  ]);
});

test("optional fields default to SQL nulls (system actor, no target id, no payload)", async () => {
  const { db, calls } = capturingDb();
  await appendAudit(db, { action: "scim.sync_anomaly", targetType: "scim" });
  assert.deepEqual(calls[0]!.params, [null, "scim.sync_anomaly", "scim", null, null, null]);
});

test("action and targetType are required", async () => {
  const { db } = capturingDb();
  await assert.rejects(appendAudit(db, { action: "", targetType: "x" }), /action/);
  await assert.rejects(appendAudit(db, { action: "x", targetType: "" }), /targetType/);
});
