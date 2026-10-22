// DELETE /api/me/feature-ideas/:id (INNOBOX_SPEC.md §38.7, §38.14): withdraws one of the caller's
// own PENDING proposals. 409 once it has been decided, 404 for an unknown id or someone else's, and
// 404 while feature ideas are off. Audited as feature_idea.withdrawn.
import { FEATURE_IDEA_MESSAGES, getFeatureIdeasEnabled } from "@innobox/shared";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../challenges/validation";
import { withdrawIdea } from "../../../feature-ideas/store";

export const dynamic = "force-dynamic";

async function handleDELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id) || !(await getFeatureIdeasEnabled(pool))) return Response.json({ error: "not found" }, { status: 404 });
  const result = await withdrawIdea(pool, gate.user.id, id);
  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  if (result.status === "conflict") return Response.json({ error: FEATURE_IDEA_MESSAGES.alreadyDecidedOwn, code: "already_decided" }, { status: 409 });
  return Response.json({ ok: true });
}

export const DELETE = withSystemLog("/api/me/feature-ideas/[id]", handleDELETE);
