// POST /api/admin/feature-ideas/:id/merge { entry } (INNOBOX_SPEC.md §38.5, §38.14): the pending
// idea is a duplicate of a Coming soon entry (a planned row's uuid); the proposer's vote moves to it
// and event 19 says it is already planned. 409 `not_visible` when the entry's audience does not
// include the proposer, 400 for an entry that is not planned, 409 when another admin decided first.
// Platform admin only.
import { parseEntryId } from "@innobox/shared";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { withSystemLog } from "@/lib/system-log";
import { mergeIdea } from "../../../../feature-ideas/store";
import { decisionResponse, ideaGate } from "../gate";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await ideaGate(context);
  if (!gate.ok) return gate.response;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const target = parseEntryId(read.value.entry);
  if (!target) return decisionResponse({ status: "bad_target" });
  return decisionResponse(await mergeIdea(pool, gate.user.id, gate.id, target));
}

export const POST = withSystemLog("/api/admin/feature-ideas/[id]/merge", handlePOST);
