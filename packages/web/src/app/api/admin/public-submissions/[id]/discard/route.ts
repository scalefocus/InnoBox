// POST /api/admin/public-submissions/:id/discard (INNOBOX_SPEC.md §24.5, §24.9): "Discard as spam" —
// sends nothing and deletes the row at once. 409 when another admin decided first. Platform admin
// only.
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { discardPublicSubmission } from "../../store";
import { decisionGate, refusal } from "../decisions";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await decisionGate(context);
  if (!gate.ok) return gate.response;
  const result = await discardPublicSubmission(pool, { userId: gate.user.id, roles: gate.user.roles }, gate.id);
  return result.status === "ok" ? Response.json({ ok: true }) : refusal(result.status);
}

export const POST = withSystemLog("/api/admin/public-submissions/[id]/discard", handlePOST);
