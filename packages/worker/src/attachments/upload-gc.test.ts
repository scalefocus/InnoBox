// Unit tests for the §11 chunked-upload-session GC sweep against a fake Pool + injected fake S3.
// Asserts: only sessions past the TTL are selected (default 2h); each has its MinIO multipart
// aborted and its session row deleted, audited `attachment.upload_aborted`; a row deleted between
// select and delete is skipped (no audit); a failed abort is non-fatal; empty selection returns a
// zeroed summary. Mirrors draft-gc.test.ts (SQL asserted textually — the fake Pool doesn't run SQL).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runUploadGcSweep, type UploadGcS3Client } from "./upload-gc.js";

interface Row {
  [key: string]: unknown;
}

function makeFakePool(stale: Row[], opts: { deleteRowCount?: number } = {}) {
  const selects: unknown[][] = [];
  const deletes: { sql: string; params: unknown[] }[] = [];
  const audits: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from attachment_uploads") && sql.includes("created_at <")) {
        selects.push(params);
        return { rows: stale, rowCount: stale.length };
      }
      if (sql.startsWith("delete from attachment_uploads")) {
        deletes.push({ sql, params });
        return { rows: [], rowCount: opts.deleteRowCount ?? 1 };
      }
      if (sql.includes("insert into audit_log")) {
        audits.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, selects, deletes, audits };
}

function fakeS3(overrides: Partial<UploadGcS3Client> = {}): { s3: UploadGcS3Client; aborted: { key: string; uploadId: string }[] } {
  const aborted: { key: string; uploadId: string }[] = [];
  const s3: UploadGcS3Client = {
    abortMultipartUpload: async (key: string, uploadId: string) => {
      aborted.push({ key, uploadId });
    },
    ...overrides,
  };
  return { s3, aborted };
}

const staleSession: Row = { id: "u-1", attachment_id: "att-1", object_key: "challenge/c-1/att-1", s3_upload_id: "mpu-1" };

test("runUploadGcSweep: no stale sessions returns a zeroed summary", async () => {
  const { pool, deletes } = makeFakePool([]);
  const { s3, aborted } = fakeS3();
  const summary = await runUploadGcSweep(pool as never, { s3 });
  assert.deepEqual(summary, { aborted: 0, errors: 0 });
  assert.equal(deletes.length, 0);
  assert.equal(aborted.length, 0);
});

test("runUploadGcSweep: selects only sessions past the TTL (default 2h)", async () => {
  const { pool, selects } = makeFakePool([staleSession]);
  const { s3 } = fakeS3();
  await runUploadGcSweep(pool as never, { s3 });
  assert.equal(selects.length, 1);
  assert.equal(selects[0]![0], 2, "the default TTL is 2 hours");
});

test("runUploadGcSweep: stale session → multipart aborted, row deleted, audited upload_aborted", async () => {
  const { pool, deletes, audits } = makeFakePool([staleSession]);
  const { s3, aborted } = fakeS3();
  const summary = await runUploadGcSweep(pool as never, { s3, ttlHours: 2 });

  assert.deepEqual(summary, { aborted: 1, errors: 0 });
  assert.deepEqual(aborted, [{ key: "challenge/c-1/att-1", uploadId: "mpu-1" }], "the MinIO multipart is aborted");
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]!.sql, /delete from attachment_uploads where id = \$1/);
  assert.ok(audits.some((p) => p[1] === "attachment.upload_aborted"), "the abort is audited");
});

test("runUploadGcSweep: a session deleted between select and delete is skipped (no audit)", async () => {
  const { pool, deletes, audits } = makeFakePool([staleSession], { deleteRowCount: 0 });
  const { s3 } = fakeS3();
  const summary = await runUploadGcSweep(pool as never, { s3 });

  assert.deepEqual(summary, { aborted: 0, errors: 0 }, "the raced row is not counted");
  assert.equal(deletes.length, 1, "the guarded delete still runs");
  assert.equal(audits.length, 0, "no audit when nothing was actually deleted");
});

test("runUploadGcSweep: a failed multipart abort does not abort the sweep — the row is still reaped", async () => {
  const { pool, deletes } = makeFakePool([staleSession]);
  const { s3 } = fakeS3({
    abortMultipartUpload: async () => {
      throw new Error("minio down");
    },
  });
  const summary = await runUploadGcSweep(pool as never, { s3 });
  assert.deepEqual(summary, { aborted: 1, errors: 0 }, "a failed abort is logged, not fatal");
  assert.equal(deletes.length, 1, "the session row is still deleted");
});

test("runUploadGcSweep: without object-store config (s3 null) the DB side still runs — row reaped, abort recorded as skipped", async () => {
  const { pool, deletes, audits } = makeFakePool([staleSession]);
  const summary = await runUploadGcSweep(pool as never, { s3: null });
  assert.deepEqual(summary, { aborted: 1, errors: 0 });
  assert.equal(deletes.length, 1, "the stale session row is deleted without S3");
  assert.equal(audits.length, 1, "the reap is audited");
  assert.match(JSON.stringify(audits[0]), /\\"multipartAborted\\":false/, "the audit records that no abort happened");
});

test("runUploadGcSweep: a successful abort is recorded in the audit", async () => {
  const { pool, audits } = makeFakePool([staleSession]);
  const { s3 } = fakeS3();
  await runUploadGcSweep(pool as never, { s3 });
  assert.match(JSON.stringify(audits[0]), /\\"multipartAborted\\":true/);
});
