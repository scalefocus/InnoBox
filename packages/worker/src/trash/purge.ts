// The §10.4 automatic purge (INNOBOX_SPEC.md): once a day the worker permanently deletes every
// trashed challenge and solution whose 30 days are up, oldest first, each through the shared
// §10.3 cascade in its own transaction. The audit row is `challenge.deleted` / `solution.deleted`
// with `trigger: "retention"`, no user actor, and the reason given when the item was trashed.
//
// A failure leaves that item trashed for the next run and is recorded in the system log (§14.7).
// An item restored (or deleted by an admin) between the listing and its turn is left alone — the
// purge re-checks the trash flag under the row lock.
import type { Pool } from "pg";
import { TRASH_RETENTION_DAYS, type SystemEventInput } from "@innobox/shared";
import { listDueTrash, purgeChallenge, purgeSolution, type PurgeStorage } from "@innobox/shared/item-delete";
import { recordWorkerEvent } from "../system-log/record.js";

/** The route the system log files a purge failure under. */
export const TRASH_PURGE_SYSTEM_LOG_ROUTE = "worker:trash-purge";

/** Once a day. */
export const TRASH_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface TrashPurgeSummary {
  purged: number;
  failed: number;
}

export interface TrashPurgeDeps {
  /** The object store; null when the worker has none configured — the rows are still purged and
   *  each unreachable object is logged, exactly as a failed object delete would be. */
  storage: PurgeStorage | null;
  record?: (pool: Pool, event: SystemEventInput) => Promise<void>;
  /** Test seam: the clock the cut-off is taken from. */
  now?: () => Date;
}

const NO_OBJECT_STORE: PurgeStorage = {
  async deleteObject() {
    throw new Error("object store not configured");
  },
  async abortMultipartUpload() {
    throw new Error("object store not configured");
  },
};

export async function runTrashPurgeSweep(pool: Pool, deps: TrashPurgeDeps): Promise<TrashPurgeSummary> {
  const summary: TrashPurgeSummary = { purged: 0, failed: 0 };
  const record = deps.record ?? recordWorkerEvent;
  const storage = deps.storage ?? NO_OBJECT_STORE;
  const now = (deps.now ?? (() => new Date()))();
  // Items trashed at or before this instant are due; the purge re-checks it under the row lock.
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const due = (await listDueTrash(pool, TRASH_RETENTION_DAYS)).filter((item) => item.trashedAt.getTime() <= cutoff.getTime());
  for (const item of due) {
    const request = { actorUserId: null, reason: item.reason, trigger: "retention" as const, trashedNoLaterThan: cutoff };
    const label = item.kind === "challenge" ? `CH-${item.number}` : `SOL-${item.number}`;
    try {
      const result =
        item.kind === "challenge" ? await purgeChallenge({ pool, storage }, item.number, request) : await purgeSolution({ pool, storage }, item.number, request);
      if (result.status === "ok") summary.purged++;
    } catch (err) {
      summary.failed++;
      console.error(JSON.stringify({ level: "error", msg: "trash purge failed", item: label, error: String(err) }));
      await record(pool, {
        status: 500,
        method: "DELETE",
        route: TRASH_PURGE_SYSTEM_LOG_ROUTE,
        path: item.kind === "challenge" ? `/challenges/${item.number}` : `/solutions/${item.number}`,
        errorCode: "trash_purge_failed",
        message: `The automatic purge of ${label} from the trash failed and will be retried on the next run: ${String(err)}`,
        source: "worker",
      }).catch((e) => console.error(JSON.stringify({ level: "error", msg: "trash purge system-log record failed", error: String(e) })));
    }
  }
  return summary;
}
