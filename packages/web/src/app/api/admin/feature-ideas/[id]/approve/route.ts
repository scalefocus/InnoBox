// POST /api/admin/feature-ideas/:id/approve { title, teaser, audience } (INNOBOX_SPEC.md §38.5,
// §38.14): the pending idea becomes planned with the admin's published copy — one transaction with
// the proposer's vote, the audit row, the idea_approved award and event 19. 422 for missing or
// over-long copy or an internal reference in it; 409 when another admin decided first or while
// feature ideas are off. Platform admin only.
import { validatePublishedCopy } from "@innobox/shared";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { withSystemLog } from "@/lib/system-log";
import { approveIdea } from "../../../../feature-ideas/store";
import { decisionResponse, ideaGate } from "../gate";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await ideaGate(context);
  if (!gate.ok) return gate.response;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const copy = validatePublishedCopy(read.value);
  if (!copy.ok) return Response.json({ error: copy.error }, { status: 422 });
  return decisionResponse(await approveIdea(pool, gate.user.id, gate.id, copy.value));
}

export const POST = withSystemLog("/api/admin/feature-ideas/[id]/approve", handlePOST);
