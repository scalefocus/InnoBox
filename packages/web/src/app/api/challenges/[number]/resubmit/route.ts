// POST /api/challenges/:number/resubmit (INNOBOX_SPEC.md §10.1): the author moves their own
// `needs_improvement` challenge back to `in_review` and the reviewers are notified (§12.1
// event 9 — namespace admins + committee, the assignee, and followers). The item is visible
// again at in_review, so the standard visibility-filtered dispatch applies.
import { formatChallengeNumber } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchEvent, getFollowerUserIds, getNamespaceAdminUserIds, getNamespaceCommitteeUserIds } from "@/lib/notify";
import { resubmitChallenge } from "../../store";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { number } = await context.params;

  const result = await resubmitChallenge(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok": {
      const [admins, committee, followers] = await Promise.all([
        getNamespaceAdminUserIds(pool, result.namespaceId),
        getNamespaceCommitteeUserIds(pool, result.namespaceId),
        getFollowerUserIds(pool, "challenge", result.challengeId),
      ]);
      const candidates = [...admins, ...committee, ...(result.assigneeId ? [result.assigneeId] : []), ...followers];
      const label = formatChallengeNumber(number);
      await dispatchEvent(
        { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
        { parentType: "challenge", parentId: result.challengeId },
        candidates,
        "status_changed",
        { message: `${label} "${result.title}" was resubmitted for review.`, link: `/challenges/${number}` },
      ).catch((err) => console.error(JSON.stringify({ level: "error", msg: "challenge resubmit notification failed", error: String(err) })));
      return Response.json({ ok: true });
    }
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can resubmit this challenge" }, { status: 403 });
    case "not_resubmittable":
      return Response.json({ error: "only a challenge in 'needs improvement' can be resubmitted" }, { status: 409 });
  }
}
