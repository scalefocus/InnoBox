// GET/PATCH /api/challenges/:number (INNOBOX_SPEC.md §13.1): challenge detail and the status
// transition control. PATCH serves both modes (§7.2): a namespace/platform admin free-sets any
// status (override), while a committee member or the assignee traverses the enforced graph — the
// store derives the mode from the caller's role. An illegal enforced transition is a 422. A real
// transition fires notification event 3/4/5 (§12.1) to author/assignee/followers.
import { isChallengeStatus, validateDeleteReason } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { markCommentNotificationsReadForChallenge } from "@/lib/notify";
import { logNotifyFailure, notifyChallengeStatusChanged } from "@/lib/notify-events";
import { getStorage } from "@/lib/storage";
import { isEntityNumber, isUuid, parseStatusOverride } from "../validation";
import { deleteChallenge } from "../delete";
import { editChallenge, getChallengeByNumber, setChallengeStatus } from "../store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const challenge = await getChallengeByNumber(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  if (!challenge) return Response.json({ error: "challenge not found" }, { status: 404 });
  // §12.1: opening the item's page is a read action for its coalesced comment rows (the
  // challenge's and its solutions'). Best-effort — never fails the page.
  await markCommentNotificationsReadForChallenge(pool, gate.user.id, challenge.id).catch(() => {});
  return Response.json({ challenge });
}

async function handlePATCH(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseStatusOverride(body, (s) => isChallengeStatus(s));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await setChallengeStatus(pool, { userId: gate.user.id, roles: gate.user.roles }, number, parsed.value);
  switch (result.status) {
    case "ok": {
      if (result.changed) {
        await notifyChallengeStatusChanged(
          { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
          { id: result.challenge.id },
          parsed.value,
        ).catch(logNotifyFailure("challenge status notification failed"));
      }
      return Response.json({ challenge: result.challenge });
    }
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "you must be an admin, committee member, or the assignee to change status" }, { status: 403 });
    case "illegal_transition":
      return Response.json({ error: "that status change is not a permitted transition from the current status" }, { status: 422 });
    case "invalid_status":
      return Response.json({ error: "status must be a valid challenge status" }, { status: 400 });
  }
}

async function handlePUT(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  if (typeof body.impactAreaId !== "string" || !isUuid(body.impactAreaId)) {
    return Response.json({ error: "impactAreaId must be a uuid" }, { status: 400 });
  }

  const result = await editChallenge(pool, { userId: gate.user.id, roles: gate.user.roles }, number, {
    title: body.title,
    description: body.description,
    clientName: body.clientName,
    impactAreaId: body.impactAreaId,
  });
  switch (result.status) {
    case "ok":
      return Response.json({ challenge: result.challenge });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "only the author can edit this challenge" }, { status: 403 });
    case "not_editable":
      return Response.json({ error: "this challenge is not editable in its current status" }, { status: 409 });
    case "unknown_impact_area":
      return Response.json({ error: "unknown impact area" }, { status: 400 });
    case "inactive_impact_area":
      return Response.json({ error: "that impact area is retired" }, { status: 400 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
  }
}

/**
 * DELETE — the §10.3 platform-admin permanent delete: cascading, irreversible, no
 * notification to anyone (the audit row is the only record). A caller who is not a platform
 * admin — and any caller asking about an item they cannot see — gets the same 404 as a
 * genuinely missing challenge, so this is no existence oracle (invariant 2).
 */
async function handleDELETE(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  // §10.3: a non-platform-admin is answered 404 BEFORE the body is looked at — a 422 for a
  // missing reason would confirm the endpoint is live for them. Then the reason (422).
  if (!gate.user.roles.isPlatformAdmin) return Response.json({ error: "challenge not found" }, { status: 404 });
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const reason = validateDeleteReason(read.value.reason);
  if (!reason.ok) return Response.json({ error: reason.error }, { status: 422 });

  const result = await deleteChallenge(
    { pool, storage: getStorage() },
    { userId: gate.user.id, roles: gate.user.roles },
    number,
    reason.value,
  );
  if (result.status === "not_found") return Response.json({ error: "challenge not found" }, { status: 404 });
  return Response.json({ deleted: true, cascade: result.counts });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/challenges/[number]", handleGET);
export const PATCH = withSystemLog("/api/challenges/[number]", handlePATCH);
export const PUT = withSystemLog("/api/challenges/[number]", handlePUT);
export const DELETE = withSystemLog("/api/challenges/[number]", handleDELETE);
