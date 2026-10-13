// POST /api/solutions/:number/resubmit (INNOBOX_SPEC.md §10.1): the author moves their own
// `needs_improvement` solution back to `in_review`; the reviewers are notified (§12.1 event 9 —
// the parent namespace's admins + committee, the parent challenge's assignee, and the solution's
// followers).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifySolutionResubmitted } from "@/lib/notify-events";
import { resubmitSolution } from "../../../challenges/store";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../../challenges/validation";
import { withSystemLog } from "@/lib/system-log";
import { trashedResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

async function handlePOST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const result = await resubmitSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok": {
      await notifySolutionResubmitted({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, number, result).catch(
        logNotifyFailure("solution resubmit notification failed"),
      );
      return Response.json({ ok: true });
    }
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: "only the author can resubmit this solution" }, { status: 403 });
    case "not_resubmittable":
      return Response.json({ error: "only a solution in 'needs improvement' can be resubmitted" }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/solutions/[number]/resubmit", handlePOST);
