// Attachment domain logic (INNOBOX_SPEC.md §11): the content-type allowlist, the content
// (magic-byte) check, the MinIO object-key builder, the chunked-upload size binding, the ClamAV
// INSTREAM protocol framing/parsing, the scan-retry policy, and the anonymity-safe client
// projection (invariant 3 — `uploaded_by` is NEVER emitted). Pure and hermetic: object storage,
// sockets, and DB access all live in the callers (web store / worker sweep), so every rule here
// is unit-testable without a live MinIO or clamd. The one exception is `applyScanResult` at the
// end — the scan-verdict handler, which takes an injected `DbClient` + purge function (as
// audit.ts does) precisely so the web on-demand scan and the worker sweep run ONE
// implementation (§11 "the verdict handler is shared"). The author upload/remove window reuses
// the §10.1 edit predicates (canAuthorEditChallenge / canAuthorEditSolution) rather than
// duplicating them.
import { appendAudit } from "./audit.js";
import { canAuthorEditChallenge, canAuthorEditSolution, type ChallengeStatus, type SolutionStatus } from "./challenges.js";
import type { DbClient } from "./email-graph.js";

// ── Content-type allowlist (§11) ─────────────────────────────────────────────────────────
// BOTH the extension AND the declared MIME must be in the set, else the upload is refused
// (415). SVG is deliberately excluded — it can carry script. Each extension maps to its
// canonical MIME(s); browsers vary on a few (csv/md/zip), so those carry a small set.

const ATTACHMENT_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  // Documents
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ppt: ["application/vnd.ms-powerpoint"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  odt: ["application/vnd.oasis.opendocument.text"],
  ods: ["application/vnd.oasis.opendocument.spreadsheet"],
  odp: ["application/vnd.oasis.opendocument.presentation"],
  rtf: ["application/rtf", "text/rtf"],
  // Text
  txt: ["text/plain"],
  csv: ["text/csv", "application/csv", "text/plain"],
  md: ["text/markdown", "text/x-markdown", "text/plain"],
  // Images (SVG excluded — script vector)
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  // Archives (ClamAV recurses into them during the scan)
  zip: ["application/zip", "application/x-zip-compressed"],
};

/** The allowed extensions (no leading dot), lowercased — handy for the UI's file-input
 *  `accept` attribute and for surfacing the allowlist to users. */
export const ALLOWED_ATTACHMENT_EXTENSIONS: readonly string[] = Object.keys(ATTACHMENT_ALLOWLIST);

/** The bare, lowercased extension of a filename (after the last dot), or "" when there is
 *  no extension. `archive.tar.gz` → `gz`; `README` → ``; `.gitignore` → `gitignore`. */
export function attachmentExtension(filename: string): string {
  const name = filename.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1);
}

/** §11 allowlist gate: the extension must be known AND the declared MIME must be one of that
 *  extension's canonical types. The MIME is normalized (lowercased, `;charset=…` stripped). */
export function isAllowedAttachmentType(filename: string, mime: string): boolean {
  const ext = attachmentExtension(filename);
  if (!ext) return false;
  const allowed = ATTACHMENT_ALLOWLIST[ext];
  if (!allowed) return false;
  const normalized = mime.trim().toLowerCase().split(";", 1)[0]!.trim();
  return allowed.includes(normalized);
}

// ── Content check (§11) ──────────────────────────────────────────────────────────────────
// The extension and the claimed MIME both come from the client, so the server also checks the
// file's LEADING BYTES against its extension. A mismatch is refused (415). A single-shot upload
// is checked at upload; a chunked upload on part 1 (the part carrying the file's first bytes).

/** How many leading bytes the text-type check inspects for a NUL byte. */
export const TEXT_SNIFF_BYTES = 8 * 1024;

const SIG_PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const SIG_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIG_JPEG = [0xff, 0xd8, 0xff];
const SIG_GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]; // GIF87a
const SIG_GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a
const SIG_RIFF = [0x52, 0x49, 0x46, 0x46]; // RIFF
const SIG_WEBP = [0x57, 0x45, 0x42, 0x50]; // WEBP (at offset 8)
const SIG_RTF = [0x7b, 0x5c, 0x72, 0x74, 0x66]; // {\rtf
const SIG_ZIP = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 — ZIP local-file header
const SIG_OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // OLE2 compound file

function startsWithAt(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/** §11 content check: true when `leadingBytes` (the start of the file — at least the first
 *  `TEXT_SNIFF_BYTES` when the file is that long) are consistent with `filename`'s extension:
 *  - pdf `%PDF-`; png the PNG signature; jpg/jpeg `FF D8 FF`; gif `GIF87a`/`GIF89a`;
 *    webp `RIFF…WEBP`; rtf `{\rtf`;
 *  - docx/xlsx/pptx/odt/ods/odp/zip a ZIP local-file header (`PK\x03\x04`);
 *  - doc/xls/ppt the OLE2 compound-file signature;
 *  - txt/csv/md no NUL byte in the first 8 KB.
 *  An unknown extension never matches (the allowlist already refused it). */
export function attachmentContentMatchesType(filename: string, leadingBytes: Uint8Array): boolean {
  const b = leadingBytes;
  switch (attachmentExtension(filename)) {
    case "pdf":
      return startsWithAt(b, SIG_PDF);
    case "png":
      return startsWithAt(b, SIG_PNG);
    case "jpg":
    case "jpeg":
      return startsWithAt(b, SIG_JPEG);
    case "gif":
      return startsWithAt(b, SIG_GIF87) || startsWithAt(b, SIG_GIF89);
    case "webp":
      return startsWithAt(b, SIG_RIFF) && startsWithAt(b, SIG_WEBP, 8);
    case "rtf":
      return startsWithAt(b, SIG_RTF);
    case "docx":
    case "xlsx":
    case "pptx":
    case "odt":
    case "ods":
    case "odp":
    case "zip":
      return startsWithAt(b, SIG_ZIP);
    case "doc":
    case "xls":
    case "ppt":
      return startsWithAt(b, SIG_OLE2);
    case "txt":
    case "csv":
    case "md":
      return !b.subarray(0, TEXT_SNIFF_BYTES).includes(0);
    default:
      return false;
  }
}

// ── Object-key builder (§11) ─────────────────────────────────────────────────────────────

export type AttachmentParentType = "challenge" | "solution";

/** MinIO object key for an attachment: `<parentType>/<parentId>/<attachmentId>`. The web
 *  tier writes here on upload; the worker reads the same key for the ClamAV scan. */
export function attachmentObjectKey(parentType: AttachmentParentType, parentId: string, attachmentId: string): string {
  return `${parentType}/${parentId}/${attachmentId}`;
}

/** MinIO object key for a *staged* attachment (§11 staging): `drafts/<draftKey>/<attachmentId>`.
 *  Staged uploads have no parent yet, so they key off the submission form's `draftKey`. The key is
 *  NEVER rewritten when the row is bound to its new parent, so no object is ever moved in MinIO. */
export function stagedAttachmentObjectKey(draftKey: string, attachmentId: string): string {
  return `drafts/${draftKey}/${attachmentId}`;
}

// ── Chunked-upload sizing (§11) ──────────────────────────────────────────────────────────
// A file larger than the admin-configured chunk size is sliced client-side and uploaded one
// chunk at a time through the server, which relays each chunk to a MinIO multipart upload. Pure
// sizing math lives here so both the client slicer and the server validators agree (and it's
// unit-testable without a browser).

/** The smallest chunk size the admin may configure (MB). Equals the S3/MinIO multipart-upload
 *  part minimum: every part except the last must be ≥ 5 MiB, and since we slice at exactly the
 *  chunk size, keeping the floor at 5 MB guarantees every non-final part is a valid S3 part. */
export const MIN_ATTACHMENT_CHUNK_SIZE_MB = 5;

/** True when a file must be uploaded in chunks rather than a single request: strictly larger
 *  than the chunk size (files ≤ chunk size go single-shot, §11). */
export function shouldChunkUpload(sizeBytes: number, chunkSizeBytes: number): boolean {
  return chunkSizeBytes > 0 && sizeBytes > chunkSizeBytes;
}

export interface AttachmentChunkRange {
  /** 1-based part number (S3 multipart parts are numbered from 1). */
  partNumber: number;
  start: number;
  end: number;
}

/** The ordered byte ranges a file of `sizeBytes` splits into at `chunkSizeBytes`. Every range
 *  except the last is exactly `chunkSizeBytes`; the last may be smaller. Always ≥ 1 range (a
 *  zero-length file yields a single empty range). Part numbers start at 1. */
export function attachmentChunkRanges(sizeBytes: number, chunkSizeBytes: number): AttachmentChunkRange[] {
  if (chunkSizeBytes <= 0) return [{ partNumber: 1, start: 0, end: sizeBytes }];
  const ranges: AttachmentChunkRange[] = [];
  let part = 1;
  for (let start = 0; start < sizeBytes; start += chunkSizeBytes) {
    ranges.push({ partNumber: part, start, end: Math.min(start + chunkSizeBytes, sizeBytes) });
    part += 1;
  }
  if (ranges.length === 0) ranges.push({ partNumber: 1, start: 0, end: 0 });
  return ranges;
}

// ── Chunked-upload size binding (§11) ────────────────────────────────────────────────────
// The declared size is binding: with N = ceil(declared / chunk) parts, part n must be in 1…N,
// every non-final part exactly the chunk size, and the final part exactly the remainder. That
// bounds the stored object to the declared size, which initiate checked against max-upload.

/** N — the number of parts a `declaredSizeBytes` file splits into at `chunkSizeBytes`. */
export function chunkPartCount(declaredSizeBytes: number, chunkSizeBytes: number): number {
  if (chunkSizeBytes <= 0 || declaredSizeBytes <= 0) return 0;
  return Math.ceil(declaredSizeBytes / chunkSizeBytes);
}

/** The exact byte length part `partNumber` must have, or null when the part number is outside
 *  1…N (or not an integer). */
export function expectedChunkPartSize(declaredSizeBytes: number, chunkSizeBytes: number, partNumber: number): number | null {
  const n = chunkPartCount(declaredSizeBytes, chunkSizeBytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > n) return null;
  return partNumber < n ? chunkSizeBytes : declaredSizeBytes - (n - 1) * chunkSizeBytes;
}

export type ChunkPartCheck = { ok: true } | { ok: false; reason: "out_of_range" | "wrong_size" };

/** Validate one incoming part against the session's declared size + chunk size. */
export function checkChunkPart(declaredSizeBytes: number, chunkSizeBytes: number, partNumber: number, partSizeBytes: number): ChunkPartCheck {
  const expected = expectedChunkPartSize(declaredSizeBytes, chunkSizeBytes, partNumber);
  if (expected === null) return { ok: false, reason: "out_of_range" };
  if (partSizeBytes !== expected) return { ok: false, reason: "wrong_size" };
  return { ok: true };
}

/** The assembly check run at complete: the store must hold EXACTLY parts 1…N, each the size
 *  `expectedChunkPartSize` requires (so their sum is the declared size). Returns the verified
 *  total, or null on any mismatch (a missing, extra, duplicated, or wrongly-sized part). */
export function verifyChunkAssembly(
  declaredSizeBytes: number,
  chunkSizeBytes: number,
  parts: readonly { partNumber: number; size: number }[],
): number | null {
  const n = chunkPartCount(declaredSizeBytes, chunkSizeBytes);
  if (n === 0 || parts.length !== n) return null;
  const seen = new Set<number>();
  let total = 0;
  for (const p of parts) {
    if (seen.has(p.partNumber)) return null;
    seen.add(p.partNumber);
    if (expectedChunkPartSize(declaredSizeBytes, chunkSizeBytes, p.partNumber) !== p.size) return null;
    total += p.size;
  }
  return total === declaredSizeBytes ? total : null;
}

// ── Author upload/remove window (§11 → §10.1) ────────────────────────────────────────────

/** Attachments may be added/removed only while the parent is in its author-edit window
 *  (§10.1: challenge awaiting_triage/needs_improvement, solution proposed/needs_improvement).
 *  Reuses the existing §10.1 predicates rather than restating the status sets. */
export function parentAcceptsAttachmentChanges(parentType: AttachmentParentType, status: string): boolean {
  return parentType === "challenge"
    ? canAuthorEditChallenge(status as ChallengeStatus)
    : canAuthorEditSolution(status as SolutionStatus);
}

// ── ClamAV clamd INSTREAM protocol (§11) ─────────────────────────────────────────────────
// clamd INSTREAM: send `zINSTREAM\0`, then a series of chunks each prefixed by its length as
// a 4-byte big-endian (network order) integer, terminated by a zero-length chunk. clamd then
// replies `stream: OK` (clean) or `stream: <Signature> FOUND` (infected); anything else is an
// error. These helpers are pure so the wire framing is unit-testable without a live daemon.

/** The command that opens an INSTREAM session (NUL-terminated, `z` = NUL-delimited replies). */
export const CLAMD_INSTREAM_COMMAND = "zINSTREAM\0";

/** The zero-length chunk that terminates an INSTREAM upload (4 zero bytes). */
export const CLAMD_INSTREAM_TERMINATOR: Uint8Array = new Uint8Array([0, 0, 0, 0]);

/** Frame a chunk for INSTREAM: a 4-byte big-endian length prefix followed by the chunk. */
export function frameInstreamChunk(chunk: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + chunk.length);
  new DataView(framed.buffer).setUint32(0, chunk.length, false); // false = big-endian
  framed.set(chunk, 4);
  return framed;
}

/** What a scanner reads: the object's bytes already in memory (single-shot upload), or a
 *  stream of chunks read from the object store — scanned without ever holding the whole file. */
export type ScanSource = Uint8Array | AsyncIterable<Uint8Array>;

/** The INSTREAM chunk size: each framed chunk carries at most this many bytes. */
export const CLAMD_INSTREAM_CHUNK_BYTES = 64 * 1024;

/** Turns a scan source into INSTREAM-framed chunks of at most `maxChunk` bytes each (a larger
 *  incoming chunk is split; nothing is accumulated, so memory stays at one chunk whatever the
 *  file size). Does NOT emit the command or the terminator — the caller owns the socket.
 *  A failure READING the source (the object-store stream broke mid-file) is rethrown as a
 *  `ScanObjectReadError`, so the §11 retry policy classifies it like a failed object fetch.
 *  Breaking out of the iteration early (clamd answered before the end) returns the source's
 *  iterator, which closes the underlying stream. */
export async function* instreamFrames(source: ScanSource, maxChunk: number = CLAMD_INSTREAM_CHUNK_BYTES): AsyncGenerator<Uint8Array> {
  const split = function* (chunk: Uint8Array): Generator<Uint8Array> {
    for (let off = 0; off < chunk.length; off += maxChunk) {
      yield frameInstreamChunk(chunk.subarray(off, Math.min(off + maxChunk, chunk.length)));
    }
  };
  if (source instanceof Uint8Array) {
    yield* split(source);
    return;
  }
  const it = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try {
        next = await it.next();
      } catch (err) {
        finished = true; // a failed iterator is already closed
        throw new ScanObjectReadError(err);
      }
      if (next.done) {
        finished = true;
        return;
      }
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value as ArrayBufferLike);
      yield* split(chunk);
    }
  } finally {
    // Early exit by the consumer (break / return): close the source stream.
    if (!finished) await it.return?.().catch(() => undefined);
  }
}

export interface ClamdVerdict {
  clean: boolean;
  /** The matched signature name, present only when `clean === false`. */
  signature?: string;
}

/** clamd ANSWERED, but with an error for this stream (e.g. `INSTREAM size limit exceeded.
 *  ERROR`) — a per-file error in the §11 retry taxonomy, not an outage. */
export class ClamdErrorReply extends Error {
  override readonly name = "ClamdErrorReply";
  constructor(readonly reply: string) {
    super(`clamd returned an error response: ${reply}`);
  }
}

/** The object to scan could not be read from the store. Carries the store's error as
 *  `storeError` so `classifyScanFailure` can tell a store outage from a per-file failure. */
export class ScanObjectReadError extends Error {
  override readonly name = "ScanObjectReadError";
  constructor(readonly storeError: unknown) {
    super(`could not read the object to scan: ${String(storeError)}`);
  }
}

/** Parse a clamd INSTREAM reply into a verdict. `stream: OK` → clean; `stream: <sig> FOUND`
 *  → infected (with the signature); any other reply (size limit, engine error) throws a
 *  `ClamdErrorReply` — a per-file error the §11 retry policy counts. An EMPTY reply means clamd
 *  went away without answering — an outage, so a plain Error (never counted). */
export function parseClamdResponse(response: string): ClamdVerdict {
  const line = response.replace(/\0/g, "").trim();
  const found = line.match(/^(?:stream:\s*)?(.+?)\s+FOUND$/);
  if (found) return { clean: false, signature: found[1] };
  if (/(?:^|\s)OK$/.test(line)) return { clean: true };
  if (line === "") throw new Error("clamd closed the connection without a reply");
  throw new ClamdErrorReply(line);
}

// ── Scan retries (§11) ───────────────────────────────────────────────────────────────────
// Two kinds of failure are told apart. ENGINE UNAVAILABLE (clamd unreachable, connection
// refused/reset, timed out, or the object store itself down): the row stays `pending` and
// attempts are NOT counted — an outage never condemns a file. PER-FILE ERROR (clamd answered
// with an error for this stream, or this object could not be read): `scan_attempts` + 1 and
// `next_scan_at` pushed out with exponential backoff (1, 2, 4, 8 … min, capped at 60); at
// SCAN_MAX_ATTEMPTS the row becomes the terminal `unscannable` (purged, uploader notified,
// audited) — so a file is never `pending` forever, and never served without a clean verdict.

/** The attempt count at which a per-file-failing row becomes `unscannable`. */
export const SCAN_MAX_ATTEMPTS = 8;
/** The backoff ceiling between per-file retries, in minutes. */
export const SCAN_BACKOFF_CAP_MINUTES = 60;

/** The wait before the next try after the `attempts`-th per-file failure: 1, 2, 4, 8 … min,
 *  capped at `SCAN_BACKOFF_CAP_MINUTES`. */
export function scanRetryBackoffMinutes(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return 1;
  return Math.min(SCAN_BACKOFF_CAP_MINUTES, 2 ** Math.min(attempts - 1, 30));
}

export type ScanFailureKind = "engine_unavailable" | "file_error";

/** Network-level error codes: the peer (clamd or the object store) is unreachable. */
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function errorField(err: unknown, field: string): unknown {
  return err !== null && typeof err === "object" ? (err as Record<string, unknown>)[field] : undefined;
}

/** True when an object-store error means the store itself is unavailable (a network error,
 *  a client timeout, or a 5xx) rather than this one object being unreadable. */
function isStoreOutage(err: unknown): boolean {
  const code = errorField(err, "code");
  if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return true;
  if (errorField(err, "name") === "TimeoutError") return true;
  const status = (errorField(err, "$metadata") as { httpStatusCode?: unknown } | undefined)?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

/** Classify a scan failure for the §11 retry policy, with a short error CLASS for the log and
 *  the `attachment.scan_unscannable` audit row (never file content, never the raw reply). */
export function classifyScanFailure(err: unknown): { kind: ScanFailureKind; errorClass: string } {
  const name = errorField(err, "name");
  if (err instanceof ClamdErrorReply || name === "ClamdErrorReply") {
    const reply = String(errorField(err, "reply") ?? "");
    return { kind: "file_error", errorClass: /size limit/i.test(reply) ? "clamd_size_limit" : "clamd_error_reply" };
  }
  if (err instanceof ScanObjectReadError || name === "ScanObjectReadError") {
    return isStoreOutage(errorField(err, "storeError"))
      ? { kind: "engine_unavailable", errorClass: "object_store_unavailable" }
      : { kind: "file_error", errorClass: "object_read_failed" };
  }
  // Anything else came from reaching clamd: refused/reset, timed out, closed with no reply,
  // or not configured — all outages.
  const code = errorField(err, "code");
  return { kind: "engine_unavailable", errorClass: typeof code === "string" ? code : "engine_unavailable" };
}

export type ScanFailurePlan =
  | { action: "stay_pending" }
  | { action: "retry"; attempts: number; backoffMinutes: number }
  | { action: "unscannable"; attempts: number };

/** What a failure does to a row that had `previousAttempts` per-file failures so far. */
export function planScanFailure(previousAttempts: number, kind: ScanFailureKind): ScanFailurePlan {
  if (kind === "engine_unavailable") return { action: "stay_pending" };
  const attempts = Math.max(0, previousAttempts) + 1;
  if (attempts >= SCAN_MAX_ATTEMPTS) return { action: "unscannable", attempts };
  return { action: "retry", attempts, backoffMinutes: scanRetryBackoffMinutes(attempts) };
}

// ── Anonymity-safe client projection (§11, invariant 3) ──────────────────────────────────

/** `unscannable` is terminal like `infected` (§11 *Scan retries*): never served, listed only to
 *  the uploader ("removed — couldn't be scanned"), and it blocks the submit scan gate. */
export type AttachmentScanStatus = "pending" | "clean" | "infected" | "unscannable";

/** The server-side attachment row (as read from the DB), including `uploadedBy` — which must
 *  never reach the client. */
export interface AttachmentRecord {
  id: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  scanStatus: AttachmentScanStatus;
  removedAt: string | null;
  uploadedBy: string;
  createdAt: string;
}

/** The client-facing shape. `uploadedBy` is omitted (invariant 3); instead a server-computed
 *  `isUploader` boolean drives the per-status affordance ("scanning…" / "failed scan" /
 *  "couldn't be scanned") shown only to the uploader. */
export interface AttachmentView {
  id: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  status: AttachmentScanStatus;
  isUploader: boolean;
  createdAt: string;
}

/** §11 visibility projection for a viewer who can already see the parent:
 *  - author-removed rows (`removedAt` set) are NEVER listed, to anyone;
 *  - `pending`/`infected`/`unscannable` rows are listed ONLY to the uploader;
 *  - `clean` rows are listed to everyone.
 *  Returns null when the row must not appear for this viewer. Never emits `uploadedBy`. */
export function projectAttachmentForViewer(row: AttachmentRecord, viewerId: string): AttachmentView | null {
  if (row.removedAt !== null) return null;
  const isUploader = row.uploadedBy === viewerId;
  if (row.scanStatus !== "clean" && !isUploader) return null;
  return {
    id: row.id,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    mime: row.mime,
    status: row.scanStatus,
    isUploader,
    createdAt: row.createdAt,
  };
}

/** True when the download gateway may serve bytes for this row (§11 / invariant 4): clean and
 *  not author-removed. Parent-visibility is a separate check the caller layers on top. */
export function isAttachmentDownloadable(row: { scanStatus: AttachmentScanStatus; removedAt: string | null }): boolean {
  return row.scanStatus === "clean" && row.removedAt === null;
}

// ── Shared scan-verdict handler (§11) ────────────────────────────────────────────────────
// ONE implementation of what a scan result does to a row, called by both the web tier's
// on-demand scan and the worker's fallback sweep, so behaviour is identical whichever fires
// first. Every state change is guarded on `scan_status = 'pending'` (and, for the retry
// counter, on the attempt count read), so a verdict for a row already resolved elsewhere — or
// deleted with its parent mid-scan (§10.3) — writes nothing: no audit, no notification.

/** The row being scanned, as read by the caller (camelCased). */
export interface ScanTarget {
  id: string;
  parentType: AttachmentParentType;
  parentId: string | null;
  objectKey: string;
  filename: string;
  uploadedBy: string;
  scanAttempts: number;
}

/** What the caller got: a verdict from clamd, or the error it hit fetching/scanning. */
export type ScanResult = { verdict: ClamdVerdict } | { error: unknown };

/** The effect applied: a verdict, a counted retry, the terminal `unscannable`, an outage that
 *  left the row untouched (`unavailable`), or nothing because the row was resolved elsewhere. */
export type ScanOutcome = "clean" | "infected" | "unscannable" | "retry" | "unavailable" | "noop";

export interface ScanEffects {
  db: DbClient;
  /** Delete the object from the store; the row survives as a tombstone. */
  purgeObject(key: string): Promise<void>;
  log?(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
}

/** The relative deep link to a bound attachment's parent (§12.1), or null when it is unbound
 *  (a staged row has no parent yet — see stagedScanFailedLink) or has vanished. */
async function scanParentLink(db: DbClient, parentType: AttachmentParentType, parentId: string | null): Promise<string | null> {
  if (!parentId) return null;
  if (parentType === "challenge") {
    const { rows } = await db.query<{ number: string }>(`select number::text as number from challenges where id = $1`, [parentId]);
    return rows[0] ? `/challenges/${rows[0].number}` : null;
  }
  const { rows } = await db.query<{ challenge_number: string; number: string }>(
    `select c.number::text as challenge_number, s.number::text as number
       from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [parentId],
  );
  return rows[0] ? `/challenges/${rows[0].challenge_number}#SOL-${rows[0].number}` : null;
}

/** Where an unbound staged upload's notification points (§12.1 event 11): the submission form
 *  the file was staged on. A challenge draft lives on the new-challenge page; a solution draft
 *  lives on its challenge's page, which an unbound row does not record, so it points to the
 *  challenge list. Carries nothing about any item, so it cannot leak one. */
export function stagedScanFailedLink(parentType: AttachmentParentType): string {
  return parentType === "challenge" ? "/challenges/new" : "/challenges";
}

/** §12.1 event 11: notify the uploader (only) that their attachment failed its scan or
 *  couldn't be scanned — bound OR staged (§11: "uploader notified", no exception for a file
 *  still on a submission form). The message names only the uploader's own filename — they are
 *  the sole recipient, so it is anonymity-safe. Writes the in-app row and the outbox row,
 *  exactly like the web notify helper. A bound row links to its parent; an unbound staged row
 *  links to its submission form (stagedScanFailedLink); a bound row whose parent has since
 *  vanished is skipped (nothing to link to, and the attachment went with it). */
async function enqueueScanFailedNotification(db: DbClient, target: ScanTarget, reason: "infected" | "unscannable"): Promise<void> {
  const link = target.parentId === null ? stagedScanFailedLink(target.parentType) : await scanParentLink(db, target.parentType, target.parentId);
  if (!link) return;
  const message =
    reason === "infected"
      ? `Your attachment "${target.filename}" failed its virus scan and was removed.`
      : `Your attachment "${target.filename}" couldn't be scanned and was removed.`;
  const payload = JSON.stringify({ message, link });
  await db.query(`insert into notifications (user_id, type, payload) values ($1, 'attachment_scan_failed', $2)`, [target.uploadedBy, payload]);
  await db.query(`insert into notification_outbox (user_id, type, payload) values ($1, 'attachment_scan_failed', $2)`, [target.uploadedBy, payload]);
}

/** Purge, then audit + notify — the shared tail of the two terminal failure states. A failed
 *  purge is logged, not fatal: the status already blocks every download. */
async function condemn(fx: ScanEffects, target: ScanTarget, reason: "infected" | "unscannable", after: Record<string, unknown>): Promise<void> {
  await fx.purgeObject(target.objectKey).catch((err) =>
    fx.log?.("error", `scan: ${reason} object purge failed`, { attachmentId: target.id, error: String(err) }),
  );
  await appendAudit(fx.db, {
    actorUserId: null,
    action: reason === "infected" ? "attachment.scan_infected" : "attachment.scan_unscannable",
    targetType: "attachment",
    targetId: target.id,
    after: { ...after, objectKey: target.objectKey },
  });
  await enqueueScanFailedNotification(fx.db, target, reason).catch((err) =>
    fx.log?.("error", "scan: notify failed", { attachmentId: target.id, error: String(err) }),
  );
}

/** Apply one scan result to its row (§11). Clean → `clean` + audit. Infected → `infected`,
 *  object purged, uploader notified (event 11), audited. A failure is classified: an outage
 *  leaves the row exactly as it was; a per-file error bumps `scan_attempts` and backs
 *  `next_scan_at` off, and at the attempt cap the row becomes `unscannable` — purged, notified,
 *  and audited with the error class (never file content). */
export async function applyScanResult(fx: ScanEffects, target: ScanTarget, result: ScanResult): Promise<ScanOutcome> {
  if ("verdict" in result) {
    if (result.verdict.clean) {
      const applied = await fx.db.query(
        `update attachments set scan_status = 'clean', scanned_at = now(), next_scan_at = null where id = $1 and scan_status = 'pending'`,
        [target.id],
      );
      if (!applied.rowCount) return "noop";
      await appendAudit(fx.db, {
        actorUserId: null,
        action: "attachment.scan_clean",
        targetType: "attachment",
        targetId: target.id,
        after: { objectKey: target.objectKey },
      });
      return "clean";
    }
    const applied = await fx.db.query(
      `update attachments set scan_status = 'infected', scanned_at = now(), next_scan_at = null where id = $1 and scan_status = 'pending'`,
      [target.id],
    );
    if (!applied.rowCount) return "noop";
    await condemn(fx, target, "infected", { signature: result.verdict.signature ?? null });
    return "infected";
  }

  const { kind, errorClass } = classifyScanFailure(result.error);
  const plan = planScanFailure(target.scanAttempts, kind);
  if (plan.action === "stay_pending") {
    fx.log?.("warn", "scan: engine unavailable, leaving pending", { attachmentId: target.id, errorClass, error: String(result.error) });
    return "unavailable";
  }
  if (plan.action === "retry") {
    const applied = await fx.db.query(
      `update attachments set scan_attempts = $2, next_scan_at = now() + make_interval(mins => $3::int)
        where id = $1 and scan_status = 'pending' and scan_attempts = $4`,
      [target.id, plan.attempts, plan.backoffMinutes, target.scanAttempts],
    );
    if (!applied.rowCount) return "noop";
    fx.log?.("warn", "scan: per-file error, will retry", { attachmentId: target.id, errorClass, attempts: plan.attempts, backoffMinutes: plan.backoffMinutes });
    return "retry";
  }
  const applied = await fx.db.query(
    `update attachments set scan_status = 'unscannable', scanned_at = now(), scan_attempts = $2, next_scan_at = null
      where id = $1 and scan_status = 'pending' and scan_attempts = $3`,
    [target.id, plan.attempts, target.scanAttempts],
  );
  if (!applied.rowCount) return "noop";
  await condemn(fx, target, "unscannable", { errorClass, attempts: plan.attempts });
  return "unscannable";
}
