// Unit tests for the §11 attachment domain logic — allowlist, object key, INSTREAM framing,
// clamd response parsing, the author window predicate, and the anonymity-safe projection.
// Pure and hermetic (node:test + node:assert/strict), mirroring challenges.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  applyScanResult,
  attachmentChunkRanges,
  attachmentContentMatchesType,
  checkChunkPart,
  chunkPartCount,
  ClamdErrorReply,
  classifyScanFailure,
  expectedChunkPartSize,
  planScanFailure,
  SCAN_MAX_ATTEMPTS,
  ScanObjectReadError,
  scanRetryBackoffMinutes,
  verifyChunkAssembly,
  type ScanTarget,
  attachmentExtension,
  attachmentObjectKey,
  CLAMD_INSTREAM_TERMINATOR,
  frameInstreamChunk,
  isAllowedAttachmentType,
  isAttachmentDownloadable,
  MIN_ATTACHMENT_CHUNK_SIZE_MB,
  parentAcceptsAttachmentChanges,
  parseClamdResponse,
  projectAttachmentForViewer,
  shouldChunkUpload,
  stagedAttachmentObjectKey,
  type AttachmentRecord,
} from "./attachments.js";

// ── Allowlist ────────────────────────────────────────────────────────────────────────────

test("isAllowedAttachmentType: accepts a good extension + matching MIME", () => {
  assert.equal(isAllowedAttachmentType("report.pdf", "application/pdf"), true);
  assert.equal(
    isAllowedAttachmentType("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    true,
  );
  assert.equal(isAllowedAttachmentType("photo.png", "image/png"), true);
  assert.equal(isAllowedAttachmentType("archive.zip", "application/zip"), true);
});

test("isAllowedAttachmentType: is case-insensitive on both extension and MIME", () => {
  assert.equal(isAllowedAttachmentType("Report.PDF", "APPLICATION/PDF"), true);
  assert.equal(isAllowedAttachmentType("IMG.JPeG", "image/JPEG"), true);
});

test("isAllowedAttachmentType: tolerates a MIME with charset parameters", () => {
  assert.equal(isAllowedAttachmentType("notes.txt", "text/plain; charset=utf-8"), true);
  assert.equal(isAllowedAttachmentType("data.csv", "text/csv;charset=UTF-8"), true);
});

test("isAllowedAttachmentType: rejects a good extension with a wrong/mismatched MIME", () => {
  assert.equal(isAllowedAttachmentType("report.pdf", "text/html"), false);
  assert.equal(isAllowedAttachmentType("photo.png", "image/jpeg"), false);
  // A double-extension trick where the real (last) extension is disallowed.
  assert.equal(isAllowedAttachmentType("invoice.pdf.exe", "application/pdf"), false);
});

test("isAllowedAttachmentType: rejects unknown/dangerous extensions", () => {
  assert.equal(isAllowedAttachmentType("run.exe", "application/octet-stream"), false);
  assert.equal(isAllowedAttachmentType("script.js", "text/javascript"), false);
  assert.equal(isAllowedAttachmentType("noextension", "application/pdf"), false);
});

test("isAllowedAttachmentType: SVG is excluded (it can carry script)", () => {
  assert.equal(isAllowedAttachmentType("logo.svg", "image/svg+xml"), false);
  // even declared as a permitted image MIME, the .svg extension is not in the set
  assert.equal(isAllowedAttachmentType("logo.svg", "image/png"), false);
});

test("ALLOWED_ATTACHMENT_EXTENSIONS covers the documented set and excludes svg", () => {
  for (const ext of ["pdf", "docx", "xlsx", "pptx", "odt", "rtf", "txt", "csv", "md", "png", "jpg", "jpeg", "gif", "webp", "zip"]) {
    assert.ok(ALLOWED_ATTACHMENT_EXTENSIONS.includes(ext), `expected ${ext} in the allowlist`);
  }
  assert.equal(ALLOWED_ATTACHMENT_EXTENSIONS.includes("svg"), false);
});

test("attachmentExtension: last segment, lowercased, empty when none", () => {
  assert.equal(attachmentExtension("a.PDF"), "pdf");
  assert.equal(attachmentExtension("archive.tar.gz"), "gz");
  assert.equal(attachmentExtension("README"), "");
  assert.equal(attachmentExtension("trailingdot."), "");
});

// ── Object key ───────────────────────────────────────────────────────────────────────────

test("stagedAttachmentObjectKey: drafts/<draftKey>/<attachmentId>", () => {
  assert.equal(stagedAttachmentObjectKey("d-7", "a-9"), "drafts/d-7/a-9");
});

test("attachmentObjectKey: <parentType>/<parentId>/<attachmentId>", () => {
  assert.equal(attachmentObjectKey("challenge", "c-1", "a-9"), "challenge/c-1/a-9");
  assert.equal(attachmentObjectKey("solution", "s-2", "a-3"), "solution/s-2/a-3");
});

// ── Author upload/remove window ──────────────────────────────────────────────────────────

test("parentAcceptsAttachmentChanges: mirrors the §10.1 edit windows", () => {
  assert.equal(parentAcceptsAttachmentChanges("challenge", "awaiting_triage"), true);
  assert.equal(parentAcceptsAttachmentChanges("challenge", "needs_improvement"), true);
  assert.equal(parentAcceptsAttachmentChanges("challenge", "in_review"), false);
  assert.equal(parentAcceptsAttachmentChanges("challenge", "valid"), false);
  assert.equal(parentAcceptsAttachmentChanges("solution", "proposed"), true);
  assert.equal(parentAcceptsAttachmentChanges("solution", "needs_improvement"), true);
  assert.equal(parentAcceptsAttachmentChanges("solution", "in_review"), false);
  assert.equal(parentAcceptsAttachmentChanges("solution", "implemented"), false);
});

// ── INSTREAM framing ─────────────────────────────────────────────────────────────────────

test("frameInstreamChunk: 4-byte big-endian length prefix + payload", () => {
  const framed = frameInstreamChunk(new Uint8Array([0xaa, 0xbb, 0xcc]));
  assert.deepEqual(Array.from(framed), [0x00, 0x00, 0x00, 0x03, 0xaa, 0xbb, 0xcc]);
});

test("frameInstreamChunk: encodes lengths > 255 across the four bytes (big-endian)", () => {
  const framed = frameInstreamChunk(new Uint8Array(300));
  // 300 = 0x0000012C
  assert.deepEqual(Array.from(framed.slice(0, 4)), [0x00, 0x00, 0x01, 0x2c]);
  assert.equal(framed.length, 4 + 300);
});

test("CLAMD_INSTREAM_TERMINATOR is four zero bytes", () => {
  assert.deepEqual(Array.from(CLAMD_INSTREAM_TERMINATOR), [0, 0, 0, 0]);
});

// ── clamd response parsing ───────────────────────────────────────────────────────────────

test("parseClamdResponse: OK → clean", () => {
  assert.deepEqual(parseClamdResponse("stream: OK"), { clean: true });
  assert.deepEqual(parseClamdResponse("stream: OK\0"), { clean: true });
});

test("parseClamdResponse: FOUND → infected with the signature", () => {
  assert.deepEqual(parseClamdResponse("stream: Eicar-Test-Signature FOUND"), {
    clean: false,
    signature: "Eicar-Test-Signature",
  });
  assert.deepEqual(parseClamdResponse("stream: Win.Test.EICAR_HDB-1 FOUND\0"), {
    clean: false,
    signature: "Win.Test.EICAR_HDB-1",
  });
});

test("parseClamdResponse: an error reply throws ClamdErrorReply (a per-file error)", () => {
  assert.throws(() => parseClamdResponse("INSTREAM size limit exceeded. ERROR"), ClamdErrorReply);
  assert.throws(() => parseClamdResponse("some unexpected garbage"), ClamdErrorReply);
});

test("parseClamdResponse: an empty reply is an outage, not a per-file error", () => {
  let caught: unknown;
  try {
    parseClamdResponse("\0");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error && !(caught instanceof ClamdErrorReply));
  assert.equal(classifyScanFailure(caught).kind, "engine_unavailable");
});

// ── Anonymity-safe projection ────────────────────────────────────────────────────────────

const baseRow: AttachmentRecord = {
  id: "a1",
  filename: "spec.pdf",
  sizeBytes: 1234,
  mime: "application/pdf",
  scanStatus: "clean",
  removedAt: null,
  uploadedBy: "uploader",
  createdAt: "2026-07-10T00:00:00.000Z",
};

test("projectAttachmentForViewer: never emits uploadedBy; carries isUploader", () => {
  const view = projectAttachmentForViewer(baseRow, "someone-else");
  assert.ok(view);
  assert.equal("uploadedBy" in (view as object), false, "uploadedBy must never reach the client");
  assert.equal(view!.isUploader, false);
  const own = projectAttachmentForViewer(baseRow, "uploader");
  assert.equal(own!.isUploader, true);
});

test("projectAttachmentForViewer: clean rows are visible to anyone; status carried through", () => {
  const view = projectAttachmentForViewer(baseRow, "someone-else");
  assert.equal(view!.status, "clean");
  assert.equal(view!.filename, "spec.pdf");
  assert.equal(view!.sizeBytes, 1234);
});

test("projectAttachmentForViewer: pending/infected shown only to the uploader", () => {
  const pending: AttachmentRecord = { ...baseRow, scanStatus: "pending" };
  assert.equal(projectAttachmentForViewer(pending, "uploader")!.status, "pending");
  assert.equal(projectAttachmentForViewer(pending, "other"), null);

  const infected: AttachmentRecord = { ...baseRow, scanStatus: "infected" };
  assert.equal(projectAttachmentForViewer(infected, "uploader")!.status, "infected");
  assert.equal(projectAttachmentForViewer(infected, "other"), null);
});

test("projectAttachmentForViewer: author-removed rows are hidden from everyone (uploader included)", () => {
  const removed: AttachmentRecord = { ...baseRow, removedAt: "2026-07-10T01:00:00.000Z" };
  assert.equal(projectAttachmentForViewer(removed, "uploader"), null);
  assert.equal(projectAttachmentForViewer(removed, "other"), null);
});

// ── Chunked-upload sizing (§11) ────────────────────────────────────────────────────────────

test("shouldChunkUpload: strictly larger than the chunk size chunks; at/below goes single-shot", () => {
  const chunk = 5 * 1024 * 1024;
  assert.equal(shouldChunkUpload(chunk - 1, chunk), false);
  assert.equal(shouldChunkUpload(chunk, chunk), false, "exactly the chunk size is a single request");
  assert.equal(shouldChunkUpload(chunk + 1, chunk), true);
  assert.equal(shouldChunkUpload(100, 0), false, "a non-positive chunk size never chunks");
});

test("MIN_ATTACHMENT_CHUNK_SIZE_MB is the 5 MB S3 multipart part floor", () => {
  assert.equal(MIN_ATTACHMENT_CHUNK_SIZE_MB, 5);
});

test("attachmentChunkRanges: exact multiple → equal parts, numbered from 1", () => {
  const ranges = attachmentChunkRanges(10, 5);
  assert.deepEqual(ranges, [
    { partNumber: 1, start: 0, end: 5 },
    { partNumber: 2, start: 5, end: 10 },
  ]);
});

test("attachmentChunkRanges: remainder → a smaller final part", () => {
  const ranges = attachmentChunkRanges(13, 5);
  assert.deepEqual(ranges, [
    { partNumber: 1, start: 0, end: 5 },
    { partNumber: 2, start: 5, end: 10 },
    { partNumber: 3, start: 10, end: 13 },
  ]);
  // Every non-final part is exactly the chunk size (the S3 part floor); only the last is smaller.
  assert.ok(ranges.slice(0, -1).every((r) => r.end - r.start === 5));
  assert.equal(ranges.at(-1)!.end - ranges.at(-1)!.start, 3);
});

test("attachmentChunkRanges: a file at/below the chunk size is a single range covering all bytes", () => {
  assert.deepEqual(attachmentChunkRanges(5, 5), [{ partNumber: 1, start: 0, end: 5 }]);
  assert.deepEqual(attachmentChunkRanges(3, 5), [{ partNumber: 1, start: 0, end: 3 }]);
});

test("attachmentChunkRanges: covers exactly the byte count with contiguous ranges", () => {
  const size = 5 * 1024 * 1024 * 4 + 137; // 4 full 5MB parts + a remainder
  const ranges = attachmentChunkRanges(size, 5 * 1024 * 1024);
  assert.equal(ranges[0]!.start, 0);
  assert.equal(ranges.at(-1)!.end, size);
  for (let i = 1; i < ranges.length; i++) assert.equal(ranges[i]!.start, ranges[i - 1]!.end, "ranges are contiguous");
});

test("isAttachmentDownloadable: only clean & not-removed", () => {
  assert.equal(isAttachmentDownloadable({ scanStatus: "clean", removedAt: null }), true);
  assert.equal(isAttachmentDownloadable({ scanStatus: "pending", removedAt: null }), false);
  assert.equal(isAttachmentDownloadable({ scanStatus: "infected", removedAt: null }), false);
  assert.equal(isAttachmentDownloadable({ scanStatus: "clean", removedAt: "2026-07-10T00:00:00.000Z" }), false);
});

// ── Content check (magic bytes) ──────────────────────────────────────────────────────────

const bytesOf = (...parts: (number[] | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};

test("attachmentContentMatchesType: each signature matches its extensions", () => {
  assert.equal(attachmentContentMatchesType("a.pdf", bytesOf("%PDF-1.7\n")), true);
  assert.equal(attachmentContentMatchesType("a.png", bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), true);
  assert.equal(attachmentContentMatchesType("a.jpg", bytesOf([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(attachmentContentMatchesType("a.JPEG", bytesOf([0xff, 0xd8, 0xff, 0xdb])), true);
  assert.equal(attachmentContentMatchesType("a.gif", bytesOf("GIF87a")), true);
  assert.equal(attachmentContentMatchesType("a.gif", bytesOf("GIF89a...")), true);
  assert.equal(attachmentContentMatchesType("a.webp", bytesOf("RIFF", [1, 2, 3, 4], "WEBPVP8 ")), true);
  assert.equal(attachmentContentMatchesType("a.rtf", bytesOf("{\\rtf1\\ansi")), true);
  for (const ext of ["docx", "xlsx", "pptx", "odt", "ods", "odp", "zip"]) {
    assert.equal(attachmentContentMatchesType(`a.${ext}`, bytesOf([0x50, 0x4b, 0x03, 0x04, 20, 0])), true, ext);
  }
  for (const ext of ["doc", "xls", "ppt"]) {
    assert.equal(attachmentContentMatchesType(`a.${ext}`, bytesOf([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), true, ext);
  }
  for (const ext of ["txt", "csv", "md"]) {
    assert.equal(attachmentContentMatchesType(`a.${ext}`, bytesOf("hello, world\n")), true, ext);
  }
  assert.equal(attachmentContentMatchesType("empty.txt", new Uint8Array(0)), true, "an empty text file has no NUL");
});

test("attachmentContentMatchesType: mismatches are refused", () => {
  assert.equal(attachmentContentMatchesType("evil.pdf", bytesOf("MZ", [0x90, 0])), false, "an executable named .pdf");
  assert.equal(attachmentContentMatchesType("a.png", bytesOf("%PDF-1.7")), false);
  assert.equal(attachmentContentMatchesType("a.gif", bytesOf("GIF88a")), false);
  assert.equal(attachmentContentMatchesType("a.webp", bytesOf("RIFF", [1, 2, 3, 4], "WAVE")), false, "RIFF but not WEBP");
  assert.equal(attachmentContentMatchesType("a.docx", bytesOf([0xd0, 0xcf, 0x11, 0xe0])), false, "OLE2 is not a .docx");
  assert.equal(attachmentContentMatchesType("a.zip", bytesOf([0x50, 0x4b, 0x05, 0x06])), false, "only a local-file header counts");
  assert.equal(attachmentContentMatchesType("a.doc", bytesOf([0x50, 0x4b, 0x03, 0x04])), false);
  assert.equal(attachmentContentMatchesType("a.txt", bytesOf("abc", [0], "def")), false, "a NUL byte is not text");
  assert.equal(attachmentContentMatchesType("a.pdf", bytesOf("%PD")), false, "too short to match");
  assert.equal(attachmentContentMatchesType("a.exe", bytesOf("MZ")), false, "unknown extensions never match");
  assert.equal(attachmentContentMatchesType("noext", bytesOf("hello")), false);
});

test("attachmentContentMatchesType: the text check only inspects the first 8 KB", () => {
  const late = new Uint8Array(8 * 1024 + 10).fill(0x41);
  late[8 * 1024 + 5] = 0;
  assert.equal(attachmentContentMatchesType("a.csv", late), true, "a NUL after 8 KB is not inspected");
  const early = new Uint8Array(8 * 1024).fill(0x41);
  early[8 * 1024 - 1] = 0;
  assert.equal(attachmentContentMatchesType("a.csv", early), false);
});

// ── Chunked-upload size binding ──────────────────────────────────────────────────────────

test("chunkPartCount: N = ceil(declared / chunk); zero for a zero size or chunk", () => {
  assert.equal(chunkPartCount(10, 5), 2);
  assert.equal(chunkPartCount(11, 5), 3);
  assert.equal(chunkPartCount(1, 5), 1);
  assert.equal(chunkPartCount(0, 5), 0);
  assert.equal(chunkPartCount(10, 0), 0);
});

test("expectedChunkPartSize: non-final parts are the chunk size, the final part the remainder", () => {
  assert.equal(expectedChunkPartSize(12, 5, 1), 5);
  assert.equal(expectedChunkPartSize(12, 5, 2), 5);
  assert.equal(expectedChunkPartSize(12, 5, 3), 2);
  assert.equal(expectedChunkPartSize(10, 5, 2), 5, "an exact multiple's final part is a full chunk");
  assert.equal(expectedChunkPartSize(12, 5, 0), null);
  assert.equal(expectedChunkPartSize(12, 5, 4), null, "beyond N");
  assert.equal(expectedChunkPartSize(12, 5, 1.5), null);
});

test("checkChunkPart: rejects out-of-range numbers and wrong sizes", () => {
  assert.deepEqual(checkChunkPart(12, 5, 1, 5), { ok: true });
  assert.deepEqual(checkChunkPart(12, 5, 3, 2), { ok: true });
  assert.deepEqual(checkChunkPart(12, 5, 4, 2), { ok: false, reason: "out_of_range" });
  assert.deepEqual(checkChunkPart(12, 5, 0, 5), { ok: false, reason: "out_of_range" });
  assert.deepEqual(checkChunkPart(12, 5, 1, 4), { ok: false, reason: "wrong_size" }, "a short non-final part");
  assert.deepEqual(checkChunkPart(12, 5, 3, 5), { ok: false, reason: "wrong_size" }, "an over-long final part");
  assert.deepEqual(checkChunkPart(12, 5, 3, 1), { ok: false, reason: "wrong_size" }, "a short final part");
});

test("verifyChunkAssembly: exactly parts 1…N with the required sizes, else null", () => {
  const good = [
    { partNumber: 1, size: 5 },
    { partNumber: 2, size: 5 },
    { partNumber: 3, size: 2 },
  ];
  assert.equal(verifyChunkAssembly(12, 5, good), 12);
  assert.equal(verifyChunkAssembly(12, 5, [...good].reverse()), 12, "order does not matter");
  assert.equal(verifyChunkAssembly(12, 5, good.slice(0, 2)), null, "a missing part");
  assert.equal(verifyChunkAssembly(12, 5, [...good, { partNumber: 4, size: 1 }]), null, "an extra part");
  assert.equal(verifyChunkAssembly(12, 5, [good[0]!, good[0]!, good[2]!]), null, "a duplicated part");
  assert.equal(verifyChunkAssembly(12, 5, [good[0]!, { partNumber: 2, size: 4 }, good[2]!]), null, "a wrong size");
  assert.equal(verifyChunkAssembly(0, 5, []), null, "nothing to assemble");
});

// ── Scan retries ─────────────────────────────────────────────────────────────────────────

test("scanRetryBackoffMinutes: 1, 2, 4, 8 … capped at 60", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map(scanRetryBackoffMinutes), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  assert.equal(scanRetryBackoffMinutes(0), 1);
});

test("classifyScanFailure: clamd error replies and unreadable objects are per-file errors", () => {
  assert.deepEqual(classifyScanFailure(new ClamdErrorReply("INSTREAM size limit exceeded. ERROR")), {
    kind: "file_error",
    errorClass: "clamd_size_limit",
  });
  assert.deepEqual(classifyScanFailure(new ClamdErrorReply("Can't allocate memory ERROR")), {
    kind: "file_error",
    errorClass: "clamd_error_reply",
  });
  const noSuchKey = Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
  assert.deepEqual(classifyScanFailure(new ScanObjectReadError(noSuchKey)), { kind: "file_error", errorClass: "object_read_failed" });
});

test("classifyScanFailure: an unreachable clamd or object store is an outage", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.deepEqual(classifyScanFailure(refused), { kind: "engine_unavailable", errorClass: "ECONNREFUSED" });
  assert.equal(classifyScanFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" })).kind, "engine_unavailable");
  assert.equal(classifyScanFailure(new Error("clamd scan timed out")).kind, "engine_unavailable");
  assert.equal(classifyScanFailure(new Error("clamav not configured")).kind, "engine_unavailable");
  assert.equal(classifyScanFailure(new ScanObjectReadError(refused)).kind, "engine_unavailable");
  const s3Down = Object.assign(new Error("Service Unavailable"), { $metadata: { httpStatusCode: 503 } });
  assert.deepEqual(classifyScanFailure(new ScanObjectReadError(s3Down)), { kind: "engine_unavailable", errorClass: "object_store_unavailable" });
});

test("planScanFailure: outages never count; per-file errors back off, then go unscannable at the cap", () => {
  assert.deepEqual(planScanFailure(5, "engine_unavailable"), { action: "stay_pending" });
  assert.deepEqual(planScanFailure(0, "file_error"), { action: "retry", attempts: 1, backoffMinutes: 1 });
  assert.deepEqual(planScanFailure(3, "file_error"), { action: "retry", attempts: 4, backoffMinutes: 8 });
  assert.deepEqual(planScanFailure(SCAN_MAX_ATTEMPTS - 2, "file_error"), { action: "retry", attempts: 7, backoffMinutes: 60 });
  assert.equal(SCAN_MAX_ATTEMPTS, 8);
  assert.deepEqual(planScanFailure(SCAN_MAX_ATTEMPTS - 1, "file_error"), { action: "unscannable", attempts: 8 });
});

// ── Shared verdict handler (fake DbClient) ───────────────────────────────────────────────

function fakeScanDb(opts: { rowCount?: number } = {}) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const purged: string[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.startsWith("update attachments")) return { rows: [] as never[], rowCount: opts.rowCount ?? 1 };
      if (sql.includes("from challenges")) return { rows: [{ number: "5" }] as never[], rowCount: 1 };
      return { rows: [] as never[], rowCount: 1 };
    },
  };
  const fx = {
    db,
    purgeObject: async (key: string) => {
      purged.push(key);
    },
  };
  const audits = () => queries.filter((q) => q.sql.includes("insert into audit_log")).map((q) => q.params);
  const notifications = () => queries.filter((q) => q.sql.includes("insert into notifications")).map((q) => q.params);
  return { fx, queries, purged, audits, notifications };
}

const scanTarget: ScanTarget = {
  id: "att-1",
  parentType: "challenge",
  parentId: "chal-1",
  objectKey: "challenge/chal-1/att-1",
  filename: "odd.pdf",
  uploadedBy: "user-1",
  scanAttempts: 0,
};

test("applyScanResult: an outage changes nothing", async () => {
  const { fx, queries, purged } = fakeScanDb();
  const outcome = await applyScanResult(fx, scanTarget, { error: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
  assert.equal(outcome, "unavailable");
  assert.equal(queries.length, 0, "no attempt counted, no write");
  assert.deepEqual(purged, []);
});

test("applyScanResult: a per-file error bumps scan_attempts and backs off next_scan_at", async () => {
  const { fx, queries, audits, notifications } = fakeScanDb();
  const outcome = await applyScanResult(fx, { ...scanTarget, scanAttempts: 2 }, { error: new ClamdErrorReply("boom ERROR") });
  assert.equal(outcome, "retry");
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.sql, /set scan_attempts = \$2, next_scan_at = now\(\) \+ make_interval/);
  assert.match(queries[0]!.sql, /scan_status = 'pending' and scan_attempts = \$4/, "guarded on the attempt count read");
  assert.deepEqual(queries[0]!.params, ["att-1", 3, 4, 2]);
  assert.deepEqual(audits(), [], "a retry is not audited");
  assert.deepEqual(notifications(), []);
});

test("applyScanResult: the 8th per-file error makes the row unscannable — purged, audited with the class, uploader notified", async () => {
  const { fx, queries, purged, audits, notifications } = fakeScanDb();
  const outcome = await applyScanResult(
    fx,
    { ...scanTarget, scanAttempts: SCAN_MAX_ATTEMPTS - 1 },
    { error: new ClamdErrorReply("INSTREAM size limit exceeded. ERROR") },
  );
  assert.equal(outcome, "unscannable");
  assert.match(queries[0]!.sql, /scan_status = 'unscannable', scanned_at = now\(\)/);
  assert.deepEqual(purged, ["challenge/chal-1/att-1"]);
  const audit = audits()[0]!;
  assert.equal(audit[1], "attachment.scan_unscannable");
  assert.deepEqual(JSON.parse(audit[5] as string), { errorClass: "clamd_size_limit", attempts: 8, objectKey: "challenge/chal-1/att-1" });
  assert.equal(notifications().length, 1);
  assert.equal(notifications()[0]![0], "user-1", "the uploader is the sole recipient");
  assert.match((JSON.parse(notifications()[0]![1] as string) as { message: string }).message, /couldn't be scanned/);
});

test("applyScanResult: a row resolved elsewhere is a no-op for every outcome", async () => {
  const results = [{ verdict: { clean: true } }, { verdict: { clean: false, signature: "X" } }, { error: new ClamdErrorReply("x ERROR") }];
  for (const result of results) {
    const { fx, purged, audits, notifications } = fakeScanDb({ rowCount: 0 });
    assert.equal(await applyScanResult(fx, { ...scanTarget, scanAttempts: SCAN_MAX_ATTEMPTS - 1 }, result), "noop");
    assert.deepEqual(purged, []);
    assert.deepEqual(audits(), []);
    assert.deepEqual(notifications(), []);
  }
});

test("applyScanResult: a staged (unbound) unscannable row is audited but not notified — the form shows it", async () => {
  const { fx, notifications, audits } = fakeScanDb();
  await applyScanResult(fx, { ...scanTarget, parentId: null, scanAttempts: SCAN_MAX_ATTEMPTS - 1 }, { error: new ClamdErrorReply("x ERROR") });
  assert.equal(audits().length, 1);
  assert.deepEqual(notifications(), []);
});
