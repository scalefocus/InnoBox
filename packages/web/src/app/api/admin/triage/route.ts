// GET /api/admin/triage (INNOBOX_SPEC.md §14.1): the namespace triage queue. Namespace
// admins (own namespace) and platform admins (everywhere) only.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, listTriageQueue } from "./store";
import { parseTriageFilters, parseTriagePagination } from "./validation";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const admin = { userId: gate.user.id, roles: gate.user.roles };
  const adminNs = adminNamespaceIds(admin.roles);
  if (adminNs !== "all" && adminNs.length === 0) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const parsed = parseTriageFilters(url.searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  if (parsed.value.namespaceId && adminNs !== "all" && !adminNs.includes(parsed.value.namespaceId)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const pagination = parseTriagePagination(url.searchParams);
  if (!pagination.ok) return Response.json({ error: pagination.error }, { status: 400 });

  const page = await listTriageQueue(pool, admin, parsed.value, pagination.value);
  return Response.json(page);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/triage", handleGET);
