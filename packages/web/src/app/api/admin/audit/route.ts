// GET /api/admin/audit (INNOBOX_SPEC.md §15): the read-only, filterable audit browser for
// platform admins. Filters: action, actorUserId (uuid), targetType, targetId, from/to (ISO).
// Malformed uuid/timestamp filters are ignored rather than 500-ing the query.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { AUDIT_PAGE_SIZE_DEFAULT, AUDIT_PAGE_SIZE_MAX, listAudit } from "./store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const q = new URL(req.url).searchParams;
  const intOr = (v: string | null, def: number): number => {
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) ? n : def;
  };
  const page = Math.max(1, intOr(q.get("page"), 1));
  const pageSize = Math.min(AUDIT_PAGE_SIZE_MAX, Math.max(1, intOr(q.get("pageSize"), AUDIT_PAGE_SIZE_DEFAULT)));

  const str = (k: string): string | undefined => {
    const v = q.get(k);
    return v && v.trim() ? v.trim() : undefined;
  };
  const uuid = (k: string): string | undefined => {
    const v = str(k);
    return v && UUID_RE.test(v) ? v : undefined;
  };
  const iso = (k: string): string | undefined => {
    const v = str(k);
    if (!v) return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  };

  const result = await listAudit(
    pool,
    { action: str("action"), actorUserId: uuid("actorUserId"), targetType: str("targetType"), targetId: str("targetId"), from: iso("from"), to: iso("to") },
    { page, pageSize },
  );
  return Response.json(result);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/audit", handleGET);
