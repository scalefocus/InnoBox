// GET /api/admin/rum/series?range=7d|30d|90d|all (INNOBOX_SPEC.md §14.12): the chart — page views
// and p75 LCP / INP per UTC day, contiguous to today (live). Platform admin only; not audited.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { parseRumRange } from "@innobox/shared/rum";
import { rumSeries } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const range = parseRumRange(new URL(req.url).searchParams.get("range"));
  return Response.json(await rumSeries(pool, range));
}

export const GET = withSystemLog("/api/admin/rum/series", handleGET);
