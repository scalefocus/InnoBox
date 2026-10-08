// GET/PATCH /api/challenges/:number (INNOBOX_SPEC.md §13.1): challenge detail and the status
// transition control. PATCH serves both modes (§7.2): a namespace/platform admin free-sets any
// status (override), while a committee member or the assignee traverses the enforced graph — the
// store derives the mode from the caller's role. An illegal enforced transition is a 422. A real
// transition fires notification event 3/4/5 (§12.1) to author/assignee/followers.
import { isChallengeStatus, validateDeleteReason } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchEvent, getFollowerUserIds } from "@/lib/notify";
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
        const followers = await getFollowerUserIds(pool, "challenge", result.challenge.id);
        await fireStatusChangedNotification(result.challenge.id, result.challenge.number, result.challenge.title, parsed.value, gate.user.id, followers).catch(
          (err) => console.error(JSON.stringify({ level: "error", msg: "challenge status notification failed", error: String(err) })),
        );
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

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const reason = validateDeleteReason(body.reason);
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

async function fireStatusChangedNotification(
  challengeId: string,
  challengeNumber: string,
  title: string,
  newStatus: string,
  actorId: string,
  followerIds: string[],
): Promise<void> {
  const { rows } = await pool.query<{ author_id: string; assignee_id: string | null }>(
    `select author_id, assignee_id from challenges where id = $1`,
    [challengeId],
  );
  const row = rows[0];
  if (!row) return;
  const numberDigits = challengeNumber.replace("CH-", "");
  let type: "status_changed" | "rejected" | "needs_improvement" = "status_changed";
  let message = `${challengeNumber} "${title}" moved to ${newStatus.replace(/_/g, " ")}.`;
  if (newStatus === "rejected") {
    type = "rejected";
    message = `${challengeNumber} "${title}" was rejected.`;
  } else if (newStatus === "needs_improvement") {
    type = "needs_improvement";
    message = `${challengeNumber} "${title}" needs improvement — edit and resubmit.`;
  }
  // §12.1: a plain status change (event 3) reaches author + assignee + followers; Rejected (4)
  // and Needs improvement (5) are author-focused events — only the item author is notified, with
  // the distinct rejected message / edit-&-resubmit CTA above.
  const recipients =
    type === "status_changed"
      ? [row.author_id, ...(row.assignee_id ? [row.assignee_id] : []), ...followerIds]
      : [row.author_id];
  await dispatchEvent(
    { pool, actorId, resolveRoles: resolveRolesForUser },
    { parentType: "challenge", parentId: challengeId },
    recipients,
    type,
    { message, link: `/challenges/${numberDigits}` },
    // §12.1: only a plain status change (event 3) is mutable — rejected/needs-improvement are
    // actionable author events and always arrive. The assignee holds per-item duty: exempt.
    type === "status_changed" ? { preference: "followedStatus", exempt: row.assignee_id ? [row.assignee_id] : [] } : undefined,
  );
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/challenges/[number]", handleGET);
export const PATCH = withSystemLog("/api/challenges/[number]", handlePATCH);
export const PUT = withSystemLog("/api/challenges/[number]", handlePUT);
export const DELETE = withSystemLog("/api/challenges/[number]", handleDELETE);
