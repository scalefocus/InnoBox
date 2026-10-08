// Data layer for attachments (INNOBOX_SPEC.md §11). Enforces the author-only + edit-window
// upload/remove rules (§10.1), the §14.3 limits (the per-item cap atomically, under
// concurrency), the content-type allowlist + content (magic-byte) check, the chunked-upload size
// binding, and the download gateway's parent-visibility + clean-scan gate (invariant 4). Anonymity is preserved here:
// list projections never emit `uploaded_by` (invariant 3). Object bytes live in MinIO, injected
// as a `StorageClient` so this module is unit-testable without live object storage. Imports stay
// relative (not @/) so the gated dbtest runs under the plain node test runner.
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  attachmentContentMatchesType,
  attachmentObjectKey,
  checkChunkPart,
  isAllowedAttachmentType,
  isAttachmentDownloadable,
  parentAcceptsAttachmentChanges,
  projectAttachmentForViewer,
  stagedAttachmentObjectKey,
  verifyChunkAssembly,
  type AttachmentParentType,
  type AttachmentRecord,
  type AttachmentScanStatus,
  type AttachmentView,
  type ClamdVerdict,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import type { StorageClient } from "../../../lib/storage";
import { getAttachmentLimits } from "../admin/settings/store";
import { isParentVisible, type Viewer } from "../challenges/store";
import { scanAttachmentNow } from "./scan";

/** Stale chunked-upload sessions older than this are aborted at the next initiate (and by the
 *  worker backstop) — INNOBOX_SPEC.md §11 *Upload-session GC*. */
export const UPLOAD_SESSION_TTL_HOURS = 2;

/** Dependencies threaded into the write/download paths — the DB pool, the (injectable)
 *  object store, and optionally a stand-in for clamd. Tests pass an in-memory fake `storage`
 *  (and a fake `scan` where the on-demand verdict matters). */
export interface AttachmentDeps {
  pool: Pool;
  storage: StorageClient;
  scan?: (bytes: Uint8Array) => Promise<ClamdVerdict>;
}

interface AttachmentDbRow {
  id: string;
  parent_type: AttachmentParentType;
  parent_id: string | null;
  filename: string;
  size_bytes: string; // bigint → string from pg
  mime: string;
  object_key: string;
  scan_status: AttachmentScanStatus;
  removed_at: Date | null;
  uploaded_by: string;
  created_at: Date;
}

const ATTACHMENT_COLUMNS = `id, parent_type, parent_id, filename, size_bytes, mime, object_key, scan_status, removed_at, uploaded_by, created_at`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function toRecord(row: AttachmentDbRow): AttachmentRecord {
  return {
    id: row.id,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    mime: row.mime,
    scanStatus: row.scan_status,
    removedAt: row.removed_at ? row.removed_at.toISOString() : null,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at.toISOString(),
  };
}

/** The parent's author + current status, or null when it doesn't exist. */
async function loadParent(
  pool: Pool | PoolClient,
  parentType: AttachmentParentType,
  parentId: string,
): Promise<{ authorId: string; status: string } | null> {
  if (!isUuid(parentId)) return null;
  const table = parentType === "challenge" ? "challenges" : "solutions";
  const { rows } = await pool.query<{ author_id: string; status: string }>(
    `select author_id, status from ${table} where id = $1`,
    [parentId],
  );
  const row = rows[0];
  return row ? { authorId: row.author_id, status: row.status } : null;
}

async function auditDownloadDenied(pool: Pool, viewerId: string, attachmentId: string): Promise<void> {
  await appendAudit(pool, {
    actorUserId: viewerId,
    action: "attachment.download_denied",
    targetType: "attachment",
    targetId: attachmentId,
  }).catch(() => {});
}

// ── Per-item cap (§11 / §14.3), atomic under concurrency ─────────────────────────────────

/** Where an upload lands: a bound parent, or the caller's staged draft. The §14.3 cap counts
 *  that target's non-removed rows (a staged draft counts only the uploader's own rows). */
type CapTarget =
  | { kind: "parent"; parentType: AttachmentParentType; parentId: string }
  | { kind: "draft"; draftKey: string; uploaderId: string };

async function countLiveAttachments(db: Pool | PoolClient, target: CapTarget): Promise<number> {
  const { rows } =
    target.kind === "parent"
      ? await db.query<{ n: string }>(
          `select count(*)::text as n from attachments where parent_type = $1 and parent_id = $2 and removed_at is null`,
          [target.parentType, target.parentId],
        )
      : await db.query<{ n: string }>(
          `select count(*)::text as n from attachments where draft_key = $1 and uploaded_by = $2 and removed_at is null`,
          [target.draftKey, target.uploaderId],
        );
  return Number(rows[0]!.n);
}

/** Serialize every upload into one target for the rest of the transaction: a transaction-scoped
 *  advisory lock keyed on the parent (or draft + uploader), so "count, then insert" is atomic —
 *  two uploads racing for the last slot cannot both succeed (§11). Released at COMMIT/ROLLBACK. */
async function lockCapTarget(client: PoolClient, target: CapTarget): Promise<void> {
  const key =
    target.kind === "parent"
      ? `innobox.attachments:${target.parentType}:${target.parentId}`
      : `innobox.attachments:draft:${target.draftKey}:${target.uploaderId}`;
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

// ── List (anonymity-safe projection) ──────────────────────────────────────────────────────

/** The visible attachments for a parent, for a viewer who can already see the parent (§4.3).
 *  Removed rows are excluded for everyone; pending/infected only for the uploader; clean for
 *  all. Never emits `uploaded_by` (invariant 3). Accepts a Pool or a transaction client so the
 *  challenge/solution detail assembly can call it inline. */
export async function listAttachmentsForParent(
  db: Pool | PoolClient,
  viewer: Viewer,
  parentType: AttachmentParentType,
  parentId: string,
): Promise<AttachmentView[]> {
  const { rows } = await db.query<AttachmentDbRow>(
    `select ${ATTACHMENT_COLUMNS} from attachments where parent_type = $1 and parent_id = $2 order by created_at asc`,
    [parentType, parentId],
  );
  const out: AttachmentView[] = [];
  for (const row of rows) {
    const view = projectAttachmentForViewer(toRecord(row), viewer.userId);
    if (view) out.push(view);
  }
  return out;
}

// ── Upload (§11: author-only, edit-window, limits, allowlist) ─────────────────────────────

export type UploadAttachmentResult =
  | { status: "ok"; attachment: AttachmentView }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "too_many" }
  | { status: "too_large" }
  | { status: "unsupported_type" }
  | { status: "content_mismatch" };

export async function uploadAttachment(
  deps: AttachmentDeps,
  viewer: Viewer,
  input: {
    parentType: AttachmentParentType;
    parentId: string;
    filename: string;
    mime: string;
    size: number;
    bytes: Uint8Array;
  },
): Promise<UploadAttachmentResult> {
  const parent = await loadParent(deps.pool, input.parentType, input.parentId);
  if (!parent) return { status: "not_found" };
  // Author-only, and only within the parent's §10.1 author-edit window.
  if (parent.authorId !== viewer.userId) return { status: "forbidden" };
  if (!parentAcceptsAttachmentChanges(input.parentType, parent.status)) return { status: "not_editable" };

  // Allowlist (415) — both extension AND declared MIME must be in the set — and the content
  // check (415): the leading bytes must match the extension (§11).
  if (!isAllowedAttachmentType(input.filename, input.mime)) return { status: "unsupported_type" };
  if (!attachmentContentMatchesType(input.filename, input.bytes)) return { status: "content_mismatch" };

  // §14.3 limits: over-size → 413, over-count → 409 (only non-removed rows count). This first
  // count is a fast-fail; the authoritative one runs under the cap lock below.
  const limits = await getAttachmentLimits(deps.pool);
  if (input.size > limits.maxUploadSizeMb * 1024 * 1024) return { status: "too_large" };
  const capTarget: CapTarget = { kind: "parent", parentType: input.parentType, parentId: input.parentId };
  if ((await countLiveAttachments(deps.pool, capTarget)) >= limits.maxPerItem) return { status: "too_many" };

  // Write the bytes BEFORE the DB row so a committed row always has an object; compensate by
  // purging the orphan object if the insert fails or loses the race for the last slot (§11).
  const id = randomUUID();
  const objectKey = attachmentObjectKey(input.parentType, input.parentId, id);
  await deps.storage.putObject(objectKey, input.bytes, input.mime);
  try {
    const result = await inTransaction(deps.pool, async (client): Promise<UploadAttachmentResult> => {
      await lockCapTarget(client, capTarget);
      if ((await countLiveAttachments(client, capTarget)) >= limits.maxPerItem) return { status: "too_many" };
      const { rows } = await client.query<AttachmentDbRow>(
        `insert into attachments (id, parent_type, parent_id, filename, size_bytes, mime, object_key, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${ATTACHMENT_COLUMNS}`,
        [id, input.parentType, input.parentId, input.filename, input.size, input.mime, objectKey, viewer.userId],
      );
      const row = rows[0]!;
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "attachment.uploaded",
        targetType: "attachment",
        targetId: id,
        after: {
          parentType: input.parentType,
          parentId: input.parentId,
          filename: input.filename,
          sizeBytes: input.size,
          mime: input.mime,
        },
      });
      // The uploader is, by construction, the viewer — so isUploader is true and the pending
      // status surfaces to them immediately.
      return { status: "ok" as const, attachment: projectAttachmentForViewer(toRecord(row), viewer.userId)! };
    });
    if (result.status !== "ok") {
      await deps.storage.deleteObject(objectKey).catch(() => {});
      return result;
    }
    // On-demand scan (§11): fire-and-forget so the response stays fast and the UI shows the
    // distinct "Scanning…" phase; we already hold the bytes, so no re-read. The worker sweep is
    // the fallback if this process is interrupted before the verdict lands.
    void scanAttachmentNow(deps, id, { bytes: input.bytes });
    return result;
  } catch (err) {
    await deps.storage.deleteObject(objectKey).catch(() => {});
    throw err;
  }
}

// ── Staged upload (§11 staging: submission-time, before the parent exists) ────────────────

export type StageAttachmentResult =
  | { status: "ok"; attachment: AttachmentView }
  | { status: "too_many" }
  | { status: "too_large" }
  | { status: "unsupported_type" }
  | { status: "content_mismatch" };

/** Stage a file under a submission form's `draftKey` (no parent yet, §6.1/§6.2). Any
 *  authenticated user may stage; the §14.3 cap + size/type limits apply to the caller's own
 *  non-removed rows for that draftKey. The row is inserted `pending` (the scan sweep picks it up
 *  unchanged) and is later bound to the new item by `bindStagedAttachments`. */
export async function stageAttachment(
  deps: AttachmentDeps,
  viewer: Viewer,
  input: {
    parentType: AttachmentParentType;
    draftKey: string;
    filename: string;
    mime: string;
    size: number;
    bytes: Uint8Array;
  },
): Promise<StageAttachmentResult> {
  // Allowlist (415) — both extension AND declared MIME must be in the set — and the content
  // check (415): the leading bytes must match the extension (§11).
  if (!isAllowedAttachmentType(input.filename, input.mime)) return { status: "unsupported_type" };
  if (!attachmentContentMatchesType(input.filename, input.bytes)) return { status: "content_mismatch" };

  // §14.3 limits: over-size → 413; over-count (per draftKey + uploader) → 409, re-checked
  // atomically under the cap lock below.
  const limits = await getAttachmentLimits(deps.pool);
  if (input.size > limits.maxUploadSizeMb * 1024 * 1024) return { status: "too_large" };
  const capTarget: CapTarget = { kind: "draft", draftKey: input.draftKey, uploaderId: viewer.userId };
  if ((await countLiveAttachments(deps.pool, capTarget)) >= limits.maxPerItem) return { status: "too_many" };

  // Write bytes BEFORE the row (as with bound uploads), compensating on insert failure.
  const id = randomUUID();
  const objectKey = stagedAttachmentObjectKey(input.draftKey, id);
  await deps.storage.putObject(objectKey, input.bytes, input.mime);
  try {
    const result = await inTransaction(deps.pool, async (client): Promise<StageAttachmentResult> => {
      await lockCapTarget(client, capTarget);
      if ((await countLiveAttachments(client, capTarget)) >= limits.maxPerItem) return { status: "too_many" };
      const { rows } = await client.query<AttachmentDbRow>(
        `insert into attachments (id, parent_type, parent_id, draft_key, filename, size_bytes, mime, object_key, uploaded_by)
         values ($1, $2, null, $3, $4, $5, $6, $7, $8)
         returning ${ATTACHMENT_COLUMNS}`,
        [id, input.parentType, input.draftKey, input.filename, input.size, input.mime, objectKey, viewer.userId],
      );
      const row = rows[0]!;
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "attachment.uploaded",
        targetType: "attachment",
        targetId: id,
        after: { parentType: input.parentType, draftKey: input.draftKey, filename: input.filename, sizeBytes: input.size, mime: input.mime, staged: true },
      });
      return { status: "ok" as const, attachment: projectAttachmentForViewer(toRecord(row), viewer.userId)! };
    });
    if (result.status !== "ok") {
      await deps.storage.deleteObject(objectKey).catch(() => {});
      return result;
    }
    // On-demand scan (§11), fire-and-forget — same as bound uploads.
    void scanAttachmentNow(deps, id, { bytes: input.bytes });
    return result;
  } catch (err) {
    await deps.storage.deleteObject(objectKey).catch(() => {});
    throw err;
  }
}

/** The caller's own staged attachments for a `draftKey` (status only — bytes are never served
 *  for an unbound row). Scoped to `uploaded_by = viewer`, so nobody can read another user's
 *  staged files even with their draftKey. Removed rows are excluded (projection). */
export async function listStagedAttachments(pool: Pool, viewer: Viewer, draftKey: string): Promise<AttachmentView[]> {
  if (!isUuid(draftKey)) return [];
  const { rows } = await pool.query<AttachmentDbRow>(
    `select ${ATTACHMENT_COLUMNS} from attachments where draft_key = $1 and uploaded_by = $2 order by created_at asc`,
    [draftKey, viewer.userId],
  );
  const out: AttachmentView[] = [];
  for (const row of rows) {
    const view = projectAttachmentForViewer(toRecord(row), viewer.userId);
    if (view) out.push(view);
  }
  return out;
}

/** Bind the caller's staged rows for `draftKey` to a freshly-created parent, inside the create
 *  transaction (§11 binding). Only the caller's own unbound, matching-type rows are taken, at
 *  most `maxPerItem` (oldest first — defence in depth; staging already enforced the cap). The
 *  object_key is left untouched (no MinIO move). A foreign draftKey binds nothing. */
export async function bindStagedAttachments(
  client: PoolClient,
  viewer: Viewer,
  parentType: AttachmentParentType,
  parentId: string,
  draftKey: string,
  maxPerItem: number,
): Promise<void> {
  if (!isUuid(draftKey)) return;
  const { rows } = await client.query<{ id: string }>(
    `update attachments set parent_id = $1, draft_key = null
      where id in (
        select id from attachments
         where draft_key = $2 and uploaded_by = $3 and parent_type = $4 and parent_id is null and removed_at is null
         order by created_at asc
         limit $5
      )
      returning id`,
    [parentId, draftKey, viewer.userId, parentType, maxPerItem],
  );
  for (const row of rows) {
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "attachment.bound",
      targetType: "attachment",
      targetId: row.id,
      after: { parentType, parentId, draftKey },
    });
  }
}

// ── Author removal (§11: uploader-only, edit-window; soft-remove + object purge) ──────────

export type RemoveAttachmentResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "already_removed" };

export async function removeAttachment(
  deps: AttachmentDeps,
  viewer: Viewer,
  attachmentId: string,
): Promise<RemoveAttachmentResult> {
  if (!isUuid(attachmentId)) return { status: "not_found" };
  const { rows } = await deps.pool.query<{
    id: string;
    parent_type: AttachmentParentType;
    parent_id: string | null;
    uploaded_by: string;
    scan_status: string;
    removed_at: Date | null;
    object_key: string;
  }>(
    `select id, parent_type, parent_id, uploaded_by, scan_status, removed_at, object_key from attachments where id = $1`,
    [attachmentId],
  );
  const att = rows[0];
  if (!att) return { status: "not_found" };
  if (att.uploaded_by !== viewer.userId) {
    // §2.4: 403 only for an attachment this viewer can actually see (bound, clean, not removed,
    // parent visible) — anything else is the same 404 as a nonexistent id.
    const seen =
      att.parent_id !== null &&
      att.scan_status === "clean" &&
      att.removed_at === null &&
      (await isParentVisible(deps.pool, viewer, att.parent_type, att.parent_id));
    return { status: seen ? "forbidden" : "not_found" };
  }
  if (att.removed_at !== null) return { status: "already_removed" };

  // Unbound staged rows (§11): the uploader may remove them at any time — no parent, no
  // edit-window. Bound rows keep the §10.1 author-edit-window gate.
  if (att.parent_id !== null) {
    const parent = await loadParent(deps.pool, att.parent_type, att.parent_id);
    if (!parent) return { status: "not_found" };
    if (!parentAcceptsAttachmentChanges(att.parent_type, parent.status)) return { status: "not_editable" };
  }

  await inTransaction(deps.pool, async (client) => {
    // The `removed_at is null` guard double-protects against a concurrent second remove.
    await client.query(`update attachments set removed_at = now() where id = $1 and removed_at is null`, [attachmentId]);
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "attachment.removed",
      targetType: "attachment",
      targetId: attachmentId,
      after: { parentType: att.parent_type, parentId: att.parent_id },
    });
  });
  // Purge the object after the tombstone commits. A failed purge leaves orphaned bytes that
  // are never served (removed_at is set), so log-and-continue rather than fail the request.
  await deps.storage.deleteObject(att.object_key).catch((err) => {
    console.error(JSON.stringify({ level: "error", msg: "attachment object purge failed", attachmentId, error: String(err) }));
  });
  return { status: "ok" };
}

// ── Download gateway (invariant 4) ────────────────────────────────────────────────────────

export type DownloadAttachmentResult =
  | { status: "ok"; filename: string; mime: string; sizeBytes: number; body: ReadableStream<Uint8Array> }
  | { status: "denied" };

/** Serve bytes ONLY when the row is clean, not removed, and the viewer can see the parent.
 *  Every other outcome is folded into a single `denied` (mapped to an identical 404 by the
 *  route) and audited `attachment.download_denied` — no not-found / not-visible / not-clean
 *  oracle. Never emits a presigned/direct MinIO URL. The object is opened as a STREAM (§11):
 *  the route pipes it to the client, never buffering the whole file in memory. */
export async function getAttachmentForDownload(
  deps: AttachmentDeps,
  viewer: Viewer,
  attachmentId: string,
): Promise<DownloadAttachmentResult> {
  if (!isUuid(attachmentId)) {
    await auditDownloadDenied(deps.pool, viewer.userId, attachmentId);
    return { status: "denied" };
  }
  const { rows } = await deps.pool.query<AttachmentDbRow>(
    `select ${ATTACHMENT_COLUMNS} from attachments where id = $1`,
    [attachmentId],
  );
  const att = rows[0];
  // Unbound staged rows (parent_id null) are NEVER downloadable (§11) — deny like any other,
  // no oracle.
  if (
    !att ||
    att.parent_id === null ||
    !isAttachmentDownloadable({ scanStatus: att.scan_status, removedAt: att.removed_at ? att.removed_at.toISOString() : null })
  ) {
    await auditDownloadDenied(deps.pool, viewer.userId, attachmentId);
    return { status: "denied" };
  }
  const visible = await isParentVisible(deps.pool, viewer, att.parent_type, att.parent_id);
  if (!visible) {
    await auditDownloadDenied(deps.pool, viewer.userId, attachmentId);
    return { status: "denied" };
  }
  try {
    const { body, contentLength } = await deps.storage.getObjectStream(att.object_key);
    return { status: "ok", filename: att.filename, mime: att.mime, sizeBytes: contentLength ?? Number(att.size_bytes), body };
  } catch {
    // A missing/unreadable object is a denial too — identical 404, no 500 oracle.
    await auditDownloadDenied(deps.pool, viewer.userId, attachmentId);
    return { status: "denied" };
  }
}

// ── Submit scan gate (§11 → §6.1/§6.2) ─────────────────────────────────────────────────────

/** True when any of the caller's own non-removed staged rows for `draftKey` is still `pending`,
 *  `infected`, or `unscannable`. The create path consults this only when a scanner is available
 *  (§11): if so it refuses to bind, so a submitted item is only ever born with `clean`
 *  attachments. */
export async function hasUncleanStagedAttachments(
  pool: Pool,
  viewer: Viewer,
  parentType: AttachmentParentType,
  draftKey: string,
): Promise<boolean> {
  if (!isUuid(draftKey)) return false;
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from attachments
      where draft_key = $1 and uploaded_by = $2 and parent_type = $3 and removed_at is null
        and scan_status in ('pending','infected','unscannable')`,
    [draftKey, viewer.userId, parentType],
  );
  return Number(rows[0]!.n) > 0;
}

// ── Chunked upload (§11: files > chunk size — server-proxied MinIO multipart) ──────────────

interface UploadSessionRow {
  id: string;
  attachment_id: string;
  parent_type: AttachmentParentType;
  parent_id: string | null;
  draft_key: string | null;
  filename: string;
  mime: string;
  declared_size_bytes: string; // bigint → string
  object_key: string;
  s3_upload_id: string;
  chunk_size_bytes: string; // bigint → string
  uploaded_by: string;
}

const UPLOAD_SESSION_COLUMNS = `id, attachment_id, parent_type, parent_id, draft_key, filename, mime, declared_size_bytes, object_key, s3_upload_id, chunk_size_bytes, uploaded_by`;

/** Abort the caller's own chunked-upload sessions older than the TTL (§11 *Upload-session GC*):
 *  free the orphaned MinIO parts, drop the session row, audit `attachment.upload_aborted`. Called
 *  at every initiate; the worker sweep does the same across all sessions as a backstop. */
async function abortStaleUploadSessions(deps: AttachmentDeps, uploaderId: string): Promise<void> {
  const { rows } = await deps.pool.query<{ id: string; attachment_id: string; object_key: string; s3_upload_id: string }>(
    `select id, attachment_id, object_key, s3_upload_id from attachment_uploads
      where uploaded_by = $1 and created_at < now() - make_interval(hours => $2)`,
    [uploaderId, UPLOAD_SESSION_TTL_HOURS],
  );
  for (const row of rows) {
    await deps.storage.abortMultipartUpload(row.object_key, row.s3_upload_id).catch(() => {});
    await deps.pool.query(`delete from attachment_uploads where id = $1`, [row.id]);
    await appendAudit(deps.pool, {
      actorUserId: uploaderId,
      action: "attachment.upload_aborted",
      targetType: "attachment",
      targetId: row.attachment_id,
      after: { objectKey: row.object_key, reason: "stale" },
    }).catch(() => {});
  }
}

export type InitiateUploadResult =
  | { status: "ok"; uploadId: string; chunkSizeBytes: number }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "too_many" }
  | { status: "too_large" }
  | { status: "unsupported_type" };

/** Open a chunked upload (§11). Validates the §14.3 cap, size ≤ max-upload, and the
 *  extension+MIME allowlist UP FRONT (fail-fast), pre-allocates the attachment id + object key,
 *  opens a MinIO multipart upload, and records the session. Targets a bound parent (`parentId`,
 *  author + edit-window checked) or a staged draft (`draftKey`), exactly like the single-shot path. */
export async function initiateChunkedUpload(
  deps: AttachmentDeps,
  viewer: Viewer,
  input: {
    parentType: AttachmentParentType;
    parentId?: string;
    draftKey?: string;
    filename: string;
    mime: string;
    size: number;
  },
): Promise<InitiateUploadResult> {
  const staged = typeof input.draftKey === "string" && input.draftKey !== "";

  // Allowlist (415) — both extension AND declared MIME must be in the set.
  if (!isAllowedAttachmentType(input.filename, input.mime)) return { status: "unsupported_type" };

  const limits = await getAttachmentLimits(deps.pool);
  if (input.size > limits.maxUploadSizeMb * 1024 * 1024) return { status: "too_large" };

  const attachmentId = randomUUID();
  let objectKey: string;

  if (staged) {
    const draftKey = input.draftKey!;
    if (!isUuid(draftKey)) return { status: "not_found" };
    if ((await countLiveAttachments(deps.pool, { kind: "draft", draftKey, uploaderId: viewer.userId })) >= limits.maxPerItem) {
      return { status: "too_many" };
    }
    objectKey = stagedAttachmentObjectKey(draftKey, attachmentId);
  } else {
    const parentId = input.parentId;
    if (typeof parentId !== "string" || !isUuid(parentId)) return { status: "not_found" };
    const parent = await loadParent(deps.pool, input.parentType, parentId);
    if (!parent) return { status: "not_found" };
    if (parent.authorId !== viewer.userId) return { status: "forbidden" };
    if (!parentAcceptsAttachmentChanges(input.parentType, parent.status)) return { status: "not_editable" };
    if ((await countLiveAttachments(deps.pool, { kind: "parent", parentType: input.parentType, parentId })) >= limits.maxPerItem) {
      return { status: "too_many" };
    }
    objectKey = attachmentObjectKey(input.parentType, parentId, attachmentId);
  }

  // Reap the caller's own abandoned sessions before opening a new one (§11).
  await abortStaleUploadSessions(deps, viewer.userId);

  const chunkSizeBytes = limits.chunkSizeMb * 1024 * 1024;
  const s3UploadId = await deps.storage.createMultipartUpload(objectKey, input.mime);
  try {
    const { rows } = await deps.pool.query<{ id: string }>(
      `insert into attachment_uploads (attachment_id, parent_type, parent_id, draft_key, filename, mime, declared_size_bytes, object_key, s3_upload_id, chunk_size_bytes, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        attachmentId,
        input.parentType,
        staged ? null : input.parentId,
        staged ? input.draftKey : null,
        input.filename,
        input.mime,
        input.size,
        objectKey,
        s3UploadId,
        chunkSizeBytes,
        viewer.userId,
      ],
    );
    return { status: "ok", uploadId: rows[0]!.id, chunkSizeBytes };
  } catch (err) {
    // Couldn't record the session — abort the multipart so no orphaned parts linger.
    await deps.storage.abortMultipartUpload(objectKey, s3UploadId).catch(() => {});
    throw err;
  }
}

/** Load a session the caller owns, by its client-facing upload id. */
async function loadOwnUploadSession(pool: Pool, viewer: Viewer, uploadId: string): Promise<UploadSessionRow | null> {
  if (!isUuid(uploadId)) return null;
  const { rows } = await pool.query<UploadSessionRow>(
    `select ${UPLOAD_SESSION_COLUMNS} from attachment_uploads where id = $1 and uploaded_by = $2`,
    [uploadId, viewer.userId],
  );
  return rows[0] ?? null;
}

/** The negotiated chunk size of a session the caller owns, or null when there is no such
 *  session — the parts route caps the request body at this BEFORE reading it (§2.4). */
export async function getOwnUploadChunkSize(pool: Pool, viewer: Viewer, uploadId: string): Promise<number | null> {
  const session = await loadOwnUploadSession(pool, viewer, uploadId);
  return session ? Number(session.chunk_size_bytes) : null;
}

export type UploadChunkResult =
  | { status: "ok" }
  | { status: "not_found" }
  | { status: "bad_request"; error: string }
  | { status: "content_mismatch" };

/** Relay one chunk to the open MinIO multipart upload as part `partNumber` (1-based, §11). The
 *  declared size is binding: the part number must be in 1…N and the part exactly the size the
 *  binding requires (`checkChunkPart`), else 400 with nothing relayed. Part 1 carries the file's
 *  first bytes, so the content check runs on it (415). Re-sending a part number replaces it. */
export async function uploadChunkPart(
  deps: AttachmentDeps,
  viewer: Viewer,
  uploadId: string,
  partNumber: number,
  bytes: Uint8Array,
): Promise<UploadChunkResult> {
  if (!Number.isInteger(partNumber) || partNumber < 1) return { status: "bad_request", error: "partNumber must be a positive integer" };
  const session = await loadOwnUploadSession(deps.pool, viewer, uploadId);
  if (!session) return { status: "not_found" };
  const check = checkChunkPart(Number(session.declared_size_bytes), Number(session.chunk_size_bytes), partNumber, bytes.byteLength);
  if (!check.ok) {
    return {
      status: "bad_request",
      error:
        check.reason === "out_of_range"
          ? "that part number is outside this upload"
          : "the part's size does not match the upload's declared size",
    };
  }
  if (partNumber === 1 && !attachmentContentMatchesType(session.filename, bytes)) return { status: "content_mismatch" };
  await deps.storage.uploadPart(session.object_key, session.s3_upload_id, partNumber, bytes);
  return { status: "ok" };
}

export type CompleteUploadResult =
  | { status: "ok"; attachment: AttachmentView }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "too_many" }
  | { status: "upload_incomplete" };

/** Assemble the parts into the immutable object and materialize the `pending` attachments row
 *  (§11). First VERIFIES the assembly against the store: it must hold exactly parts 1…N with the
 *  sizes the declared-size binding requires — on any mismatch the upload is aborted, the session
 *  dropped, `attachment.upload_aborted` audited (reason `size_mismatch`), and the result is
 *  `upload_incomplete`. Then re-checks the bound edit-window + the per-item cap (the parent may
 *  have transitioned, or a sibling upload completed, since initiate); on failure the multipart is
 *  aborted and nothing is inserted. The final cap check + insert run under the cap lock. On
 *  success the row records the verified size and the on-demand scan fires. */
export async function completeChunkedUpload(deps: AttachmentDeps, viewer: Viewer, uploadId: string): Promise<CompleteUploadResult> {
  const session = await loadOwnUploadSession(deps.pool, viewer, uploadId);
  if (!session) return { status: "not_found" };

  const limits = await getAttachmentLimits(deps.pool);
  const abortAnd = async (result: CompleteUploadResult): Promise<CompleteUploadResult> => {
    await deps.storage.abortMultipartUpload(session.object_key, session.s3_upload_id).catch(() => {});
    await deps.pool.query(`delete from attachment_uploads where id = $1`, [session.id]).catch(() => {});
    return result;
  };

  // Verify the assembly before anything is made permanent (§11 *the declared size is binding*).
  const storedParts = await deps.storage.listParts(session.object_key, session.s3_upload_id);
  const verifiedSize = verifyChunkAssembly(Number(session.declared_size_bytes), Number(session.chunk_size_bytes), storedParts);
  if (verifiedSize === null) {
    const result = await abortAnd({ status: "upload_incomplete" });
    await appendAudit(deps.pool, {
      actorUserId: viewer.userId,
      action: "attachment.upload_aborted",
      targetType: "attachment",
      targetId: session.attachment_id,
      after: { objectKey: session.object_key, reason: "size_mismatch" },
    }).catch(() => {});
    return result;
  }

  const capTarget: CapTarget = session.draft_key
    ? { kind: "draft", draftKey: session.draft_key, uploaderId: viewer.userId }
    : { kind: "parent", parentType: session.parent_type, parentId: session.parent_id! };
  if (capTarget.kind === "parent") {
    const parent = await loadParent(deps.pool, capTarget.parentType, capTarget.parentId);
    if (!parent) return abortAnd({ status: "not_found" });
    if (parent.authorId !== viewer.userId) return abortAnd({ status: "forbidden" });
    if (!parentAcceptsAttachmentChanges(session.parent_type, parent.status)) return abortAnd({ status: "not_editable" });
  }
  if ((await countLiveAttachments(deps.pool, capTarget)) >= limits.maxPerItem) return abortAnd({ status: "too_many" });

  // Reassemble the object from exactly the verified parts. After this the object exists and the
  // s3 upload id is consumed (it can no longer be aborted), so a later insert failure — or losing
  // the race for the last slot — compensates by deleting it.
  await deps.storage.completeMultipartUpload(session.object_key, session.s3_upload_id, storedParts);
  const dropAssembled = async (): Promise<void> => {
    await deps.storage.deleteObject(session.object_key).catch(() => {});
    await deps.pool.query(`delete from attachment_uploads where id = $1`, [session.id]).catch(() => {});
  };
  try {
    const result = await inTransaction(deps.pool, async (client): Promise<CompleteUploadResult> => {
      await lockCapTarget(client, capTarget);
      if ((await countLiveAttachments(client, capTarget)) >= limits.maxPerItem) return { status: "too_many" };
      const { rows } = await client.query<AttachmentDbRow>(
        `insert into attachments (id, parent_type, parent_id, draft_key, filename, size_bytes, mime, object_key, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning ${ATTACHMENT_COLUMNS}`,
        [
          session.attachment_id,
          session.parent_type,
          session.parent_id,
          session.draft_key,
          session.filename,
          verifiedSize,
          session.mime,
          session.object_key,
          viewer.userId,
        ],
      );
      const row = rows[0]!;
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "attachment.uploaded",
        targetType: "attachment",
        targetId: session.attachment_id,
        after: {
          parentType: session.parent_type,
          parentId: session.parent_id,
          draftKey: session.draft_key,
          filename: session.filename,
          sizeBytes: verifiedSize,
          mime: session.mime,
          chunked: true,
        },
      });
      await client.query(`delete from attachment_uploads where id = $1`, [session.id]);
      return { status: "ok" as const, attachment: projectAttachmentForViewer(toRecord(row), viewer.userId)! };
    });
    if (result.status !== "ok") {
      await dropAssembled();
      return result;
    }
    // On-demand scan (§11): no bytes in hand (they went straight to the store), so scan fetches
    // the reassembled object. Fire-and-forget; the worker sweep is the fallback.
    void scanAttachmentNow(deps, session.attachment_id);
    return result;
  } catch (err) {
    await dropAssembled();
    throw err;
  }
}

export type AbortUploadResult = { status: "ok" } | { status: "not_found" };

/** Discard a chunked-upload session: abort the MinIO parts, drop the session row, audit (§11). */
export async function abortChunkedUpload(deps: AttachmentDeps, viewer: Viewer, uploadId: string): Promise<AbortUploadResult> {
  const session = await loadOwnUploadSession(deps.pool, viewer, uploadId);
  if (!session) return { status: "not_found" };
  await deps.storage.abortMultipartUpload(session.object_key, session.s3_upload_id).catch(() => {});
  await deps.pool.query(`delete from attachment_uploads where id = $1`, [session.id]);
  await appendAudit(deps.pool, {
    actorUserId: viewer.userId,
    action: "attachment.upload_aborted",
    targetType: "attachment",
    targetId: session.attachment_id,
    after: { objectKey: session.object_key, reason: "client_abort" },
  }).catch(() => {});
  return { status: "ok" };
}
