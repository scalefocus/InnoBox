// POST /api/admin/public-submissions/:id/erase-contact (INNOBOX_SPEC.md §24.8, §24.9): erase the
// submitter's name and e-mail now — from the review panel or the "Submitted from outside" panel,
// for example when the submitter asks. Audited as `public_submission.contact_erased` with
// `trigger: "manual"`. Idempotent. Platform admin only.
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { eraseSubmissionContact } from "../../store";
import { decisionGate, refusal } from "../decisions";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await decisionGate(context);
  if (!gate.ok) return gate.response;
  const result = await eraseSubmissionContact(pool, { userId: gate.user.id, roles: gate.user.roles }, gate.id);
  return result.status === "ok" ? Response.json({ ok: true, erased: result.erased }) : refusal(result.status);
}

export const POST = withSystemLog("/api/admin/public-submissions/[id]/erase-contact", handlePOST);
