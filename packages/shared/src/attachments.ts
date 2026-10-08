// Attachment domain logic (INNOBOX_SPEC.md §11): the content-type allowlist, the MinIO
// object-key builder, the ClamAV INSTREAM protocol framing/parsing, and the anonymity-safe
// client projection (invariant 3 — `uploaded_by` is NEVER emitted). Pure and hermetic:
// object storage, sockets, and DB access all live in the callers (web store / worker sweep),
// so every rule here is unit-testable without a live MinIO or clamd. The author upload/remove
// window reuses the §10.1 edit predicates (canAuthorEditChallenge / canAuthorEditSolution)
// rather than duplicating them.
import { canAuthorEditChallenge, canAuthorEditSolution, type ChallengeStatus, type SolutionStatus } from "./challenges.js";

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

export interface ClamdVerdict {
  clean: boolean;
  /** The matched signature name, present only when `clean === false`. */
  signature?: string;
}

/** Parse a clamd INSTREAM reply into a verdict. `stream: OK` → clean; `stream: <sig> FOUND`
 *  → infected (with the signature); anything else (size limit, engine error, empty) throws so
 *  the caller can treat it as a transient error and retry (the row stays `pending`). */
export function parseClamdResponse(response: string): ClamdVerdict {
  const line = response.replace(/\0/g, "").trim();
  const found = line.match(/^(?:stream:\s*)?(.+?)\s+FOUND$/);
  if (found) return { clean: false, signature: found[1] };
  if (/(?:^|\s)OK$/.test(line)) return { clean: true };
  throw new Error(`clamd returned an error response: ${line || "(empty)"}`);
}

// ── Anonymity-safe client projection (§11, invariant 3) ──────────────────────────────────

export type AttachmentScanStatus = "pending" | "clean" | "infected";

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
 *  `isUploader` boolean drives the per-status affordance ("scanning…" / "failed scan") shown
 *  only to the uploader. */
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
 *  - `pending`/`infected` rows are listed ONLY to the uploader;
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
