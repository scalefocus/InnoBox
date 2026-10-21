// GET /api/admin/rum/errors?range=&sort=last_seen|count (INNOBOX_SPEC.md §14.12): the deduplicated
// browser errors last seen in the range, capped at 50. Platform admin only; not audited. The
// messages are attacker-influenced text (anyone can throw) — the page renders them as text only.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { parseRumRange } from "@innobox/shared/rum";
import { parseRumErrorSort, rumErrors } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const params = new URL(req.url).searchParams;
  return Response.json(await rumErrors(pool, parseRumRange(params.get("range")), parseRumErrorSort(params.get("sort"))));
}

export const GET = withSystemLog("/api/admin/rum/errors", handleGET);
