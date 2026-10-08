// The §11 draft-attachment GC sweep: purges ABANDONED staged uploads — rows staged during a
// submission form (parent_id NULL, draft_key set) that were never bound to a challenge/solution
// because the form was abandoned. After the 24h TTL each is soft-removed like any other tombstone
// (the MinIO object is purged, removed_at stamped — the app role has no DELETE) and audited
// `attachment.draft_expired`. The S3 client is injected so the sweep is unit-testable without a
// live MinIO. Mirrors the scan sweep's isolation: one bad row never aborts the sweep.
import type { Pool } from "pg";
import { appendAudit } from "@innobox/shared";

/** The object-store surface the GC needs — injectable for tests. */
export interface DraftGcS3Client {
  deleteObject(key: string): Promise<void>;
}

export interface DraftGcDeps {
  s3: DraftGcS3Client;
  /** How long an unbound staged row may live before it is purged. Default 24h (§11). */
  ttlHours?: number;
  batchSize?: number;
}

export interface DraftGcSummary {
  expired: number;
  errors: number;
}

interface AbandonedRow {
  id: string;
  object_key: string;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

export async function runDraftGcSweep(pool: Pool, deps: DraftGcDeps): Promise<DraftGcSummary> {
  const summary: DraftGcSummary = { expired: 0, errors: 0 };
  const ttlHours = deps.ttlHours ?? 24;
  const { rows } = await pool.query<AbandonedRow>(
    `select id, object_key
       from attachments
      where parent_id is null and draft_key is not null and removed_at is null
        and created_at < now() - make_interval(hours => $1)
      order by created_at asc
      limit $2`,
    [ttlHours, deps.batchSize ?? 100],
  );
  if (rows.length === 0) return summary;

  for (const row of rows) {
    try {
      // Purge the object first (best-effort). A failed purge leaves bytes that are never served
      // (the row is about to be tombstoned), so log-and-continue rather than abort the row.
      await deps.s3.deleteObject(row.object_key).catch((err) =>
        log("error", "draft-gc: object purge failed", { attachmentId: row.id, error: String(err) }),
      );
      // Soft-remove: stamp removed_at (no DELETE grant — the row stays as a tombstone). The guard
      // skips rows a concurrent bind/removal grabbed since the select.
      const res = await pool.query(
        `update attachments set removed_at = now() where id = $1 and parent_id is null and removed_at is null`,
        [row.id],
      );
      if (res.rowCount === 0) continue; // bound or removed meanwhile
      await appendAudit(pool, {
        actorUserId: null,
        action: "attachment.draft_expired",
        targetType: "attachment",
        targetId: row.id,
        after: { objectKey: row.object_key, ttlHours },
      });
      summary.expired += 1;
    } catch (err) {
      log("error", "draft-gc: row failed", { attachmentId: row.id, error: String(err) });
      summary.errors += 1;
    }
  }
  return summary;
}
