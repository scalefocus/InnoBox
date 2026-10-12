// POST /api/challenges/:number/solutions (INNOBOX_SPEC.md §6.2): propose a solution.
// Allowed only while the challenge is `valid` — enforced here, not just hidden in the UI.
// Auto-follows the proposer (§12.3) and notifies admins/committee/challenge author/followers
// (§12.1 event 2).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { notifySolutionProposed } from "@/lib/notify-events";
import { autoFollow } from "../../../follows/store";
import { createSolution } from "../../store";
import { readJsonObject } from "@/lib/http";
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

  const result = await createSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number, {
    description: body.description,
    costVsBenefits: body.costVsBenefits,
    isAnonymous: body.isAnonymous,
    draftKey: body.draftKey,
  });

  switch (result.status) {
    case "ok": {
      await autoFollow(pool, gate.user.id, "solution", result.solution.id);
      await notifySolutionProposed({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, number, result.solution).catch((err) =>
        console.error(JSON.stringify({ level: "error", msg: "solution.proposed notification failed", error: String(err) })),
      );
      return Response.json({ solution: result.solution }, { status: 201 });
    }
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
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
