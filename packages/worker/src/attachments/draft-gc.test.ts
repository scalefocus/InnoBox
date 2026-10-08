// Unit tests for the §11 draft-attachment GC sweep against a fake Pool + injected fake S3.
// Asserts: only unbound staged rows past the TTL are selected; each is soft-removed (removed_at
// stamped, object purged) and audited `attachment.draft_expired`; a row that was bound/removed
// between select and update is skipped; empty selection returns a zeroed summary. Mirrors
// scan.test.ts (the SQL predicates are asserted textually since the fake Pool doesn't run SQL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDraftGcSweep, type DraftGcS3Client } from "./draft-gc.js";

interface Row {
  [key: string]: unknown;
}

function makeFakePool(abandoned: Row[], opts: { updateRowCount?: number } = {}) {
  const selects: unknown[][] = [];
  const updates: { sql: string; params: unknown[] }[] = [];
  const audits: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from attachments") && sql.includes("parent_id is null")) {
        selects.push(params);
        return { rows: abandoned, rowCount: abandoned.length };
      }
      if (sql.startsWith("update attachments")) {
        updates.push({ sql, params });
        return { rows: [], rowCount: opts.updateRowCount ?? 1 };
      }
      if (sql.includes("insert into audit_log")) {
        audits.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, selects, updates, audits };
}

function fakeS3(overrides: Partial<DraftGcS3Client> = {}): { s3: DraftGcS3Client; deleted: string[] } {
  const deleted: string[] = [];
  const s3: DraftGcS3Client = {
    deleteObject: async (key: string) => {
      deleted.push(key);
    },
    ...overrides,
  };
  return { s3, deleted };
}

const stagedRow: Row = { id: "att-1", object_key: "drafts/d-1/att-1" };

test("runDraftGcSweep: no abandoned rows returns a zeroed summary", async () => {
  const { pool, updates } = makeFakePool([]);
  const { s3, deleted } = fakeS3();
  const summary = await runDraftGcSweep(pool as never, { s3 });
  assert.deepEqual(summary, { expired: 0, errors: 0 });
  assert.equal(updates.length, 0);
  assert.equal(deleted.length, 0);
});

test("runDraftGcSweep: selects only unbound staged rows past the TTL (default 24h)", async () => {
  const { pool, selects } = makeFakePool([stagedRow]);
  const { s3 } = fakeS3();
  await runDraftGcSweep(pool as never, { s3 });
  assert.equal(selects.length, 1);
  assert.equal(selects[0]![0], 24, "the default TTL is 24 hours");
});

test("runDraftGcSweep: abandoned row → object purged, soft-removed, audited draft_expired", async () => {
  const { pool, updates, audits } = makeFakePool([stagedRow]);
  const { s3, deleted } = fakeS3();
  const summary = await runDraftGcSweep(pool as never, { s3, ttlHours: 24 });

  assert.deepEqual(summary, { expired: 1, errors: 0 });
  assert.deepEqual(deleted, ["drafts/d-1/att-1"], "the staged object is purged from MinIO");
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.sql, /removed_at = now\(\)/);
  assert.match(updates[0]!.sql, /parent_id is null and removed_at is null/);
  assert.ok(audits.some((p) => p[1] === "attachment.draft_expired"), "expiry is audited");
});

test("runDraftGcSweep: a row bound/removed between select and update is skipped (no audit)", async () => {
  const { pool, updates, audits } = makeFakePool([stagedRow], { updateRowCount: 0 });
  const { s3 } = fakeS3();
  const summary = await runDraftGcSweep(pool as never, { s3 });

  assert.deepEqual(summary, { expired: 0, errors: 0 }, "the raced row is not counted as expired");
  assert.equal(updates.length, 1, "the guarded update still runs");
  assert.equal(audits.length, 0, "no audit when nothing was actually removed");
});

test("runDraftGcSweep: a failed object purge does not abort — the row is still tombstoned", async () => {
  const { pool, updates } = makeFakePool([stagedRow]);
  const { s3 } = fakeS3({
    deleteObject: async () => {
      throw new Error("minio down");
    },
  });
  const summary = await runDraftGcSweep(pool as never, { s3 });
  assert.deepEqual(summary, { expired: 1, errors: 0 }, "a failed purge is logged, not fatal");
  assert.equal(updates.length, 1, "the row is still soft-removed");
});
