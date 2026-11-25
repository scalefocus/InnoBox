// GET/PATCH/PUT/DELETE /api/solutions/:number (INNOBOX_SPEC.md §13.1, §16). GET is the solution
// detail read (visibility-filtered, anonymity-masked, 404 when not visible; there is still no
// standalone solution page). PATCH is the solution status transition,
// mirroring the challenge control — admins free-set (override), committee members and the
// parent challenge's assignee traverse the enforced §8.2 graph (illegal moves → 422). NOT
// exempt from §8.3 either way: the store enforces the single-winner gate and the implemented
// auto-close cascade. A real transition fires event 3/4/5, and `implemented` also fires event 8.
import { BOARD_COPY, isSolutionStatus, MENTION_MESSAGES, parseBaseEditedAt, parseMentionsInput, TEAM_MESSAGES, validateDeleteReason } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyInvitationPayoffs, notifyMentioned, notifySolutionStatusChanged } from "@/lib/notify-events";
import { getStorage } from "@/lib/storage";
import { isEntityNumber, parseSolutionStatusBase, parseStatusOverride } from "../../challenges/validation";
import { deleteSolution } from "../../challenges/delete";
import { editSolution, setSolutionStatus } from "../../challenges/store";
import { getSolutionByNumber } from "../store";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "solution not found" }, { status: 404 });

  const detail = await getSolutionByNumber(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  if (!detail) return Response.json({ error: "solution not found" }, { status: 404 });
  return Response.json(detail);
}

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
  // §46.8: the optional base statuses the implementation board sends — 400 when present and not a
  // status of the right kind, like a bad `status`.
  const base = parseSolutionStatusBase(body);
  if (!base.ok) return Response.json({ error: base.error }, { status: 400 });

  const result = await setSolutionStatus(
    pool,
    { userId: gate.user.id, roles: gate.user.roles },
    number,
    parsed.value,
    resolveRolesForUser,
    base.value,
  );
  switch (result.status) {
    case "ok": {
      if (result.changed) {
        await notifySolutionStatusChanged(
          { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
          result.solution.id,
          parsed.value,
          result.autoClose,
        ).catch(logNotifyFailure("solution status notification failed"));
      }
      // §40.6 event 23: a move out of `proposed` may have paid off invitations to the solution's team.
      await notifyInvitationPayoffs({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.payoffs).catch(
        logNotifyFailure("invitation payoff notification failed"),
      );
      // §43.6 event 26: a solution that just became open to everyone tells the people it mentions.
      await notifyMentioned({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.solution.id, result.mentioned).catch(
        logNotifyFailure("mention notification failed"),
      );
      return Response.json({ solution: result.solution });
    }
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: "you must be an admin, committee member, or the assignee to change status" }, { status: 403 });
    case "own_item":
      return Response.json({ error: TEAM_MESSAGES.ownItemReview, code: "own_item" }, { status: 403 });
    case "illegal_transition":
      return Response.json({ error: "that status change is not a permitted transition from the current status" }, { status: 422 });
    case "invalid_status":
      return Response.json({ error: "status must be a valid solution status" }, { status: 400 });
    case "blocked_single_winner":
      return Response.json(
        { error: "another solution on this challenge is already accepted or further along" },
        { status: 409 },
      );
    case "stale":
      return Response.json({ error: BOARD_COPY.staleStatus, code: "stale_status" }, { status: 409 });
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
  // §39.5: the editedAt the editor loaded — a save from a stale copy is refused.
  const baseEditedAt = parseBaseEditedAt(body.baseEditedAt);
  if (!baseEditedAt.ok) return Response.json({ error: baseEditedAt.error }, { status: 400 });
  // §43.11: the form's Mentioned row. Absent binds the solution's current mentions; `[]` removes them.
  const mentions = parseMentionsInput(body.mentions);
  if (!mentions.ok) return Response.json({ error: mentions.error }, { status: 400 });

  const result = await editSolution(pool, { userId: gate.user.id, roles: gate.user.roles }, number, {
    description: body.description,
    costVsBenefits: body.costVsBenefits,
    baseEditedAt: baseEditedAt.value,
    mentions: { candidates: mentions.value, resolveRoles: resolveRolesForUser },
  });
  switch (result.status) {
    case "ok":
      // §43.6 event 26: an edit is the one save that notifies (§10.1) — a newly mentioned person who
      // can see the solution now.
      await notifyMentioned({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.solution.id, result.mentioned).catch(
        logNotifyFailure("mention notification failed"),
      );
      return Response.json({ solution: result.solution });
    case "ineligible_mention":
      return Response.json({ error: MENTION_MESSAGES.ineligible }, { status: 422 });
    case "mention_cap":
      return Response.json({ error: result.reason === "solution_cap" ? MENTION_MESSAGES.solutionCap : MENTION_MESSAGES.dailyCap, code: result.reason }, { status: 409 });
    case "not_found":
      return Response.json({ error: "solution not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: "only the author can edit this solution" }, { status: 403 });
    case "not_editable":
      return Response.json({ error: "this solution is not editable in its current status" }, { status: 409 });
    case "stale":
      return Response.json({ error: TEAM_MESSAGES.staleEdit, code: "stale_edit" }, { status: 409 });
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

  // §10.3: a non-platform-admin is answered 404 BEFORE the body is looked at — a 422 for a
  // missing reason would confirm the endpoint is live for them. Then the reason (422).
  if (!gate.user.roles.isPlatformAdmin) return Response.json({ error: "solution not found" }, { status: 404 });
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const reason = validateDeleteReason(read.value.reason);
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

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/solutions/[number]", handleGET);
export const PATCH = withSystemLog("/api/solutions/[number]", handlePATCH);
export const PUT = withSystemLog("/api/solutions/[number]", handlePUT);
export const DELETE = withSystemLog("/api/solutions/[number]", handleDELETE);
