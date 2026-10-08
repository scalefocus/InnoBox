// POST /api/challenges/:number/withdraw (INNOBOX_SPEC.md §10.1): the author withdraws their
// own challenge from any non-terminal status → `withdrawn` (terminal, soft). Namespace + platform
// admins (§12.1 event 10), the assignee, and existing followers are notified — delivered directly
// rather than through the visibility-filtered dispatch, because a withdrawn challenge is hidden
// (§4.3) yet all these recipients retain access (admins always; assignee/followers already had
// it), so notifying them leaks nothing.
import { formatChallengeNumber } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchToUser, getFollowerUserIds, getNamespaceAdminUserIds } from "@/lib/notify";
import { withdrawChallenge } from "../../store";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../validation";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const result = await withdrawChallenge(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  switch (result.status) {
    case "ok": {
      const [followers, admins] = await Promise.all([
        getFollowerUserIds(pool, "challenge", result.challengeId),
        getNamespaceAdminUserIds(pool, result.namespaceId),
      ]);
      const recipients = [...new Set([...(result.assigneeId ? [result.assigneeId] : []), ...followers, ...admins])];
      const ctx = { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser };
      const label = formatChallengeNumber(number);
      await Promise.all(
        recipients.map((userId) =>
          dispatchToUser(ctx, userId, "status_changed", {
            message: `${label} "${result.title}" was withdrawn by its author.`,
            link: `/challenges/${number}`,
          }),
        ),
      ).catch((err) => console.error(JSON.stringify({ level: "error", msg: "challenge withdraw notification failed", error: String(err) })));
      return Response.json({ ok: true });
    }
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can withdraw this challenge" }, { status: 403 });
    case "not_withdrawable":
      return Response.json({ error: "this challenge is already in a terminal status" }, { status: 409 });
  }
}
