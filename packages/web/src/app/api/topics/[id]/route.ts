// GET /api/topics/:id (INNOBOX_SPEC.md §34.6, §34.9): one topic for the filtered gallery's header —
// name, description, whether it is active and whether the viewer follows it. A retired topic is
// answered too (its muted chip still filters); an unknown id is 404, and the gallery drops it.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../challenges/validation";
import { getTopicForViewer } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "topic not found" }, { status: 404 });
  const topic = await getTopicForViewer(pool, { userId: gate.user.id, roles: gate.user.roles }, id.toLowerCase());
  if (!topic) return Response.json({ error: "topic not found" }, { status: 404 });
  return Response.json({ topic });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/topics/[id]", handleGET);
