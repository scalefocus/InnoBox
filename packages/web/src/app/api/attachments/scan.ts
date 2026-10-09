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
import { applyScanResult, ScanObjectReadError, type AttachmentParentType, type ClamdVerdict, type ScanResult, type ScanSource } from "@innobox/shared";
import { readableStreamSource, scanSource } from "../../../lib/clamav";
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
 *  caller still has them (single-shot — already in memory, at most one chunk); chunked completes
 *  omit them and the object is STREAMED from the store to clamd (§11), never buffered whole.
 *  An injectable `scan` lets tests stand in for clamd. Never throws. */
export async function scanAttachmentNow(
  deps: { pool: Pool; storage: StorageClient; scan?: (source: ScanSource) => Promise<ClamdVerdict> },
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
      const scan = deps.scan ?? scanSource;
      if (opts?.bytes) {
        result = { verdict: await scan(opts.bytes) };
      } else {
        let source: ReturnType<typeof readableStreamSource>;
        try {
          source = readableStreamSource((await deps.storage.getObjectStream(row.object_key)).body);
        } catch (err) {
          throw new ScanObjectReadError(err);
        }
        try {
          result = { verdict: await scan(source) };
        } finally {
          source.destroy(); // no-op once read to the end; frees the store connection otherwise
        }
      }
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
