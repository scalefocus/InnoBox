// POST /api/challenges/:number/duplicate (INNOBOX_SPEC.md §42.3, §42.9): Mark as duplicate.
// `{ original, note? }` — the original's number (`CH-12` or `12`) and an optional note (≤ 500).
// Order of checks: 404 for a malformed number or a challenge the caller cannot see; the shared 409
// when it is trashed; 403 for an actor who may not mark; 409 for the status and for an open
// solution; 422 for the original, then the note. The mark is one transaction (§42.4); event 25
// (§42.6) goes out after it commits.
import { requireUser, resolveRolesForUser, resolveRolesForUsers } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { logNotifyFailure, notifyClosedAsDuplicate } from "@/lib/notify-events";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { markDuplicate } from "../../duplicates";
import { duplicateRefusalResponse } from "../../duplicate-responses";
import { isEntityNumber } from "../../validation";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const actor = { userId: gate.user.id, roles: gate.user.roles };
  const result = await markDuplicate(pool, actor, number, { original: read.value.original, note: read.value.note }, resolveRolesForUsers);
  if (result.status !== "ok") return duplicateRefusalResponse(result);

  await notifyClosedAsDuplicate({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.notice).catch(
    logNotifyFailure("closed-as-duplicate notification failed"),
  );
  return Response.json({ challenge: result.challenge });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/duplicate", handlePOST);
