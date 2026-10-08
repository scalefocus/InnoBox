// GET /api/admin/system-log (INNOBOX_SPEC.md §14.7): the platform-admin listing — status chip,
// substring search, From/To date range, per-user filter, pages of 100 (offset). 403 for anyone
// who is not a platform admin (the page is never shown to namespace admins either).
import { SYSTEM_LOG_PAGE_SIZE, parseSystemLogStatusFilter } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { listSystemEvents } from "./store";
import { parseSystemLogQuery } from "./validation";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const q = new URL(req.url).searchParams;
  const filters = parseSystemLogQuery(q);
  const limit = Math.min(SYSTEM_LOG_PAGE_SIZE, Math.max(1, Number.parseInt(q.get("limit") ?? "", 10) || SYSTEM_LOG_PAGE_SIZE));
  const offset = Math.max(0, Number.parseInt(q.get("offset") ?? "", 10) || 0);

  const page = await listSystemEvents(pool, { ...filters, status: parseSystemLogStatusFilter(q.get("status")) }, { limit, offset });
  return Response.json(page);
}

export const GET = withSystemLog("/api/admin/system-log", handleGET);
