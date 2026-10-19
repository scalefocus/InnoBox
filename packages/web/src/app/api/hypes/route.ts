// POST /api/hypes (INNOBOX_SPEC.md §26.11): spend one of this week's hypes on an open challenge
// or solution. There is no DELETE — a hype cannot be taken back (§26 decision 3). Order of checks
// (§2.4): 404 while hype is off, for a malformed id or an item the viewer cannot see; the trashed
// response; then 409 with a plain message for a closed or own item (one shared message, so the
// refusal says nothing about an anonymous item's author), a repeat, or an exhausted budget.
// A successful hype notifies the item's author after commit (§12.1 event 16).
import { HYPE_MESSAGES } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getHypeEnabled } from "@/lib/hype-settings";
import { logNotifyFailure, notifyHyped } from "@/lib/notify-events";
import { parseLikeToggle } from "../challenges/validation";
import { giveHype } from "./store";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  if (!(await getHypeEnabled(pool))) return Response.json({ error: "not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  // The body is the same { parentType, parentId } pair a like takes.
  const parsed = parseLikeToggle(read.value);
  if (!parsed.ok) {
    // A malformed id is "not found" (§2.4); a malformed shape is a 400.
    const status = parsed.error.includes("parentId") ? 404 : 400;
    return Response.json({ error: status === 404 ? "not found" : parsed.error }, { status });
  }

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const result = await giveHype(pool, viewer, parsed.value.parentType, parsed.value.parentId);
  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  if (result.status === "trashed") return trashedResponse();
  if (result.status === "refused") return Response.json({ error: HYPE_MESSAGES[result.reason] }, { status: 409 });

  await notifyHyped(
    { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
    parsed.value.parentType,
    parsed.value.parentId,
    gate.user.id,
    result.hype,
  ).catch(logNotifyFailure("hype notification failed"));
  return Response.json({ hyped: true, hype: result.hype, hypesLeft: result.hypesLeft, hypers: result.hypers });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/hypes", handlePOST);
