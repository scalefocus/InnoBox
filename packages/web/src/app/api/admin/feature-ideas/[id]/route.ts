// PATCH and DELETE /api/admin/feature-ideas/:id (INNOBOX_SPEC.md §38.5, §38.14).
//   PATCH  { title, teaser, audience } — edit a PLANNED entry's published copy, the seeded ones
//          included; votes are kept and nobody is notified. Audited as feature_idea.edited with the
//          diff.
//   DELETE — a PENDING row is the spam delete (no body, nothing sent); a PLANNED row needs
//          `{ notifyShipped: boolean }`: ticked, event 20 reaches the proposer (if any) and the
//          voters, and a proposer someone else approved earns idea_shipped. Audited as
//          feature_idea.deleted, never with the text.
// 409 for a row in the wrong status. Platform admin only.
import { validatePublishedCopy } from "@innobox/shared";
import { pool } from "@/lib/db";
import { isJsonContentType, readJsonObject } from "@/lib/http";
import { withSystemLog } from "@/lib/system-log";
import { deleteIdea, editIdea } from "../../../feature-ideas/store";
import { decisionResponse, ideaGate } from "./gate";

export const dynamic = "force-dynamic";

async function handlePATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await ideaGate(context);
  if (!gate.ok) return gate.response;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const copy = validatePublishedCopy(read.value);
  if (!copy.ok) return Response.json({ error: copy.error }, { status: 422 });
  return decisionResponse(await editIdea(pool, gate.user.id, gate.id, copy.value));
}

async function handleDELETE(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await ideaGate(context);
  if (!gate.ok) return gate.response;
  // The spam delete carries no body; a planned delete carries the choice as JSON.
  let notifyShipped: boolean | undefined;
  if (isJsonContentType(req)) {
    const read = await readJsonObject(req);
    if (!read.ok) return read.response;
    if (read.value.notifyShipped !== undefined && typeof read.value.notifyShipped !== "boolean") {
      return Response.json({ error: "notifyShipped must be a boolean" }, { status: 400 });
    }
    notifyShipped = read.value.notifyShipped as boolean | undefined;
  }
  return decisionResponse(await deleteIdea(pool, gate.user.id, gate.id, notifyShipped));
}

export const PATCH = withSystemLog("/api/admin/feature-ideas/[id]", handlePATCH);
export const DELETE = withSystemLog("/api/admin/feature-ideas/[id]", handleDELETE);
