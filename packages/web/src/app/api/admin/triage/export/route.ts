// GET /api/admin/triage/export (INNOBOX_SPEC.md §14.1): CSV export of the current filtered
// triage view — anonymous authors masked, audited (who, filter, row count).
import { toCsvRow } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, exportTriageCsv } from "../store";
import { parseTriageFilters } from "../validation";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const admin = { userId: gate.user.id, roles: gate.user.roles };
  const adminNs = adminNamespaceIds(admin.roles);
  if (adminNs !== "all" && adminNs.length === 0) return Response.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const parsed = parseTriageFilters(url.searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  if (parsed.value.namespaceId && adminNs !== "all" && !adminNs.includes(parsed.value.namespaceId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const { rows } = await exportTriageCsv(pool, admin, parsed.value);
  const header = toCsvRow(["Number", "Title", "Author", "Status", "Impact area", "Namespace", "Assignee", "Created"]);
  const body = [
    header,
    ...rows.map((r) =>
      toCsvRow([r.number, r.title, r.authorDisplayName, r.status, r.impactAreaName, r.namespaceSlug, r.assigneeDisplayName ?? "Unassigned", r.createdAt]),
    ),
  ].join("\r\n");

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="innobox-triage-export.csv"`,
    },
  });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/triage/export", handleGET);
