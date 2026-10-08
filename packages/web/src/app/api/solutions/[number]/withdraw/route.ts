// POST /api/solutions/:number/withdraw (INNOBOX_SPEC.md §10.1): the author withdraws their own
// solution from any non-terminal status → `withdrawn`. Namespace + platform admins (§12.1 event
// 10), the parent challenge's assignee, and the solution's existing followers are notified,
// delivered directly (see the challenge withdraw route for the visibility rationale).
import { formatSolutionNumber } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchToUser, getFollowerUserIds, getNamespaceAdminUserIds } from "@/lib/notify";
import { withdrawSolution } from "../../../challenges/store";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../../challenges/validation";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
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
      const recipients = [...new Set([...(result.assigneeId ? [result.assigneeId] : []), ...followers, ...admins])];
      const ctx = { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser };
      const label = formatSolutionNumber(number);
      await Promise.all(
        recipients.map((userId) =>
          dispatchToUser(ctx, userId, "status_changed", {
            message: `${label} on ${result.challengeNumber} "${result.challengeTitle}" was withdrawn by its author.`,
            link: `/challenges/${result.challengeNumber.replace("CH-", "")}#SOL-${number}`,
          }),
        ),
      ).catch((err) => console.error(JSON.stringify({ level: "error", msg: "solution withdraw notification failed", error: String(err) })));
      return Response.json({ ok: true });
    }
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can withdraw this solution" }, { status: 403 });
    case "not_withdrawable":
      return Response.json({ error: "this solution is already in a terminal status" }, { status: 409 });
  }
}
