// GET/POST /api/ai/draft (INNOBOX_SPEC.md §22.10): "Improve with AI" on the challenge and solution
// submit forms. GET says whether the button shows (and whether namespace-only text may be sent);
// POST returns one draft for the author's own text. No persistence, no audit, no AI marker. A
// provider failure answers 200 `{ ok: false }` with the plain message — the helper already
// records it (usage row, throttled system log), so the route adds no 5xx of its own.
import { AI_DRAFT_ERROR, aiDisplayName } from "@innobox/shared/ai";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { webAi } from "@/lib/ai";
import { withSystemLog } from "@/lib/system-log";
import { getAiDisplayNameSetting } from "../../admin/ai/store";
import { DRAFT_MESSAGES, getDraftAvailability, runDraft } from "./store";
import { parseDraftRequest } from "./validation";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const [availability, name] = await Promise.all([getDraftAvailability(pool, webAi()), getAiDisplayNameSetting(pool)]);
  return Response.json({ ...availability, displayName: aiDisplayName(name) });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseDraftRequest(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  // The browser's Cancel aborts the request, which aborts the provider call too.
  const outcome = await runDraft(pool, webAi(), { userId: gate.user.id, roles: gate.user.roles }, parsed.value, req.signal);
  switch (outcome.status) {
    case "ok":
      return Response.json({ ok: true, kind: outcome.kind, draft: outcome.draft });
    case "unavailable":
      return Response.json({ error: DRAFT_MESSAGES.unavailable, code: "ai_unavailable" }, { status: 409 });
    case "restricted":
      return Response.json({ error: DRAFT_MESSAGES.restricted, code: "ai_restricted_content" }, { status: 409 });
    case "minute":
    case "day":
      return Response.json({ error: DRAFT_MESSAGES[outcome.status], code: "ai_limit" }, { status: 429 });
    case "not_found":
      return Response.json({ error: DRAFT_MESSAGES.notFound }, { status: 404 });
    case "failed":
      return Response.json({ ok: false, error: AI_DRAFT_ERROR });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
// The wrapper records only the `{ error }` message — never the request body (the author's text).
export const GET = withSystemLog("/api/ai/draft", handleGET);
export const POST = withSystemLog("/api/ai/draft", handlePOST);
