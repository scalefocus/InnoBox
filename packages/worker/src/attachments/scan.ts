// The §11 ClamAV scan sweep: drains `pending` attachment rows, streams each object from MinIO
// to clamd over the INSTREAM protocol, and records the verdict. Clean → audited; infected →
// the object is purged from MinIO (the row stays as an `infected` tombstone), the uploader is
// notified (§12.1 event 11), and it is audited. Transient errors (can't reach clamd / S3)
// leave the row `pending` for the next sweep. The S3 client and the scan function are injected
// so the sweep is unit-testable without a live MinIO/clamd (the pure INSTREAM framing/parsing
// live in @innobox/shared and are unit-tested there).
import net from "node:net";
import type { Pool } from "pg";
import {
  appendAudit,
  CLAMD_INSTREAM_COMMAND,
  CLAMD_INSTREAM_TERMINATOR,
  frameInstreamChunk,
  parseClamdResponse,
  type ClamdVerdict,
} from "@innobox/shared";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** The object-store surface the sweep needs — injectable for tests. */
export interface ScanS3Client {
  getObject(key: string): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
}

/** The full worker S3 surface: the scan sweep's reads/deletes plus the upload-session GC's
 *  multipart abort (§11 *Upload-session GC*). */
export interface WorkerS3Client extends ScanS3Client {
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

/** A scan function: given the object bytes, return clamd's verdict (or throw on a transient
 *  engine/connection error, which leaves the row pending). */
export type ScanFn = (bytes: Uint8Array) => Promise<ClamdVerdict>;

export interface ScanDeps {
  s3: ScanS3Client;
  scan: ScanFn;
  batchSize?: number;
}

export interface ScanSummary {
  scanned: number;
  clean: number;
  infected: number;
  errors: number;
}

interface PendingRow {
  id: string;
  parent_type: "challenge" | "solution";
  parent_id: string;
  object_key: string;
  filename: string;
  uploaded_by: string;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

/** The relative deep link to an attachment's parent (§12.1), or null when it has vanished. */
async function resolveParentLink(pool: Pool, parentType: "challenge" | "solution", parentId: string): Promise<string | null> {
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

/** §12.1 event 11: notify the uploader (only) that their attachment failed its scan. The
 *  message references the uploader's own filename (safe — they are the sole recipient) and
 *  links to the parent; no other user is exposed (anonymity-safe). Writes both the in-app row
 *  and the outbox row, exactly like lib/notify.ts. */
async function enqueueScanFailedNotification(pool: Pool, row: PendingRow): Promise<void> {
  const link = await resolveParentLink(pool, row.parent_type, row.parent_id);
  if (!link) return;
  const payload = JSON.stringify({
    message: `Your attachment "${row.filename}" failed its virus scan and was removed.`,
    link,
  });
  await pool.query(`insert into notifications (user_id, type, payload) values ($1, 'attachment_scan_failed', $2)`, [row.uploaded_by, payload]);
  await pool.query(`insert into notification_outbox (user_id, type, payload) values ($1, 'attachment_scan_failed', $2)`, [row.uploaded_by, payload]);
}

export async function runScanSweep(pool: Pool, deps: ScanDeps): Promise<ScanSummary> {
  const summary: ScanSummary = { scanned: 0, clean: 0, infected: 0, errors: 0 };
  const { rows } = await pool.query<PendingRow>(
    `select id, parent_type, parent_id, object_key, filename, uploaded_by
       from attachments
      where scan_status = 'pending' and removed_at is null
      order by created_at asc
      limit $1`,
    [deps.batchSize ?? 20],
  );
  if (rows.length === 0) return summary;

  for (const row of rows) {
    try {
      let bytes: Uint8Array;
      try {
        bytes = await deps.s3.getObject(row.object_key);
      } catch (err) {
        // Transient object-store error — leave the row pending for the next sweep.
        log("warn", "scan: could not fetch object, leaving pending", { attachmentId: row.id, error: String(err) });
        summary.errors += 1;
        continue;
      }

      let verdict: ClamdVerdict;
      try {
        verdict = await deps.scan(bytes);
      } catch (err) {
        // clamd unreachable / engine error — leave pending, retry next sweep.
        log("warn", "scan: clamd unavailable or errored, leaving pending", { attachmentId: row.id, error: String(err) });
        summary.errors += 1;
        continue;
      }

      if (verdict.clean) {
        const applied = await pool.query(
          `update attachments set scan_status = 'clean', scanned_at = now() where id = $1 and scan_status = 'pending'`,
          [row.id],
        );
        // Nothing to apply the verdict to: the web tier's on-demand scan got there first, or the
        // row was permanently deleted with its parent mid-sweep (§10.3). Either way this is a
        // no-op — no audit row, no notification for an attachment that isn't there.
        if (applied.rowCount === 0) continue;
        await appendAudit(pool, {
          actorUserId: null,
          action: "attachment.scan_clean",
          targetType: "attachment",
          targetId: row.id,
          after: { objectKey: row.object_key },
        });
        summary.clean += 1;
      } else {
        const applied = await pool.query(
          `update attachments set scan_status = 'infected', scanned_at = now() where id = $1 and scan_status = 'pending'`,
          [row.id],
        );
        if (applied.rowCount === 0) continue; // resolved elsewhere, or deleted mid-sweep (§10.3)
        // Purge the object; the row stays as an infected tombstone (§11). A failed purge is
        // logged but not fatal — the row's infected status already blocks all downloads.
        await deps.s3.deleteObject(row.object_key).catch((err) =>
          log("error", "scan: infected object purge failed", { attachmentId: row.id, error: String(err) }),
        );
        await appendAudit(pool, {
          actorUserId: null,
          action: "attachment.scan_infected",
          targetType: "attachment",
          targetId: row.id,
          after: { signature: verdict.signature ?? null, objectKey: row.object_key },
        });
        await enqueueScanFailedNotification(pool, row);
        summary.infected += 1;
      }
      summary.scanned += 1;
    } catch (err) {
      // Never let one bad row abort the sweep (mirrors reconciliation/notification isolation).
      log("error", "scan: row failed", { attachmentId: row.id, error: String(err) });
      summary.errors += 1;
    }
  }
  return summary;
}

// ── Real clamd scanner + S3 client (used by index.ts; not unit-tested — the pure protocol
//    framing/parsing is covered by the @innobox/shared tests) ────────────────────────────────

async function streamToUint8Array(body: unknown): Promise<Uint8Array> {
  const b = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
  if (b && typeof b.transformToByteArray === "function") return b.transformToByteArray();
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Build a `ScanFn` that streams the bytes to clamd via INSTREAM over a TCP socket, using the
 *  shared protocol helpers. Rejects on connect/timeout/engine errors so the row stays pending. */
export function createClamavScanner(opts: { host: string; port: number; timeoutMs?: number }): ScanFn {
  return (bytes: Uint8Array) =>
    new Promise<ClamdVerdict>((resolve, reject) => {
      const socket = net.connect({ host: opts.host, port: opts.port });
      let response = "";
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        fn();
      };
      socket.setTimeout(opts.timeoutMs ?? 120_000);
      socket.on("connect", () => {
        socket.write(CLAMD_INSTREAM_COMMAND);
        const CHUNK = 64 * 1024;
        for (let off = 0; off < bytes.length; off += CHUNK) {
          socket.write(frameInstreamChunk(bytes.subarray(off, Math.min(off + CHUNK, bytes.length))));
        }
        socket.write(CLAMD_INSTREAM_TERMINATOR);
      });
      socket.on("data", (d) => {
        response += d.toString("utf8");
      });
      socket.on("end", () => finish(() => {
        try {
          resolve(parseClamdResponse(response));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }));
      socket.on("timeout", () => finish(() => reject(new Error("clamd scan timed out"))));
      socket.on("error", (err) => finish(() => reject(err)));
    });
}

/** Build a `WorkerS3Client` for the worker from S3/MinIO env (path-style for MinIO). */
export function createWorkerS3Client(opts: {
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket: string;
}): WorkerS3Client {
  const client = new S3Client({
    endpoint: opts.endpoint,
    region: opts.region ?? "us-east-1",
    forcePathStyle: true,
    credentials:
      opts.accessKeyId && opts.secretAccessKey
        ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
        : undefined,
  });
  return {
    async getObject(key: string): Promise<Uint8Array> {
      const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
      return streamToUint8Array(res.Body);
    },
    async deleteObject(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }));
    },
    async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
      await client.send(new AbortMultipartUploadCommand({ Bucket: opts.bucket, Key: key, UploadId: uploadId }));
    },
  };
}
