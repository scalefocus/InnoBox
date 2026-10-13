// POST /api/admin/public-submissions/:id/decline (INNOBOX_SPEC.md §24.5, §24.9): `{ note? }` — the
// optional plain-text note (≤ 1 000) goes into the decline e-mail; the audit row records only
// whether one was sent. 409 when another admin decided first. Platform admin only.
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { withSystemLog } from "@/lib/system-log";
import { declinePublicSubmission, parseDeclineNote } from "../../store";
import { decisionGate, refusal } from "../decisions";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await decisionGate(context);
  if (!gate.ok) return gate.response;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const note = parseDeclineNote(read.value.note);
  if (!note.ok) return Response.json({ error: note.error }, { status: 400 });
  const result = await declinePublicSubmission(pool, { userId: gate.user.id, roles: gate.user.roles }, gate.id, note.value);
  return result.status === "ok" ? Response.json({ ok: true }) : refusal(result.status);
}

export const POST = withSystemLog("/api/admin/public-submissions/[id]/decline", handlePOST);
