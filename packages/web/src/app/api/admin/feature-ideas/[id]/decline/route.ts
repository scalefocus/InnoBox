// POST /api/admin/feature-ideas/:id/decline { note? } (INNOBOX_SPEC.md §38.5, §38.14): the pending
// idea is declined; the optional plain-text note (≤ 1 000) goes to the proposer with event 19 and
// into the audit row. 409 when another admin decided first or while feature ideas are off.
// Platform admin only.
import { validateDecisionNote } from "@innobox/shared";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { withSystemLog } from "@/lib/system-log";
import { declineIdea } from "../../../../feature-ideas/store";
import { decisionResponse, ideaGate } from "../gate";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await ideaGate(context);
  if (!gate.ok) return gate.response;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const note = validateDecisionNote(read.value.note);
  if (!note.ok) return Response.json({ error: note.error }, { status: 422 });
  return decisionResponse(await declineIdea(pool, gate.user.id, gate.id, note.value));
}

export const POST = withSystemLog("/api/admin/feature-ideas/[id]/decline", handlePOST);
