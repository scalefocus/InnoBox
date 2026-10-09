// POST /api/challenges/:number/assign (INNOBOX_SPEC.md §7.3): namespace/platform admin
// assigns or unassigns a user. Notifies the assignee — and, on a reassignment or unassignment,
// the previous assignee (§12.1 event 7).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyAssignmentChanged } from "@/lib/notify-events";
import { setChallengeAssignee } from "../../store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber, isUuid } from "../../validation";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const assigneeUserId = body.userId === null ? null : typeof body.userId === "string" && isUuid(body.userId) ? body.userId : undefined;
  if (assigneeUserId === undefined) return Response.json({ error: "userId must be a uuid or null" }, { status: 400 });

  const result = await setChallengeAssignee(pool, { userId: gate.user.id, roles: gate.user.roles }, number, assigneeUserId);
  switch (result.status) {
    case "ok": {
      // §12.1 event 7 ("assigned / unassigned"): on a reassignment the previous assignee is told
      // they were unassigned AND the new one that they were assigned.
      await notifyAssignmentChanged(
        { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
        result.challenge,
        result.previousAssigneeId,
        assigneeUserId,
      ).catch(logNotifyFailure("assignment notification failed"));
      return Response.json({ challenge: result.challenge });
    }
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "you must be a namespace or platform admin to assign" }, { status: 403 });
    case "unknown_user":
      return Response.json({ error: "assignee not found or inactive" }, { status: 400 });
    case "terminal_status":
      return Response.json({ error: "cannot assign a challenge in a terminal status" }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/assign", handlePOST);
