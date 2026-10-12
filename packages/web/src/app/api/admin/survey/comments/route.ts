// GET /api/admin/survey/comments?range=&segment=&feature=&source=&offset=&limit= (INNOBOX_SPEC.md
// §14.11): the free-text feed, newest date first, random order within a day, 50 at a time. PLATFORM
// ADMIN ONLY. Fewer than 5 matching comments withholds the whole feed.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { SURVEY_COMMENTS_PAGE } from "@innobox/shared/survey-results";
import { parseSurveyFilters } from "../filters";
import { surveyComments } from "../store";

export const dynamic = "force-dynamic";

function intParam(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return raw !== null && Number.isInteger(n) && n >= 0 ? n : fallback;
}

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const params = new URL(req.url).searchParams;
  const page = { offset: intParam(params.get("offset"), 0), limit: intParam(params.get("limit"), SURVEY_COMMENTS_PAGE) };
  return Response.json(await surveyComments(pool, parseSurveyFilters(params), page));
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/survey/comments", handleGET);
