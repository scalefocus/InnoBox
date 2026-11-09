// PUT/DELETE /api/challenges/:number/affected (INNOBOX_SPEC.md §41.10): set or take back the
// caller's "this affects me too" mark. Order of checks (§2.4): 404 for a malformed number or a
// challenge the caller cannot see; the shared 409 on a trashed one; one 409 for the caller's own
// challenge, one awaiting triage and a closed one; then (PUT) 422 for a headcount that is not a whole
// number from 1 to 1,000. A person's first mark auto-follows the challenge and tells its authors
// (§12.1 event 24) after the commit.
import { AFFECTED_MESSAGES, parseHeadcount } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyAffected } from "@/lib/notify-events";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { autoFollow } from "../../../follows/store";
import { affectedGate, removeAffected, setAffected, type AffectedWriteResult } from "../../affected";
import { isEntityNumber } from "../../validation";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => Response.json({ error: "challenge not found" }, { status: 404 });

function refusal(result: { status: Exclude<AffectedWriteResult["status"], "ok"> }): Response {
  if (result.status === "not_found") return NOT_FOUND();
  if (result.status === "trashed") return trashedResponse();
  return Response.json({ error: AFFECTED_MESSAGES.refused, code: "affected_refused" }, { status: 409 });
}

async function handlePUT(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return NOT_FOUND();

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  // The headcount is checked after the 404/409 gate (§2.4): a bad body on a hidden challenge is
  // still a 404, and on a closed one still the 409.
  const headcount = parseHeadcount(read.value.headcount);
  if (!headcount.ok) {
    const access = await affectedGate(pool, viewer, number);
    if (access.status !== "ok") return refusal({ status: access.status });
    return Response.json({ error: headcount.error, code: "invalid_headcount" }, { status: 422 });
  }
  const result = await setAffected(pool, viewer, number, headcount.value);
  if (result.status !== "ok") return refusal(result);

  if (result.first) {
    // §41.3: the first mark auto-follows; §41.6: and tells the authors, once per marker.
    await autoFollow(pool, gate.user.id, "challenge", result.challenge.id);
    await notifyAffected({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.challenge.id, gate.user.id, {
      headcount: headcount.value,
      reach: result.block.reach,
      people: result.block.affectedPeople,
    }).catch(logNotifyFailure("affected notification failed"));
  }
  return Response.json(result.block);
}

async function handleDELETE(_req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return NOT_FOUND();

  const result = await removeAffected(pool, { userId: gate.user.id, roles: gate.user.roles }, number);
  if (result.status !== "ok") return refusal(result);
  return Response.json(result.block);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PUT = withSystemLog("/api/challenges/[number]/affected", handlePUT);
export const DELETE = withSystemLog("/api/challenges/[number]/affected", handleDELETE);
