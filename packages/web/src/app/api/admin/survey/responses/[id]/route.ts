// DELETE /api/admin/survey/responses/:id (INNOBOX_SPEC.md §14.11): removes a whole response, its
// star answers included. PLATFORM ADMIN ONLY. 404 for an unknown or malformed id. Audited as
// `survey.response_deleted` — never with the text.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../validation";
import { deleteSurveyResponse } from "../../store";

export const dynamic = "force-dynamic";

async function handleDELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "survey response not found" }, { status: 404 });
  const result = await deleteSurveyResponse(pool, id, gate.user.id);
  if (result === "not_found") return Response.json({ error: "survey response not found" }, { status: 404 });
  return Response.json({ ok: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const DELETE = withSystemLog("/api/admin/survey/responses/[id]", handleDELETE);
