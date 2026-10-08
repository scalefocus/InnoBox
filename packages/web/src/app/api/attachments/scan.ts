// On-demand attachment scan (INNOBOX_SPEC.md §11). Fired (fire-and-forget) the moment an
// upload's bytes are complete — single-shot, staged, or a chunked `complete` — so the verdict
// lands within moments and the submit gate can enforce "no unclean attachments". Best-effort:
// if clamd is unreachable or errors, the row is left `pending` for the worker sweep, which is
// the fallback. The verdict side-effects mirror the worker sweep EXACTLY (clean → audit;
// infected → purge object + notify uploader (§12.1 event 11) + audit), and both guard their
// UPDATE on `scan_status='pending'` so whichever runs first wins and the other is a no-op.
// Imports stay relative (not @/) so the gated dbtest runs under the plain node test runner.
import type { Pool } from "pg";
import { appendAudit } from "../../../lib/audit";
import { scanBytes } from "../../../lib/clamav";
import type { StorageClient } from "../../../lib/storage";

interface ScanRow {
  id: string;
  parent_type: "challenge" | "solution";
  parent_id: string | null;
  object_key: string;
  filename: string;
  uploaded_by: string;
  scan_status: "pending" | "clean" | "infected";
  removed_at: Date | null;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

/** The relative deep link to a bound attachment's parent (§12.1), or null when it is unbound
 *  (a staged row has no parent yet) or has vanished. Mirrors the worker sweep. */
async function resolveParentLink(pool: Pool, parentType: "challenge" | "solution", parentId: string | null): Promise<string | null> {
  if (!parentId) return null;
  if (parentType === "challenge") {
    const { rows } = await pool.query<{ number: string }>(`select number::text as number from challenges where id = $1`, [parentId]);
    return rows[0] ? `/challenges/${rows[0].number}` : null;
  }
  const { rows } = await pool.query<{ challenge_number: string; number: string }>(
    `select c.number::text as challenge_number, s.number::text as number
       from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [parentId],
  );
  return rows[0] ? `/challenges/${rows[0].challenge_number}#SOL-${rows[0].number}` : null;
}

/** §12.1 event 11: notify the uploader (only) that their attachment failed its scan — anonymity
 *  safe (they are the sole recipient, and no other user is referenced). Skips unbound staged
 *  rows (no parent link yet); the form surfaces the "Failed scan" state instead. */
async function enqueueScanFailedNotification(pool: Pool, row: ScanRow): Promise<void> {
  const link = await resolveParentLink(pool, row.parent_type, row.parent_id);
  if (!link) return;
  const payload = JSON.stringify({ message: `Your attachment "${row.filename}" failed its virus scan and was removed.`, link });
  await pool.query(`insert into notifications (user_id, type, payload) values ($1, 'attachment_scan_failed', $2)`, [row.uploaded_by, payload]);
  await pool.query(`insert into notification_outbox (user_id, type, payload) values ($1, 'attachment_scan_failed', $2)`, [row.uploaded_by, payload]);
}

/** Scan a single freshly-uploaded attachment now. Pass `bytes` to avoid a re-read when the
 *  caller still has them (single-shot); chunked completes omit them and the object is fetched.
 *  Never throws — every failure leaves the row `pending` for the worker sweep. */
export async function scanAttachmentNow(
  deps: { pool: Pool; storage: StorageClient },
  attachmentId: string,
  opts?: { bytes?: Uint8Array },
): Promise<void> {
  try {
    const { rows } = await deps.pool.query<ScanRow>(
      `select id, parent_type, parent_id, object_key, filename, uploaded_by, scan_status, removed_at
         from attachments where id = $1`,
      [attachmentId],
    );
    const row = rows[0];
    if (!row || row.scan_status !== "pending" || row.removed_at !== null) return;

    let bytes: Uint8Array;
    try {
      bytes = opts?.bytes ?? (await deps.storage.getObject(row.object_key));
    } catch (err) {
      log("warn", "on-demand scan: could not fetch object, leaving pending", { attachmentId, error: String(err) });
      return;
    }

    let clean: boolean;
    let signature: string | undefined;
    try {
      const verdict = await scanBytes(bytes);
      clean = verdict.clean;
      signature = verdict.signature;
    } catch (err) {
      // clamd unreachable / engine error — leave pending for the sweep (fail open at submit).
      log("warn", "on-demand scan: clamd unavailable, leaving pending", { attachmentId, error: String(err) });
      return;
    }

    if (clean) {
      const res = await deps.pool.query(
        `update attachments set scan_status = 'clean', scanned_at = now() where id = $1 and scan_status = 'pending'`,
        [attachmentId],
      );
      if (res.rowCount === 0) return; // the sweep resolved it first
      await appendAudit(deps.pool, { actorUserId: null, action: "attachment.scan_clean", targetType: "attachment", targetId: attachmentId, after: { objectKey: row.object_key } });
    } else {
      const res = await deps.pool.query(
        `update attachments set scan_status = 'infected', scanned_at = now() where id = $1 and scan_status = 'pending'`,
        [attachmentId],
      );
      if (res.rowCount === 0) return;
      await deps.storage.deleteObject(row.object_key).catch((err) => log("error", "on-demand scan: infected object purge failed", { attachmentId, error: String(err) }));
      await appendAudit(deps.pool, { actorUserId: null, action: "attachment.scan_infected", targetType: "attachment", targetId: attachmentId, after: { signature: signature ?? null, objectKey: row.object_key } });
      await enqueueScanFailedNotification(deps.pool, row).catch((err) => log("error", "on-demand scan: notify failed", { attachmentId, error: String(err) }));
    }
  } catch (err) {
    log("error", "on-demand scan: failed", { attachmentId, error: String(err) });
  }
}
