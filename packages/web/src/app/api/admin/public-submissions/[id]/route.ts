// GET /api/admin/public-submissions/:id (INNOBOX_SPEC.md §24.5, §24.9): one confirmed submission
// for the review panel — the full text, the contact details, and `similar[]` (the §6.1 check run as
// the reviewing admin, authors masked). Platform admin only; unknown or unconfirmed is 404.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../challenges/validation";
import { getPublicSubmission } from "../store";

export const dynamic = "force-dynamic";

async function handleGET(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const submission = isUuid(id) ? await getPublicSubmission(pool, { userId: gate.user.id, roles: gate.user.roles }, id) : null;
  if (!submission) return Response.json({ error: "submission not found" }, { status: 404 });
  return Response.json({ submission });
}

export const GET = withSystemLog("/api/admin/public-submissions/[id]", handleGET);
