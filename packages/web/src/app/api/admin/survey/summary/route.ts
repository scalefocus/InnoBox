// GET /api/admin/survey/summary?range=7|30|90|all&segment=&feature=&source= (INNOBOX_SPEC.md
// §14.11): the funnel, the satisfaction trend, the question cards and the feature list. PLATFORM
// ADMIN ONLY — 403 to everyone else, namespace admins included. Figures over fewer than 5
// responses are withheld server-side; the current UTC day is excluded. Not audited: aggregates.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { parseSurveyFilters } from "../filters";
import { surveySummary } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json(await surveySummary(pool, parseSurveyFilters(new URL(req.url).searchParams)));
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/survey/summary", handleGET);
