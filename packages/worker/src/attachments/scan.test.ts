// Unit tests for the §11 scan sweep against a fake Pool + injected fake S3/scanner. Asserts the
// pending → clean/infected transitions (scanned_at stamped), the infected-path object purge +
// event-11 notification + audits, that outages (S3/clamd unreachable) leave the row untouched,
// and that per-file errors back off and, at the attempt cap, make the row `unscannable`.
// The pure INSTREAM framing/parsing is covered by the @innobox/shared tests; the streaming socket
// plumbing is exercised at the end against a fake clamd on a loopback port.
// Mirrors notifications/dispatch.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ClamdErrorReply, SCAN_MAX_ATTEMPTS, ScanObjectReadError } from "@innobox/shared";
import { createClamavScanner, runScanSweep, type ScanFn, type ScanObjectStream, type ScanS3Client } from "./scan.js";

interface Row {
  [key: string]: unknown;
}

/** `updateRowCount: 0` models a row that is no longer `pending` by the time the verdict lands —
 *  either the web tier's on-demand scan resolved it first, or it was permanently deleted with its
 *  parent mid-sweep (§10.3). */
function makeFakePool(pending: Row[], opts: { updateRowCount?: number } = {}) {
  const selects: string[] = [];
  const updates: { sql: string; params: unknown[] }[] = [];
  const audits: unknown[][] = [];
  const notifications: unknown[][] = [];
  const outbox: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from attachments") && sql.includes("scan_status = 'pending'")) {
        selects.push(sql);
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
  return { pool, selects, updates, audits, notifications, outbox };
}

const KNOWN_BYTES = new Uint8Array([1, 2, 3, 4]);

/** A fake object stream: yields the bytes in two chunks and records whether it was closed. */
function fakeStream(bytes: Uint8Array): { stream: ScanObjectStream; state: { destroyed: boolean } } {
  const state = { destroyed: false };
  const mid = Math.floor(bytes.length / 2);
  const stream: ScanObjectStream = {
    async *[Symbol.asyncIterator]() {
      yield bytes.subarray(0, mid);
      yield bytes.subarray(mid);
    },
    destroy() {
      state.destroyed = true;
    },
  };
  return { stream, state };
}

function fakeS3(overrides: Partial<ScanS3Client> = {}): { s3: ScanS3Client; deleted: string[] } {
  const deleted: string[] = [];
  const s3: ScanS3Client = {
    getObjectStream: async () => fakeStream(KNOWN_BYTES).stream,
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
  scan_attempts: 0,
};

test("runScanSweep: no pending rows returns a zeroed summary", async () => {
  const { pool } = makeFakePool([]);
  const { s3 } = fakeS3();
  const scan: ScanFn = async () => ({ clean: true });
  const summary = await runScanSweep(pool as never, { s3, scan });
  assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, unscannable: 0, errors: 0 });
});

test("runScanSweep: selects only due pending rows (next_scan_at null or past), oldest first", async () => {
  const { pool, selects } = makeFakePool([]);
  const { s3 } = fakeS3();
  await runScanSweep(pool as never, { s3, scan: async () => ({ clean: true }) });
  assert.match(selects[0]!, /next_scan_at is null or next_scan_at <= now\(\)/);
  assert.match(selects[0]!, /order by created_at asc/);
});

test("runScanSweep: clean verdict → row set clean + scanned_at, audited, no delete, no notification", async () => {
  const { pool, updates, audits, notifications, outbox } = makeFakePool([challengeRow]);
  const { s3, deleted } = fakeS3();
  const scan: ScanFn = async () => ({ clean: true });
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 1, clean: 1, infected: 0, unscannable: 0, errors: 0 });
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

  assert.deepEqual(summary, { scanned: 1, clean: 0, infected: 1, unscannable: 0, errors: 0 });
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
    scan_attempts: 0,
  };
  const { pool, notifications } = makeFakePool([solutionRow]);
  const { s3 } = fakeS3();
  const scan: ScanFn = async () => ({ clean: false, signature: "X" });
  await runScanSweep(pool as never, { s3, scan });
  const payload = JSON.parse(notifications[0]![1] as string) as { link: string };
  assert.equal(payload.link, "/challenges/5#SOL-7");
});

test("runScanSweep: clamd unreachable leaves the row untouched (no attempt counted), counted as an error", async () => {
  const { pool, updates, audits, notifications } = makeFakePool([challengeRow]);
  const { s3, deleted } = fakeS3();
  const scan: ScanFn = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, unscannable: 0, errors: 1 });
  assert.equal(updates.length, 0, "row must stay pending — no status update");
  assert.equal(audits.length, 0);
  assert.equal(notifications.length, 0);
  assert.equal(deleted.length, 0);
});

test("runScanSweep: an object store outage leaves the row untouched and never calls the scanner", async () => {
  const { pool, updates } = makeFakePool([challengeRow]);
  let scanned = false;
  const s3: ScanS3Client = {
    getObjectStream: async () => {
      throw Object.assign(new Error("minio down"), { code: "ECONNREFUSED" });
    },
    deleteObject: async () => {},
  };
  const scan: ScanFn = async () => {
    scanned = true;
    return { clean: true };
  };
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, unscannable: 0, errors: 1 });
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
    assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, unscannable: 0, errors: 0 });
  }
});

test("runScanSweep: a per-file error (clamd error reply) counts an attempt and backs off — the row stays pending", async () => {
  const { pool, updates, audits, notifications } = makeFakePool([{ ...challengeRow, scan_attempts: 2 }]);
  const { s3, deleted } = fakeS3();
  const scan: ScanFn = async () => {
    throw new ClamdErrorReply("INSTREAM size limit exceeded. ERROR");
  };
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 0, clean: 0, infected: 0, unscannable: 0, errors: 1 });
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.sql, /scan_attempts = \$2, next_scan_at = now\(\) \+ make_interval/);
  assert.doesNotMatch(updates[0]!.sql, /scan_status = 'unscannable'/);
  assert.deepEqual(updates[0]!.params, ["att-1", 3, 4, 2], "attempt 3 waits 4 minutes");
  assert.deepEqual(audits, [], "a retry is not audited");
  assert.deepEqual(notifications, []);
  assert.deepEqual(deleted, []);
});

test("runScanSweep: an unreadable object (not an outage) is a per-file error too", async () => {
  const { pool, updates } = makeFakePool([challengeRow]);
  const s3: ScanS3Client = {
    getObjectStream: async () => {
      throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    },
    deleteObject: async () => {},
  };
  await runScanSweep(pool as never, { s3, scan: async () => ({ clean: true }) });
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.sql, /scan_attempts = \$2/);
});

test("runScanSweep: the attempt-cap per-file error makes the row unscannable — purged, uploader notified (event 11), audited with the error class", async () => {
  const { pool, updates, audits, notifications, outbox } = makeFakePool([{ ...challengeRow, filename: "odd.pdf", scan_attempts: SCAN_MAX_ATTEMPTS - 1 }]);
  const { s3, deleted } = fakeS3();
  const scan: ScanFn = async () => {
    throw new ClamdErrorReply("Can't allocate memory ERROR");
  };
  const summary = await runScanSweep(pool as never, { s3, scan });

  assert.deepEqual(summary, { scanned: 1, clean: 0, infected: 0, unscannable: 1, errors: 0 });
  assert.match(updates[0]!.sql, /scan_status = 'unscannable', scanned_at = now\(\)/);
  assert.deepEqual(deleted, ["challenge/chal-1/att-1"], "the unscannable object is purged");
  const audit = audits.find((p) => p[1] === "attachment.scan_unscannable");
  assert.ok(audit, "unscannable is audited");
  assert.deepEqual(JSON.parse(audit![5] as string), { errorClass: "clamd_error_reply", attempts: SCAN_MAX_ATTEMPTS, objectKey: "challenge/chal-1/att-1" });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]![0], "user-1");
  assert.equal(outbox.length, 1);
  const payload = JSON.parse(notifications[0]![1] as string) as { message: string; link: string };
  assert.match(payload.message, /couldn't be scanned/);
  assert.equal(payload.link, "/challenges/5");
});

test("runScanSweep: the scanner receives the object STREAM (never a buffered copy), and the stream is closed afterwards", async () => {
  const { pool } = makeFakePool([challengeRow]);
  const { stream, state } = fakeStream(KNOWN_BYTES);
  const { s3 } = fakeS3({ getObjectStream: async () => stream });
  let received: unknown = null;
  const scan: ScanFn = async (source) => {
    received = source;
    return { clean: true };
  };
  await runScanSweep(pool as never, { s3, scan });
  assert.equal(received, stream, "the store stream is handed to the scanner as-is");
  assert.equal(state.destroyed, true, "the store stream is closed once the scan is done");
});

test("runScanSweep: the stream is closed even when the scanner fails (clamd unreachable)", async () => {
  const { pool, updates } = makeFakePool([challengeRow]);
  const { stream, state } = fakeStream(KNOWN_BYTES);
  const { s3 } = fakeS3({ getObjectStream: async () => stream });
  const scan: ScanFn = async () => {
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  const summary = await runScanSweep(pool as never, { s3, scan });
  assert.equal(state.destroyed, true);
  assert.equal(summary.errors, 1);
  assert.equal(updates.length, 0, "an outage leaves the row untouched");
});

// ── The real streaming scanner against a fake clamd (loopback TCP) ──────────────────────────

/** A minimal clamd: parses `zINSTREAM\0` + length-prefixed frames, records each frame's size,
 *  and replies `reply` after the terminator — or, with `replyAfterBytes`, as soon as that many
 *  payload bytes have arrived (what clamd does when StreamMaxLength is exceeded), then closes. */
async function startFakeClamd(opts: { reply: string; replyAfterBytes?: number }): Promise<{
  port: number;
  frames: number[];
  close: () => Promise<void>;
}> {
  const frames: number[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let commandSeen = false;
    let total = 0;
    let replied = false;
    const reply = (): void => {
      if (replied) return;
      replied = true;
      sock.end(`stream: ${opts.reply}\0`);
    };
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (d: Buffer) => {
      if (replied) return;
      buf = Buffer.concat([buf, d]);
      if (!commandSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        assert.equal(buf.subarray(0, nul).toString(), "zINSTREAM");
        buf = buf.subarray(nul + 1);
        commandSeen = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) return reply();
        if (buf.length < 4 + len) return;
        frames.push(len);
        total += len;
        buf = buf.subarray(4 + len);
        if (opts.replyAfterBytes !== undefined && total >= opts.replyAfterBytes) return reply();
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as net.AddressInfo).port;
  const close = (): Promise<void> => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((ok) => server.close(() => ok()));
  };
  return { port, frames, close };
}

test("createClamavScanner: streams the source in 64 KB frames at most and returns the verdict", async () => {
  const clamd = await startFakeClamd({ reply: "OK" });
  try {
    const scan = createClamavScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 });
    async function* source() {
      yield new Uint8Array(100 * 1024); // larger than one frame → split
      yield new Uint8Array(10);
    }
    assert.deepEqual(await scan(source()), { clean: true });
    assert.deepEqual(clamd.frames, [64 * 1024, 36 * 1024, 10]);
  } finally {
    await clamd.close();
  }
});

test("createClamavScanner: an early clamd reply (size limit) is a per-file error and stops reading the source", async () => {
  const clamd = await startFakeClamd({ reply: "INSTREAM size limit exceeded. ERROR", replyAfterBytes: 128 * 1024 });
  try {
    const scan = createClamavScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 });
    let pulled = 0;
    let closed = false;
    const endless: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            pulled += 1;
            if (pulled > 10_000) throw new Error("read far past the reply");
            await new Promise((r) => setImmediate(r));
            return { done: false, value: new Uint8Array(64 * 1024) };
          },
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    await assert.rejects(scan(endless), (err: unknown) => err instanceof ClamdErrorReply);
    // The writer notices the settled reply at its next frame and closes the source.
    for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed, true, "the source stream is closed once clamd has answered");
    assert.ok(pulled < 10_000);
  } finally {
    await clamd.close();
  }
});

test("createClamavScanner: a source that breaks mid-read rejects with ScanObjectReadError", async () => {
  const clamd = await startFakeClamd({ reply: "OK" });
  try {
    const scan = createClamavScanner({ host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 });
    async function* broken() {
      yield new Uint8Array(10);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }
    await assert.rejects(scan(broken()), (err: unknown) => err instanceof ScanObjectReadError);
  } finally {
    await clamd.close();
  }
});
