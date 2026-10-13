// GET/POST /api/ai/summary/:parentType/:number (INNOBOX_SPEC.md §22.13): the discussion summary of a
// challenge's or solution's comments. GET: whether the control shows, and the cached summary (with
// whether new comments made it stale) — for any viewer who can see the item. POST: make one (or
// serve the current one), with the per-person limits. A provider failure answers 200
// `{ ok: false }` with a plain message — the helper already records it.
import { DISCUSSION_ERROR, aiDisplayName } from "@innobox/shared/ai";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { trashedResponse } from "@/lib/http";
import { webAi } from "@/lib/ai";
import { withSystemLog } from "@/lib/system-log";
import { getAiDisplayNameSetting } from "../../../../admin/ai/store";
import { getSummary, summarize, type SummaryParentType } from "../../store";

export const dynamic = "force-dynamic";

const NOT_FOUND = "not found";

function parseParams(params: { parentType: string; number: string }): { parentType: SummaryParentType; number: string } | null {
  if (params.parentType !== "challenge" && params.parentType !== "solution") return null;
  const digits = params.number.replace(/^(CH|SOL)-/i, "");
  return /^[1-9][0-9]{0,9}$/.test(digits) ? { parentType: params.parentType, number: digits } : null;
}

async function handleGET(_req: Request, context: { params: Promise<{ parentType: string; number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const p = parseParams(await context.params);
  if (!p) return Response.json({ error: NOT_FOUND }, { status: 404 });
  const view = await getSummary(pool, webAi(), { userId: gate.user.id, roles: gate.user.roles }, p.parentType, p.number);
  if (!view) return Response.json({ error: NOT_FOUND }, { status: 404 });
  return Response.json({ ...view, displayName: aiDisplayName(await getAiDisplayNameSetting(pool)) });
}

async function handlePOST(req: Request, context: { params: Promise<{ parentType: string; number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const p = parseParams(await context.params);
  if (!p) return Response.json({ error: NOT_FOUND }, { status: 404 });
  const outcome = await summarize(pool, webAi(), { userId: gate.user.id, roles: gate.user.roles }, p.parentType, p.number, req.signal);
  switch (outcome.status) {
    case "ok":
      return Response.json({ ok: true, summary: outcome.summary, cached: outcome.cached });
    case "not_found":
      return Response.json({ error: NOT_FOUND }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "unavailable":
      return Response.json({ error: "Discussion summaries aren't available here right now.", code: "ai_unavailable" }, { status: 409 });
    case "too_short":
      return Response.json({ error: "This discussion is too short to summarize yet.", code: "too_short" }, { status: 409 });
    case "minute":
      return Response.json({ error: "You've asked for 10 summaries in the last minute — wait a moment and try again.", code: "ai_limit" }, { status: 429 });
    case "day":
      return Response.json({ error: "You've reached the limit of 50 summaries in 24 hours — try again later.", code: "ai_limit" }, { status: 429 });
    case "failed":
      return Response.json({ ok: false, error: DISCUSSION_ERROR });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/ai/summary/[parentType]/[number]", handleGET);
export const POST = withSystemLog("/api/ai/summary/[parentType]/[number]", handlePOST);
