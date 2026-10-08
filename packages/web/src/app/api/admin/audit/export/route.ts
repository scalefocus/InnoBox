// GET /api/admin/audit/export (INNOBOX_SPEC.md §15): CSV of the current filtered view, newest-
// first, capped at AUDIT_EXPORT_CAP rows; X-Total-Matching / X-Exported-Count drive the in-app
// "exported N of M — narrow the range" notice. Every column of the row, before/after as raw JSON
// (lossless), then the hash-chain columns chain_seq / prev_hash / row_hash. RFC 4180 quoting,
// UTF-8 BOM. Platform admin only — the only role that sees the
// browser at all. Rows are NOT anonymity-masked (the log is the provenance record and already shows
// the true actor to platform admins); the compensating control is that every export is itself
// audited as audit.exported with actor, filters and row count.
import { appendAudit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { auditCsvLines } from "../csv";
import { AUDIT_EXPORT_CAP, exportAudit } from "../store";
import { parseAuditQuery } from "../validation";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const filters = parseAuditQuery(new URL(req.url).searchParams);
  const { rows, totalMatching } = await exportAudit(pool, filters, AUDIT_EXPORT_CAP);

  await appendAudit(pool, {
    actorUserId: gate.user.id,
    action: "audit.exported",
    targetType: "audit_log",
    after: { filters, rowCount: rows.length, totalMatching },
  });

  const lines = auditCsvLines(rows);
  return new Response(`﻿${lines.join("\r\n")}`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="innobox-audit-log.csv"`,
      "x-total-matching": String(totalMatching),
      "x-exported-count": String(rows.length),
      "cache-control": "no-store",
    },
  });
}

export const GET = withSystemLog("/api/admin/audit/export", handleGET);
