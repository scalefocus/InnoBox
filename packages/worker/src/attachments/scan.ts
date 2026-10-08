// The §11 ClamAV scan sweep: drains `pending` attachment rows that are due (`next_scan_at` null
// or past — a row backing off after a per-file error waits its turn), oldest first, streams
// each object to clamd over the INSTREAM protocol, and hands the result to the SHARED verdict
// handler `applyScanResult` (@innobox/shared) — the same code the web tier's on-demand scan
// runs, so behaviour is identical whichever fires first: clean → audited; infected → object
// purged (the row stays an `infected` tombstone), uploader notified (§12.1 event 11), audited;
// an outage (clamd/S3 unreachable) leaves the row untouched; a per-file error (clamd answered
// with an error, or the object is unreadable) backs off and, at the attempt cap, makes the row
// `unscannable` — purged, notified, audited. The S3 client and the scan function are injected
// so the sweep is unit-testable without a live MinIO/clamd (the pure INSTREAM framing/parsing
// and the retry policy live in @innobox/shared and are unit-tested there).
import net from "node:net";
import type { Pool } from "pg";
import {
  applyScanResult,
  CLAMD_INSTREAM_COMMAND,
  CLAMD_INSTREAM_TERMINATOR,
  frameInstreamChunk,
  parseClamdResponse,
  ScanObjectReadError,
  type AttachmentParentType,
  type ClamdVerdict,
  type ScanResult,
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

/** A scan function: given the object bytes, return clamd's verdict, or throw — a
 *  `ClamdErrorReply` when clamd answered with an error for this stream (per-file), anything
 *  else when clamd could not be reached (outage). */
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
  /** Rows that reached the terminal `unscannable` state this sweep. */
  unscannable: number;
  /** Outages and counted per-file retries — the row stays `pending` either way. */
  errors: number;
}

interface PendingRow {
  id: string;
  parent_type: AttachmentParentType;
  parent_id: string | null;
  object_key: string;
  filename: string;
  uploaded_by: string;
  scan_attempts: number;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

export async function runScanSweep(pool: Pool, deps: ScanDeps): Promise<ScanSummary> {
  const summary: ScanSummary = { scanned: 0, clean: 0, infected: 0, unscannable: 0, errors: 0 };
  const { rows } = await pool.query<PendingRow>(
    `select id, parent_type, parent_id, object_key, filename, uploaded_by, scan_attempts
       from attachments
      where scan_status = 'pending' and removed_at is null
        and (next_scan_at is null or next_scan_at <= now())
      order by created_at asc
      limit $1`,
    [deps.batchSize ?? 20],
  );
  if (rows.length === 0) return summary;

  for (const row of rows) {
    try {
      let result: ScanResult;
      try {
        let bytes: Uint8Array;
        try {
          bytes = await deps.s3.getObject(row.object_key);
        } catch (err) {
          throw new ScanObjectReadError(err);
        }
        result = { verdict: await deps.scan(bytes) };
      } catch (err) {
        result = { error: err };
      }

      const outcome = await applyScanResult(
        { db: pool, purgeObject: (key) => deps.s3.deleteObject(key), log },
        {
          id: row.id,
          parentType: row.parent_type,
          parentId: row.parent_id,
          objectKey: row.object_key,
          filename: row.filename,
          uploadedBy: row.uploaded_by,
          scanAttempts: Number(row.scan_attempts ?? 0),
        },
        result,
      );
      // `noop`: the web tier's on-demand scan resolved the row first, or it was permanently
      // deleted with its parent mid-sweep (§10.3) — nothing was written, nothing to count.
      if (outcome === "clean" || outcome === "infected" || outcome === "unscannable") {
        summary[outcome] += 1;
        summary.scanned += 1;
      } else if (outcome === "retry" || outcome === "unavailable") {
        summary.errors += 1;
      }
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
 *  shared protocol helpers. Writes honour socket backpressure. clamd may answer EARLY and close
 *  — `INSTREAM size limit exceeded. ERROR` when a stream passes its StreamMaxLength — while we
 *  are still writing, which surfaces here as EPIPE/ECONNRESET; a reply already received always
 *  wins over that socket error, so the limit reply is a per-file error (counted toward
 *  `unscannable`), never mistaken for an outage that would leave the row pending forever.
 *  Rejects with the socket/timeout error only when clamd gave no reply at all (outage). */
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
      const settleFromReply = (fallback?: Error): void =>
        finish(() => {
          if (fallback && response.replace(/\0/g, "").trim() === "") return reject(fallback);
          try {
            resolve(parseClamdResponse(response));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      // Idle timeout: longer than clamd's own MaxScanTime, so a slow scan is answered (or
      // flagged by clamd) before we give up on the connection.
      socket.setTimeout(opts.timeoutMs ?? 180_000);
      socket.on("connect", () => {
        void (async () => {
          const write = (chunk: Uint8Array | string): Promise<void> =>
            new Promise((ok) => {
              if (socket.write(chunk)) return ok();
              const done = (): void => {
                socket.off("drain", done);
                socket.off("close", done);
                ok();
              };
              socket.on("drain", done);
              socket.on("close", done);
            });
          await write(CLAMD_INSTREAM_COMMAND);
          const CHUNK = 64 * 1024;
          for (let off = 0; off < bytes.length && !settled && !socket.destroyed; off += CHUNK) {
            await write(frameInstreamChunk(bytes.subarray(off, Math.min(off + CHUNK, bytes.length))));
          }
          if (!settled && !socket.destroyed) socket.write(CLAMD_INSTREAM_TERMINATOR);
        })();
      });
      socket.on("data", (d) => {
        response += d.toString("utf8");
      });
      socket.on("end", () => settleFromReply());
      socket.on("close", () => settleFromReply(new Error("clamd closed the connection without a reply")));
      socket.on("timeout", () => finish(() => reject(new Error("clamd scan timed out"))));
      socket.on("error", (err) => settleFromReply(err));
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
