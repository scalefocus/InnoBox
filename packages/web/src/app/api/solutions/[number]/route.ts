// PATCH /api/solutions/:number (INNOBOX_SPEC.md §13.1): the solution status transition,
// mirroring the challenge control — admins free-set (override), committee members and the
// parent challenge's assignee traverse the enforced §8.2 graph (illegal moves → 422). NOT
// exempt from §8.3 either way: the store enforces the single-winner gate and the implemented
// auto-close cascade. A real transition fires event 3/4/5, and `implemented` also fires event 8.
import { isSolutionStatus, validateDeleteReason } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchEvent, getFollowerUserIds } from "@/lib/notify";
import { getStorage } from "@/lib/storage";
import { isEntityNumber, parseStatusOverride } from "../../challenges/validation";
import { deleteSolution } from "../../challenges/delete";
import { editSolution, setSolutionStatus } from "../../challenges/store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handlePATCH(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseStatusOverride(body, (s) => isSolutionStatus(s));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await setSolutionStatus(pool, { userId: gate.user.id, roles: gate.user.roles }, number, parsed.value);
  switch (result.status) {
    case "ok": {
      if (result.changed) {
        await fireSolutionStatusNotifications(result.solution.id, number, parsed.value, gate.user.id, result.autoClose).catch((err) =>
          console.error(JSON.stringify({ level: "error", msg: "solution status notification failed", error: String(err) })),
        );
      }
      return Response.json({ solution: result.solution });
    }
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "you must be an admin, committee member, or the assignee to change status" }, { status: 403 });
    case "illegal_transition":
      return Response.json({ error: "that status change is not a permitted transition from the current status" }, { status: 422 });
    case "invalid_status":
      return Response.json({ error: "status must be a valid solution status" }, { status: 400 });
    case "blocked_single_winner":
      return Response.json(
        { error: "another solution on this challenge is already accepted or further along" },
        { status: 409 },
      );
  }
}

async function handlePUT(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;

  const result = await editSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number, {
    description: body.description,
    costVsBenefits: body.costVsBenefits,
  });
  switch (result.status) {
    case "ok":
      return Response.json({ solution: result.solution });
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can edit this solution" }, { status: 403 });
    case "not_editable":
      return Response.json({ error: "this solution is not editable in its current status" }, { status: 409 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
  }
}

/**
 * DELETE — the §10.3 platform-admin permanent delete of one solution. Its parent challenge
 * stays; if this was the `implemented` solution of a `solved` challenge, the challenge is
 * un-solved back to `valid` in the same transaction. Nobody is notified (§12.1); a caller who
 * is not a platform admin gets the same 404 as a missing solution (invariant 2).
 */
async function handleDELETE(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const reason = validateDeleteReason(body.reason);
  if (!reason.ok) return Response.json({ error: reason.error }, { status: 422 });

  const result = await deleteSolution(
    { pool, storage: getStorage() },
    { userId: gate.user.id, roles: gate.user.roles },
    number,
    reason.value,
  );
  if (result.status === "not_found") return Response.json({ error: "solution not found" }, { status: 404 });
  return Response.json({ deleted: true, cascade: result.counts, challengeRevertedToValid: result.challengeRevertedToValid });
}

async function fireSolutionStatusNotifications(
  solutionId: string,
  solutionNumber: string,
  newStatus: string,
  actorId: string,
  autoClose: { challengeId: string; challengeNumber: string; challengeTitle: string; notSelectedAuthorIds: string[]; solutionIds: string[] } | undefined,
): Promise<void> {
  const { rows } = await pool.query<{ author_id: string; challenge_number: string; challenge_title: string }>(
    `select s.author_id, c.number::text as challenge_number, c.title as challenge_title
       from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [solutionId],
  );
  const row = rows[0];
  if (!row) return;
  const followers = await getFollowerUserIds(pool, "solution", solutionId);

  let type: "status_changed" | "rejected" | "needs_improvement" = "status_changed";
  let message = `Solution SOL-${solutionNumber} on ${row.challenge_number} "${row.challenge_title}" moved to ${newStatus.replace(/_/g, " ")}.`;
  if (newStatus === "rejected") {
    type = "rejected";
    message = `Solution SOL-${solutionNumber} on ${row.challenge_number} "${row.challenge_title}" was rejected.`;
  } else if (newStatus === "needs_improvement") {
    type = "needs_improvement";
    message = `Solution SOL-${solutionNumber} on ${row.challenge_number} "${row.challenge_title}" needs improvement — edit and resubmit.`;
  }
  // §12.1: a plain status change (event 3) reaches author + followers; Rejected (4) and Needs
  // improvement (5) are author-focused events — only the item author is notified, with the
  // distinct rejected message / edit-&-resubmit CTA above.
  const recipients = type === "status_changed" ? [row.author_id, ...followers] : [row.author_id];
  await dispatchEvent(
    { pool, actorId, resolveRoles: resolveRolesForUser },
    { parentType: "solution", parentId: solutionId },
    recipients,
    type,
    { message, link: `/challenges/${row.challenge_number}#SOL-${solutionNumber}` },
    // §12.1: event 3 is mutable; rejected/needs-improvement (4/5) always reach the author.
    type === "status_changed" ? { preference: "followedStatus" } : undefined,
  );

  if (autoClose) {
    const challengeFollowers = await getFollowerUserIds(pool, "challenge", autoClose.challengeId);
    // §12.1 event 8: "followers of the challenge AND its solutions" — gather followers of the
    // implemented solution and every not_selected sibling too, not just the challenge's.
    const solutionFollowerLists = await Promise.all(autoClose.solutionIds.map((sid) => getFollowerUserIds(pool, "solution", sid)));
    await dispatchEvent(
      { pool, actorId, resolveRoles: resolveRolesForUser },
      { parentType: "challenge", parentId: autoClose.challengeId },
      [row.author_id, ...autoClose.notSelectedAuthorIds, ...challengeFollowers, ...solutionFollowerLists.flat()],
      "solution_implemented",
      {
        message: `${autoClose.challengeNumber} "${autoClose.challengeTitle}" was solved — a solution was implemented.`,
        link: `/challenges/${autoClose.challengeNumber}`,
      },
    );
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PATCH = withSystemLog("/api/solutions/[number]", handlePATCH);
export const PUT = withSystemLog("/api/solutions/[number]", handlePUT);
export const DELETE = withSystemLog("/api/solutions/[number]", handleDELETE);
