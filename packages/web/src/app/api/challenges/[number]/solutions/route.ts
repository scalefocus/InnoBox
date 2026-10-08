// POST /api/challenges/:number/solutions (INNOBOX_SPEC.md §6.2): propose a solution.
// Allowed only while the challenge is `valid` — enforced here, not just hidden in the UI.
// Auto-follows the proposer (§12.3) and notifies admins/committee/challenge author/followers
// (§12.1 event 2).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchEvent, getFollowerUserIds, getNamespaceAdminUserIds, getNamespaceCommitteeUserIds } from "@/lib/notify";
import { autoFollow } from "../../../follows/store";
import { createSolution } from "../../store";

export async function POST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { number } = await context.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const rec = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  const result = await createSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number, {
    description: rec.description,
    costVsBenefits: rec.costVsBenefits,
    isAnonymous: rec.isAnonymous,
    draftKey: rec.draftKey,
  });

  switch (result.status) {
    case "ok": {
      await autoFollow(pool, gate.user.id, "solution", result.solution.id);
      await fireSolutionProposedNotification(number, gate.user.id).catch((err) =>
        console.error(JSON.stringify({ level: "error", msg: "solution.proposed notification failed", error: String(err) })),
      );
      return Response.json({ solution: result.solution }, { status: 201 });
    }
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "not_valid_status":
      return Response.json({ error: "solutions can only be proposed while the challenge is valid" }, { status: 409 });
    case "attachments_not_clean":
      return Response.json({ error: "wait for all attachments to finish scanning (or remove any that failed) before submitting" }, { status: 409 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
  }
}

async function fireSolutionProposedNotification(challengeNumber: string, proposerId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string; title: string; namespace_id: string; author_id: string }>(
    `select id, title, namespace_id, author_id from challenges where number = $1`,
    [challengeNumber],
  );
  const challenge = rows[0];
  if (!challenge) return;
  const [admins, committee, followers] = await Promise.all([
    getNamespaceAdminUserIds(pool, challenge.namespace_id),
    getNamespaceCommitteeUserIds(pool, challenge.namespace_id),
    getFollowerUserIds(pool, "challenge", challenge.id),
  ]);
  await dispatchEvent(
    { pool, actorId: proposerId, resolveRoles: resolveRolesForUser },
    { parentType: "challenge", parentId: challenge.id },
    [...admins, ...committee, challenge.author_id, ...followers],
    "solution_proposed",
    {
      message: `A new solution was proposed on CH-${challengeNumber} "${challenge.title}".`,
      link: `/challenges/${challengeNumber}`,
    },
  );
}
