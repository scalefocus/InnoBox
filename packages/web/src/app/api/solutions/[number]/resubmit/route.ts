// POST /api/solutions/:number/resubmit (INNOBOX_SPEC.md §10.1): the author moves their own
// `needs_improvement` solution back to `in_review`; the reviewers are notified (§12.1 event 9 —
// the parent namespace's admins + committee, the parent challenge's assignee, and the solution's
// followers).
import { formatSolutionNumber } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchEvent, getFollowerUserIds, getNamespaceAdminUserIds, getNamespaceCommitteeUserIds } from "@/lib/notify";
import { resubmitSolution } from "../../../challenges/store";
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

  const result = await resubmitSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok": {
      const [admins, committee, followers] = await Promise.all([
        getNamespaceAdminUserIds(pool, result.namespaceId),
        getNamespaceCommitteeUserIds(pool, result.namespaceId),
        getFollowerUserIds(pool, "solution", result.solutionId),
      ]);
      const candidates = [...admins, ...committee, ...(result.assigneeId ? [result.assigneeId] : []), ...followers];
      const label = formatSolutionNumber(number);
      await dispatchEvent(
        { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
        { parentType: "solution", parentId: result.solutionId },
        candidates,
        "status_changed",
        {
          message: `${label} on ${result.challengeNumber} "${result.challengeTitle}" was resubmitted for review.`,
          link: `/challenges/${result.challengeNumber.replace("CH-", "")}#SOL-${number}`,
        },
      ).catch((err) => console.error(JSON.stringify({ level: "error", msg: "solution resubmit notification failed", error: String(err) })));
      return Response.json({ ok: true });
    }
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can resubmit this solution" }, { status: 403 });
    case "not_resubmittable":
      return Response.json({ error: "only a solution in 'needs improvement' can be resubmitted" }, { status: 409 });
  }
}
