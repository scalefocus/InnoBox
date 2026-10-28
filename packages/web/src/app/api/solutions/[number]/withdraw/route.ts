// POST /api/solutions/:number/withdraw (INNOBOX_SPEC.md §10.1): an author — any member of the team,
// for everyone (§39.5) — withdraws the solution from any non-terminal status → `withdrawn`. Namespace
// + platform admins (§12.1 event 10), the parent challenge's assignee, the other members of the team
// (§39.8) and the solution's existing followers are notified,
// delivered directly (see the challenge withdraw route for the visibility rationale). A withdrawal
// straight out of `proposed` may pay off invitations to the team (§40.5) — event 23 to each inviter.
import { formatSolutionNumber } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchToUser, getFollowerUserIds, getNamespaceAdminUserIds } from "@/lib/notify";
import { logNotifyFailure, notifyInvitationPayoffs } from "@/lib/notify-events";
import { withdrawSolution } from "../../../challenges/store";
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

  const result = await withdrawSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok": {
      const [followers, admins] = await Promise.all([
        getFollowerUserIds(pool, "solution", result.solutionId),
        getNamespaceAdminUserIds(pool, result.namespaceId),
      ]);
      // §39.8: the other members of the team hear of it too (the actor never notifies themselves).
      const recipients = [...new Set([...(result.assigneeId ? [result.assigneeId] : []), ...followers, ...admins, ...result.authorIds])];
      const ctx = { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser };
      const label = formatSolutionNumber(number);
      const by = result.authorIds.length > 1 ? "one of its authors" : "its author";
      await Promise.all(
        recipients.map((userId) =>
          dispatchToUser(ctx, userId, "status_changed", {
            message: `${label} on ${result.challengeNumber} "${result.challengeTitle}" was withdrawn by ${by}.`,
            link: `/challenges/${result.challengeNumber.replace("CH-", "")}#SOL-${number}`,
          }, { parentType: "solution", parentId: result.solutionId }),
        ),
      ).catch((err) => console.error(JSON.stringify({ level: "error", msg: "solution withdraw notification failed", error: String(err) })));
      await notifyInvitationPayoffs(ctx, result.payoffs).catch(logNotifyFailure("invitation payoff notification failed"));
      return Response.json({ ok: true });
    }
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: "only the author can withdraw this solution" }, { status: 403 });
    case "not_withdrawable":
      return Response.json({ error: "this solution is already in a terminal status" }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/solutions/[number]/withdraw", handlePOST);
