// CSV shape of the §15 audit export (INNOBOX_SPEC.md): every column of the row, before/after as
// the stored jsonb's own `::text` written verbatim (the bytes the hash chain covers), with the
// hash-chain columns chain_seq, prev_hash and row_hash appended after `after`.
// RFC 4180 quoting via the shared toCsvRow; the route adds the UTF-8 BOM.
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import { toCsvRow } from "@innobox/shared";
import type { AuditExportEntry } from "./store";

export const AUDIT_CSV_COLUMNS = [
  "id",
  "created_at",
  "action",
  "target_type",
  "target_id",
  "target_number",
  "actor_user_id",
  "actor_name",
  "actor_email",
  "before",
  "after",
  "chain_seq",
  "prev_hash",
  "row_hash",
] as const;

/** Header + one line per row, CRLF-joinable. */
export function auditCsvLines(rows: readonly AuditExportEntry[]): string[] {
  return [
    toCsvRow([...AUDIT_CSV_COLUMNS]),
    ...rows.map((r) =>
      toCsvRow([
        r.id,
        r.createdAt,
        r.action,
        r.targetType ?? "",
        r.targetId ?? "",
        r.targetNumber ?? "",
        r.actorUserId ?? "",
        r.actorDisplayName ?? "",
        r.actorEmail ?? "",
        r.before ?? "",
        r.after ?? "",
        r.chainSeq ?? "",
        r.prevHash ?? "",
        r.rowHash ?? "",
      ]),
    ),
  ];
}
