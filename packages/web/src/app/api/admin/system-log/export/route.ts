// GET /api/admin/system-log/export (INNOBOX_SPEC.md §14.7): CSV of the current filtered view,
// newest-first, capped at SYSTEM_LOG_EXPORT_CAP rows; X-Total-Matching / X-Exported-Count drive
// the in-app "exported N of M — narrow the range" notice. RFC 4180 quoting, UTF-8 BOM. Audited
// as system_log.exported (actor, filters, row count). Platform admin only.
import { SYSTEM_LOG_EXPORT_CAP, toCsvRow } from "@innobox/shared";
import { appendAudit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { exportSystemEvents } from "../store";
import { parseSystemLogQuery } from "../validation";

export const dynamic = "force-dynamic";

const COLUMNS = ["id", "created_at", "status", "method", "route", "path", "user_id", "actor_name", "actor_email", "error_code", "message", "request_id", "duration_ms", "source"];

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const filters = parseSystemLogQuery(new URL(req.url).searchParams);
  const { rows, totalMatching } = await exportSystemEvents(pool, filters, SYSTEM_LOG_EXPORT_CAP);

  await appendAudit(pool, {
    actorUserId: gate.user.id,
    action: "system_log.exported",
    targetType: "system_log",
    after: { filters, rowCount: rows.length, totalMatching },
  });

  const lines = [
    toCsvRow(COLUMNS),
    ...rows.map((r) =>
      toCsvRow([
        r.id,
        r.createdAt,
        r.status,
        r.method,
        r.route,
        r.path,
        r.userId ?? "",
        r.actorName ?? "",
        r.actorEmail ?? "",
        r.errorCode ?? "",
        r.message,
        r.requestId ?? "",
        r.durationMs ?? "",
        r.source,
      ]),
    ),
  ];
  const body = `﻿${lines.join("\r\n")}`;
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="innobox-system-log.csv"`,
      "x-total-matching": String(totalMatching),
      "x-exported-count": String(rows.length),
      "cache-control": "no-store",
    },
  });
}

export const GET = withSystemLog("/api/admin/system-log/export", handleGET);
