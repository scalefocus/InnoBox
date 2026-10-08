// Unit tests for the §11 scan sweep against a fake Pool + injected fake S3/scanner. Asserts the
// pending → clean/infected transitions (scanned_at stamped), the infected-path object purge +
// event-11 notification + audits, and that transient S3/clamd errors leave the row pending.
// The pure INSTREAM framing/parsing is covered by the @innobox/shared attachment tests, so the
// socket plumbing is not exercised here (it is not pure). Mirrors notifications/dispatch.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runScanSweep, type ScanFn, type ScanS3Client } from "./scan.js";

interface Row {
  [key: string]: unknown;
}

/** `updateRowCount: 0` models a row that is no longer `pending` by the time the verdict lands —
 *  either the web tier's on-demand scan resolved it first, or it was permanently deleted with its
 *  parent mid-sweep (§10.3). */
function makeFakePool(pending: Row[], opts: { updateRowCount?: number } = {}) {
  const updates: { sql: string; params: unknown[] }[] = [];
  const audits: unknown[][] = [];
  const notifications: unknown[][] = [];
  const outbox: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from attachments") && sql.includes("scan_status = 'pending'")) {
        return { rows: pending, rowCount: pending.length };
      }
      if (sql.startsWith("update attachments")) {
        updates.push({ sql, params });
        return { rows: [], rowCount: opts.updateRowCount ?? 1 };
      }
      if (sql.includes("insert into audit_log")) {
        audits.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into notifications")) {
        notifications.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into notification_outbox")) {
        outbox.push(params);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("from challenges")) {
        return { rows: [{ number: "5" }], rowCount: 1 };
      }
      if (sql.includes("from solutions")) {
        return { rows: [{ challenge_number: "5", number: "7" }], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, updates, audits, notifications, outbox };
}

const KNOWN_BYTES = new Uint8Array([1, 2, 3, 4]);

function fakeS3(overrides: Partial<ScanS3Client> = {}): { s3: ScanS3Client; deleted: string[] } {
  const deleted: string[] = [];
  const s3: ScanS3Client = {
    getObject: async () => KNOWN_BYTES,
    deleteObject: async (key: string) => {
      deleted.push(key);
    },
    ...overrides,
  };
  return { s3, deleted };
}

const challengeRow: Row = {
  id: "att-1",
  parent_type: "challenge",
  parent_id: "chal-1",
  object_key: "challenge/chal-1/att-1",
  filename: "clean.pdf",
  uploaded_by: "user-1",
};

test("runScanSweep: no pending rows returns a zeroed summary", async () => {
  const { pool } = makeFakePool([]);
  const { s3 } = fakeS3();
  const scan: ScanFn = async () => ({ clean: true });
  const summary = await runScanSweep(pool as never, { s3, scan });
  assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, errors: 0 });
});

test("runScanSweep: clean verdict → row set clean + scanned_at, audited, no delete, no notification", async () => {
  const { pool, updates, audits, notifications, outbox } = makeFakePool([challengeRow]);
  const { s3, deleted } = fakeS3();
  const scan: ScanFn = async () => ({ clean: true });
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 1, clean: 1, infected: 0, errors: 0 });
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.sql, /scan_status = 'clean'/);
  assert.match(updates[0]!.sql, /scanned_at = now\(\)/);
  assert.ok(audits.some((p) => p[1] === "attachment.scan_clean"), "clean scan is audited");
  assert.equal(deleted.length, 0, "clean object is not deleted");
  assert.equal(notifications.length, 0, "no notification for a clean scan");
  assert.equal(outbox.length, 0);
});

test("runScanSweep: infected verdict → row set infected, object purged, uploader notified (event 11), audited", async () => {
  const { pool, updates, audits, notifications, outbox } = makeFakePool([{ ...challengeRow, filename: "bad.docx" }]);
  const { s3, deleted } = fakeS3();
  const scan: ScanFn = async () => ({ clean: false, signature: "Eicar-Test-Signature" });
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 1, clean: 0, infected: 1, errors: 0 });
  assert.match(updates[0]!.sql, /scan_status = 'infected'/);
  assert.match(updates[0]!.sql, /scanned_at = now\(\)/);
  assert.deepEqual(deleted, ["challenge/chal-1/att-1"], "infected object is purged from MinIO");
  assert.ok(audits.some((p) => p[1] === "attachment.scan_infected"), "infected scan is audited");
  // Event 11: in-app + outbox rows for the uploader only.
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]![0], "user-1", "the uploader is the sole recipient");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]![0], "user-1");
  const payload = JSON.parse(notifications[0]![1] as string) as { message: string; link: string };
  assert.match(payload.message, /failed its virus scan/);
  assert.equal(payload.link, "/challenges/5");
});

test("runScanSweep: infected solution attachment links to the parent challenge with a #SOL hash", async () => {
  const solutionRow: Row = {
    id: "att-2",
    parent_type: "solution",
    parent_id: "sol-2",
    object_key: "solution/sol-2/att-2",
    filename: "bad.zip",
    uploaded_by: "user-9",
  };
  const { pool, notifications } = makeFakePool([solutionRow]);
  const { s3 } = fakeS3();
  const scan: ScanFn = async () => ({ clean: false, signature: "X" });
  await runScanSweep(pool as never, { s3, scan });
  const payload = JSON.parse(notifications[0]![1] as string) as { link: string };
  assert.equal(payload.link, "/challenges/5#SOL-7");
});

test("runScanSweep: transient clamd error leaves the row pending (no update), counted as an error", async () => {
  const { pool, updates, audits, notifications } = makeFakePool([challengeRow]);
  const { s3, deleted } = fakeS3();
  const scan: ScanFn = async () => {
    throw new Error("clamd unreachable");
  };
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, errors: 1 });
  assert.equal(updates.length, 0, "row must stay pending — no status update");
  assert.equal(audits.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(deleted.length, 0);
});

test("runScanSweep: transient S3 fetch error leaves the row pending and never calls the scanner", async () => {
  const { pool, updates } = makeFakePool([challengeRow]);
  let scanned = false;
  const s3: ScanS3Client = {
    getObject: async () => {
      throw new Error("minio down");
    },
    deleteObject: async () => {},
  };
  const scan: ScanFn = async () => {
    scanned = true;
    return { clean: true };
  };
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, errors: 1 });
  assert.equal(updates.length, 0);
  assert.equal(scanned, false, "the scanner is never invoked when the object can't be fetched");
});

test("runScanSweep: a verdict for a row that is no longer pending (resolved elsewhere, or deleted mid-sweep) is a no-op", async () => {
  // §10.3: the row's parent was permanently deleted between this sweep's SELECT and its UPDATE,
  // so the attachment is gone. Applying the verdict must write nothing — no audit row, and above
  // all no "your attachment failed its scan" notification for an attachment that no longer exists.
  for (const verdict of [{ clean: true }, { clean: false, signature: "X" }]) {
    const { pool, updates, audits, notifications, outbox } = makeFakePool([{ ...challengeRow }], { updateRowCount: 0 });
    const { s3, deleted } = fakeS3();
    const scan: ScanFn = async () => verdict;
    const summary = await runScanSweep(pool as never, { s3, scan });

    assert.equal(updates.length, 1, "the guarded UPDATE is still attempted");
    assert.deepEqual(audits, [], "no audit row for a verdict that applied to nothing");
    assert.deepEqual(notifications, [], "no notification for a vanished attachment");
    assert.deepEqual(outbox, []);
    assert.deepEqual(deleted, [], "no object purge for a row that is not ours to resolve");
    assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, errors: 0 });
  }
});
