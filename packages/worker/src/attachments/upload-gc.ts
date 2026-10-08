// The §11 chunked-upload-session GC sweep (backstop). Abandoned `attachment_uploads` sessions
// — a chunked upload that was initiated but never completed or aborted — are reaped after a 2h
// TTL: the MinIO multipart is aborted (freeing its already-uploaded parts) and the session row
// is deleted. This mirrors the on-initiate cleanup in the web tier (which handles the caller's
// OWN stale sessions); this backstop covers sessions whose uploader never returns. The S3 client
// is injected so the sweep is unit-testable without a live MinIO. One bad row never aborts the sweep.
//
// It runs in the hourly housekeeping sweep, which §2 schedules ahead of any integration check: the
// DB side (reaping the session row) is pure DB work and always runs. The multipart abort is the
// S3-dependent part — with no object-store config (`s3: null`) the row is still reaped and the
// skipped abort is logged with the key + upload id, exactly like a failed abort below.
import type { Pool } from "pg";
import { appendAudit } from "@innobox/shared";

/** The object-store surface the upload GC needs — injectable for tests. */
export interface UploadGcS3Client {
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export interface UploadGcDeps {
  /** null when the worker has no object-store config — the session rows are still reaped. */
  s3: UploadGcS3Client | null;
  /** How long a session may live before it is reaped. Default 2h (§11). */
  ttlHours?: number;
  batchSize?: number;
}

export interface UploadGcSummary {
  aborted: number;
  errors: number;
}

interface StaleSessionRow {
  id: string;
  attachment_id: string;
  object_key: string;
  s3_upload_id: string;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

export async function runUploadGcSweep(pool: Pool, deps: UploadGcDeps): Promise<UploadGcSummary> {
  const summary: UploadGcSummary = { aborted: 0, errors: 0 };
  const ttlHours = deps.ttlHours ?? 2;
  const { rows } = await pool.query<StaleSessionRow>(
    `select id, attachment_id, object_key, s3_upload_id
       from attachment_uploads
      where created_at < now() - make_interval(hours => $1)
      order by created_at asc
      limit $2`,
    [ttlHours, deps.batchSize ?? 100],
  );
  if (rows.length === 0) return summary;

  for (const row of rows) {
    try {
      // Best-effort abort — a failed abort leaves orphaned parts (never exposed, no attachments
      // row exists), so log-and-continue rather than abort the sweep.
      let multipartAborted = false;
      if (deps.s3) {
        multipartAborted = await deps.s3.abortMultipartUpload(row.object_key, row.s3_upload_id).then(
          () => true,
          (err) => {
            log("error", "upload-gc: multipart abort failed", { uploadId: row.id, error: String(err) });
            return false;
          },
        );
      } else {
        log("warn", "upload-gc: no object-store config, multipart abort skipped", {
          uploadId: row.id,
          objectKey: row.object_key,
          s3UploadId: row.s3_upload_id,
        });
      }
      const res = await pool.query(`delete from attachment_uploads where id = $1`, [row.id]);
      if (res.rowCount === 0) continue; // completed/aborted meanwhile
      await appendAudit(pool, {
        actorUserId: null,
        action: "attachment.upload_aborted",
        targetType: "attachment",
        targetId: row.attachment_id,
        after: { objectKey: row.object_key, reason: "stale", ttlHours, multipartAborted },
      });
      summary.aborted += 1;
    } catch (err) {
      log("error", "upload-gc: row failed", { uploadId: row.id, error: String(err) });
      summary.errors += 1;
    }
  }
  return summary;
}
