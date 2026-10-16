// Append-only audit writer (INNOBOX_SPEC.md §15, invariant 5). INSERT only, ever:
// the innobox_app role has no UPDATE/DELETE grant on audit_log and a DB trigger
// blocks mutation regardless of role (db/migrations/0002). Corrections are new rows.
// Shared home of the Phase 0 web writer so web (pg Pool/PoolClient) and worker share
// one implementation — DB access is the structural DbClient shape, both satisfy it.
import type { DbClient } from "./email-graph.js";

export interface AuditEntry {
  /** Null/omitted for system events (SCIM writes, reconciliation) with no user actor. */
  actorUserId?: string | null;
  /** Dotted event name, e.g. "user.jit_created", "scim.membership_changed". */
  action: string;
  /** Entity kind the event targets, e.g. "user", "role_mapping". */
  targetType: string;
  /** Capped at AUDIT_TARGET_ID_MAX_LENGTH characters by the writer (§15). */
  targetId?: string | null;
  /** Structured payload halves: state before/after (diffs, from → to, override flags). */
  before?: unknown;
  after?: unknown;
}

/** §15: the longest `target_id` the writer stores. A UUID is 36 characters and every targeted id
 *  is far shorter than this; a longer value is truncated before the insert, so no caller can
 *  plant an unbounded string in a hash-chained row. */
export const AUDIT_TARGET_ID_MAX_LENGTH = 256;

/** The stored form of a target id: null when absent, else at most AUDIT_TARGET_ID_MAX_LENGTH. */
export function auditTargetId(targetId: string | null | undefined): string | null {
  if (targetId === null || targetId === undefined) return null;
  return targetId.length > AUDIT_TARGET_ID_MAX_LENGTH ? targetId.slice(0, AUDIT_TARGET_ID_MAX_LENGTH) : targetId;
}

/** Accepts any DbClient (pg Pool or a checked-out PoolClient) so audit rows can join the
 *  caller's transaction (status transitions must commit atomically with their audit entry). */
export async function appendAudit(db: DbClient, entry: AuditEntry): Promise<void> {
  if (!entry.action) throw new Error("audit entry requires an action");
  if (!entry.targetType) throw new Error("audit entry requires a targetType");
  await db.query(
    `insert into audit_log (actor_user_id, action, target_type, target_id, before, after)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType,
      auditTargetId(entry.targetId),
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}
