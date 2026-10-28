// POST /api/solutions/:number/self-reveal (INNOBOX_SPEC.md §9): the author permanently
// removes their own anonymity (one-way, audited). An anonymous solution out of `proposed` that
// answers invitations pays them off now (§40.5) — event 23 to each inviter.
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyInvitationPayoffs } from "@/lib/notify-events";
import { selfRevealSolution } from "../../../challenges/store";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../../challenges/validation";
import { withSystemLog } from "@/lib/system-log";
import { trashedResponse } from "@/lib/http";

async function handlePOST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const result = await selfRevealSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok":
      await notifyInvitationPayoffs({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.payoffs ?? []).catch(
        logNotifyFailure("invitation payoff notification failed"),
      );
      return new Response(null, { status: 204 });
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: "only the author can reveal their own anonymity" }, { status: 403 });
    case "not_anonymous":
      return Response.json({ error: "this solution is not anonymous" }, { status: 400 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/solutions/[number]/self-reveal", handlePOST);
