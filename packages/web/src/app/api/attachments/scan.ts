// On-demand attachment scan (INNOBOX_SPEC.md §11). Fired (fire-and-forget) the moment an
// upload's bytes are complete — single-shot, staged, or a chunked `complete` — so the verdict
// lands within moments and the submit gate can enforce "no unclean attachments". Best-effort:
// the worker sweep is the fallback for anything left `pending`. What a result DOES to the row
// is the shared `applyScanResult` handler from @innobox/shared — the very same code the worker
// sweep runs (clean → audit; infected → purge + notify uploader (§12.1 event 11) + audit; an
// outage leaves the row untouched; a per-file error counts toward `unscannable`), each write
// guarded on `scan_status='pending'` so whichever path runs first wins and the other no-ops.
// Imports stay relative (not @/) so the gated dbtest runs under the plain node test runner.
import type { Pool } from "pg";
import { applyScanResult, ScanObjectReadError, type AttachmentParentType, type ScanResult } from "@innobox/shared";
import { scanBytes } from "../../../lib/clamav";
import type { StorageClient } from "../../../lib/storage";

interface ScanRow {
  id: string;
  parent_type: AttachmentParentType;
  parent_id: string | null;
  object_key: string;
  filename: string;
  uploaded_by: string;
  scan_status: "pending" | "clean" | "infected" | "unscannable";
  scan_attempts: number;
  removed_at: Date | null;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

/** Scan a single freshly-uploaded attachment now. Pass `bytes` to avoid a re-read when the
 *  caller still has them (single-shot); chunked completes omit them and the object is fetched.
 *  An injectable `scan` lets tests stand in for clamd. Never throws. */
export async function scanAttachmentNow(
  deps: { pool: Pool; storage: StorageClient; scan?: (bytes: Uint8Array) => ReturnType<typeof scanBytes> },
  attachmentId: string,
  opts?: { bytes?: Uint8Array },
): Promise<void> {
  try {
    const { rows } = await deps.pool.query<ScanRow>(
      `select id, parent_type, parent_id, object_key, filename, uploaded_by, scan_status, scan_attempts, removed_at
         from attachments where id = $1`,
      [attachmentId],
    );
    const row = rows[0];
    if (!row || row.scan_status !== "pending" || row.removed_at !== null) return;

    let result: ScanResult;
    try {
      let bytes = opts?.bytes;
      if (!bytes) {
        try {
          bytes = await deps.storage.getObject(row.object_key);
        } catch (err) {
          throw new ScanObjectReadError(err);
        }
      }
      result = { verdict: await (deps.scan ?? scanBytes)(bytes) };
    } catch (err) {
      result = { error: err };
    }

    await applyScanResult(
      { db: deps.pool, purgeObject: (key) => deps.storage.deleteObject(key), log: (level, msg, extra) => log(level, `on-demand ${msg}`, extra) },
      {
        id: row.id,
        parentType: row.parent_type,
        parentId: row.parent_id,
        objectKey: row.object_key,
        filename: row.filename,
        uploadedBy: row.uploaded_by,
        scanAttempts: Number(row.scan_attempts),
      },
      result,
    );
  } catch (err) {
    log("error", "on-demand scan: failed", { attachmentId, error: String(err) });
  }
}
