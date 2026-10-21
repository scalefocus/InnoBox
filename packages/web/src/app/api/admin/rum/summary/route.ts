// GET /api/admin/rum/summary?range=7d|30d|90d|all (INNOBOX_SPEC.md §14.12): the routes table and
// its all-routes row. Platform admin only. Not audited: the data carries no user ids, so a read
// discloses nothing about anyone.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { parseRumRange } from "@innobox/shared/rum";
import { rumSummary } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const range = parseRumRange(new URL(req.url).searchParams.get("range"));
  return Response.json(await rumSummary(pool, range));
}

export const GET = withSystemLog("/api/admin/rum/summary", handleGET);
