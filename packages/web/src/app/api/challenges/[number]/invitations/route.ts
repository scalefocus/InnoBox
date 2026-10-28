// POST /api/challenges/:number/invitations (INNOBOX_SPEC.md §40.2, §40.11): invite 1–5 colleagues
// who can see the challenge to propose a solution, with one optional note — all-or-nothing. Order of
// checks: 404 when the number is malformed or the caller cannot see the challenge; the shared 409 on
// a trashed one; 409 when it does not accept solutions; 400 for a body that is not 1–5 distinct
// ids; 422 for a note over 500 characters and for any ineligible person (one message for every
// reason); then 409 for the per-challenge and the daily cap. No PATCH and no DELETE: an invitation
// cannot be taken back. Each invitee is told after the commit (§12.1 event 22).
import { INVITATION_MESSAGES, parseInvitationRequest } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { logNotifyFailure, notifyInvited } from "@/lib/notify-events";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isEntityNumber } from "../../validation";
import { sendInvitations } from "../../invitations";
import { loadInvitationChallenge } from "../../store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });
  const viewer = { userId: gate.user.id, roles: gate.user.roles };

  // The challenge's own refusals come before the body's (§40.11), so read it first.
  const challenge = await loadInvitationChallenge(pool, viewer, number);
  if (!challenge) return Response.json({ error: "challenge not found" }, { status: 404 });
  if (challenge.trashed) return trashedResponse();
  if (!challenge.open) return Response.json({ error: INVITATION_MESSAGES.notOpen, code: "not_open" }, { status: 409 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseInvitationRequest(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });

  const result = await sendInvitations(pool, viewer, number, parsed.value, resolveRolesForUser);
  switch (result.status) {
    case "ok":
      await notifyInvited({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.challengeId, result.created).catch(
        logNotifyFailure("invitation notification failed"),
      );
      return Response.json({ sent: result.sent, invitations: result.invitations }, { status: 201 });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "not_open":
      return Response.json({ error: INVITATION_MESSAGES.notOpen, code: "not_open" }, { status: 409 });
    case "ineligible":
      return Response.json({ error: INVITATION_MESSAGES.ineligible, code: "ineligible" }, { status: 422 });
    case "challenge_cap":
      return Response.json({ error: INVITATION_MESSAGES.challengeCap, code: "challenge_cap" }, { status: 409 });
    case "daily_cap":
      return Response.json({ error: INVITATION_MESSAGES.dailyCap, code: "daily_cap" }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/invitations", handlePOST);
