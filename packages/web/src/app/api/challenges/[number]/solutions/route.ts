// POST /api/challenges/:number/solutions (INNOBOX_SPEC.md §6.2): propose a solution.
// Allowed only while the challenge is `valid` — enforced here, not just hidden in the UI.
// Auto-follows the proposer and every co-author (§12.3, §39.8), notifies admins/committee/the
// challenge's team/followers (§12.1 event 2), and tells each co-author they were added (event 21).
import { parseCoAuthorIds, TEAM_MESSAGES } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyCoAuthorsAdded, notifySolutionProposed } from "@/lib/notify-events";
import { autoFollow } from "../../../follows/store";
import { createSolution } from "../../store";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../validation";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "create");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  // §6.2 / §39: up to four co-authors who can see the challenge.
  const coAuthorIds = parseCoAuthorIds(body.coAuthorIds, gate.user.id);
  if (!coAuthorIds.ok) return Response.json({ error: coAuthorIds.error }, { status: 400 });

  const result = await createSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number, {
    description: body.description,
    costVsBenefits: body.costVsBenefits,
    isAnonymous: body.isAnonymous,
    draftKey: body.draftKey,
    coAuthors: { ids: coAuthorIds.value, resolveRoles: resolveRolesForUser },
  });

  switch (result.status) {
    case "ok": {
      const ctx = { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser };
      // §12.3 / §39.8: every member auto-follows the item.
      for (const userId of [gate.user.id, ...coAuthorIds.value]) await autoFollow(pool, userId, "solution", result.solution.id);
      await notifySolutionProposed(ctx, number, result.solution).catch(logNotifyFailure("solution.proposed notification failed"));
      // §12.1 event 21: each co-author is told, with the proposer as the actor.
      await notifyCoAuthorsAdded(ctx, { parentType: "solution", parentId: result.solution.id }, coAuthorIds.value).catch(
        logNotifyFailure("co-author notification failed"),
      );
      return Response.json({ solution: result.solution }, { status: 201 });
    }
    case "ineligible_coauthor":
      return Response.json({ error: TEAM_MESSAGES.ineligible }, { status: 422 });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "namespace_archived":
      return Response.json(
        { error: "this challenge's namespace is archived and accepts no new solutions", code: "namespace_archived" },
        { status: 409 },
      );
    case "not_valid_status":
      return Response.json({ error: "solutions can only be proposed while the challenge is valid" }, { status: 409 });
    case "attachments_not_clean":
      return Response.json(
        { error: "wait for all attachments to finish scanning (or remove any that failed) before submitting", code: "attachments_not_clean" },
        { status: 409 },
      );
    case "attachments_over_limit":
      return Response.json({ error: "too many attachments — remove some before submitting", code: "attachments_over_limit" }, { status: 409 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/solutions", handlePOST);
