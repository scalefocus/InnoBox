// Unit tests for the §11 attachment domain logic — allowlist, object key, INSTREAM framing,
// clamd response parsing, the author window predicate, and the anonymity-safe projection.
// Pure and hermetic (node:test + node:assert/strict), mirroring challenges.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  attachmentChunkRanges,
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

test("parseClamdResponse: anything else throws (transient/engine error)", () => {
  assert.throws(() => parseClamdResponse("INSTREAM size limit exceeded. ERROR"));
  assert.throws(() => parseClamdResponse(""));
  assert.throws(() => parseClamdResponse("some unexpected garbage"));
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
