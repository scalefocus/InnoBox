// GET /api/admin/audit (INNOBOX_SPEC.md §15): the read-only, filterable audit browser for
// platform admins. Filters (all optional, composable): category (action-prefix chips), q (plain
// substring over the human-meaningful fields), action, actorUserId, targetType, targetId,
// from/to (ISO). Pages of 100 via limit/offset.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { AUDIT_PAGE_SIZE, listAudit } from "./store";
import { parseAuditQuery } from "./validation";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const q = new URL(req.url).searchParams;
  const limit = Math.min(AUDIT_PAGE_SIZE, Math.max(1, Number.parseInt(q.get("limit") ?? "", 10) || AUDIT_PAGE_SIZE));
  const offset = Math.max(0, Number.parseInt(q.get("offset") ?? "", 10) || 0);

  const result = await listAudit(pool, parseAuditQuery(q), { limit, offset });
  return Response.json(result);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/audit", handleGET);
