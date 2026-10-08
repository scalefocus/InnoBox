import { test } from "node:test";
import assert from "node:assert/strict";
import { appendAudit } from "./audit.js";
import type { DbClient } from "./email-graph.js";

function captureDb() {
  const calls: Array<{ text: string; params: unknown[] | undefined }> = [];
  const db: DbClient = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, calls };
}

test("inserts into audit_log with the six columns in order", async () => {
  const { db, calls } = captureDb();
  await appendAudit(db, {
    actorUserId: "u-1",
    action: "role_mapping.created",
    targetType: "role_mapping",
    targetId: "rm-1",
    before: null,
    after: { role: "committee" },
  });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.match(call.text, /insert into audit_log/i);
  assert.match(
    call.text,
    /\(actor_user_id, action, target_type, target_id, before, after\)/,
  );
  assert.match(call.text, /values \(\$1, \$2, \$3, \$4, \$5, \$6\)/);
  assert.deepEqual(call.params, [
    "u-1",
    "role_mapping.created",
    "role_mapping",
    "rm-1",
    // Explicit null is a stated "before" value, serialized — distinct from omitted.
    "null",
    JSON.stringify({ role: "committee" }),
  ]);
});

test("omitted optionals default to SQL nulls (system actor)", async () => {
  const { db, calls } = captureDb();
  await appendAudit(db, { action: "scim.anomaly", targetType: "user" });
  assert.deepEqual(calls[0]!.params, [null, "scim.anomaly", "user", null, null, null]);
});

test("before/after are JSON.stringify'd payload halves", async () => {
  const { db, calls } = captureDb();
  await appendAudit(db, {
    action: "scim.user_updated",
    targetType: "user",
    targetId: "u-2",
    before: { active: true, displayName: "Ada" },
    after: { active: false },
  });
  const params = calls[0]!.params!;
  assert.equal(params[4], '{"active":true,"displayName":"Ada"}');
  assert.equal(params[5], '{"active":false}');
});

test("action and targetType are required; nothing is written on failure", async () => {
  const { db, calls } = captureDb();
  await assert.rejects(
    () => appendAudit(db, { action: "", targetType: "user" }),
    /requires an action/,
  );
  await assert.rejects(
    () => appendAudit(db, { action: "user.jit_created", targetType: "" }),
    /requires a targetType/,
  );
  assert.equal(calls.length, 0);
});

test("db failures propagate to the caller", async () => {
  const db: DbClient = {
    async query() {
      throw new Error("connection refused");
    },
  };
  await assert.rejects(
    () => appendAudit(db, { action: "recon.user_refreshed", targetType: "user" }),
    /connection refused/,
  );
});
