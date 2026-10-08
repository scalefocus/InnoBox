// Re-export the shared append-only audit writer (INNOBOX_SPEC.md §15, invariant 5).
// pg's Pool and PoolClient both satisfy the structural DbClient shape, so this works
// for both standalone connections and transaction-joined clients.
export { appendAudit, type AuditEntry } from "@innobox/shared";
