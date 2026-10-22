// The §39 team endpoints (INNOBOX_SPEC.md §39.13) — one implementation behind the four routes:
//   POST   /api/challenges/:number/authors           { userId }   add a member
//   DELETE /api/challenges/:number/authors/:userId                 remove one — the caller's own id leaves
// and the `solutions/:number/authors` twins. Members only; the `mutation` bucket; the middleware
// checks the Origin. Order of refusals: 404 → 403 → 409 → 422 (the store's changeTeam). Success
// returns `{ authors }` and, after the commit, sends event 21 to the person added or removed — never
// on a leave (§39.8).
import { TEAM_REFUSAL_MESSAGE, TEAM_REFUSAL_STATUS } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { logNotifyFailure, notifyTeamChange } from "@/lib/notify-events";
import { rateLimit } from "@/lib/rate-limit";
import { changeTeam, type TeamChangeResult } from "./store";
import { isEntityNumber } from "./validation";

type Entity = "challenge" | "solution";

function notFound(entity: Entity): Response {
  return Response.json({ error: `${entity} not found` }, { status: 404 });
}

async function respond(entity: Entity, actorId: string, result: TeamChangeResult): Promise<Response> {
  if (result.status === "not_found") return notFound(entity);
  if (result.status === "refused") {
    return Response.json({ error: TEAM_REFUSAL_MESSAGE[result.refusal], code: result.refusal }, { status: TEAM_REFUSAL_STATUS[result.refusal] });
  }
  if (result.notice) {
    await notifyTeamChange({ pool, actorId, resolveRoles: resolveRolesForUser }, result.notice).catch(logNotifyFailure("co-author notification failed"));
  }
  return Response.json({ authors: result.authors });
}

/** POST …/authors { userId } — add a member (§39.4). */
export function teamPOST(entity: Entity) {
  return async (req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> => {
    const gate = await requireUser();
    if (!gate.ok) return gate.response;
    const limited = rateLimit(gate.user.id, "mutation");
    if (limited) return limited;
    const { number } = await context.params;
    if (!isEntityNumber(number)) return notFound(entity);
    const read = await readJsonObject(req);
    if (!read.ok) return read.response;
    if (typeof read.value.userId !== "string") return Response.json({ error: "userId is required" }, { status: 400 });

    const viewer = { userId: gate.user.id, roles: gate.user.roles };
    const result = await changeTeam(pool, viewer, entity, number, { op: "add", userId: read.value.userId }, resolveRolesForUser);
    return respond(entity, gate.user.id, result);
  };
}

/** DELETE …/authors/:userId — remove a member, or leave with the caller's own id (§39.4). */
export function teamDELETE(entity: Entity) {
  return async (_req: Request, context: { params: Promise<{ number: string; userId: string }> }): Promise<Response> => {
    const gate = await requireUser();
    if (!gate.ok) return gate.response;
    const limited = rateLimit(gate.user.id, "mutation");
    if (limited) return limited;
    const { number, userId } = await context.params;
    if (!isEntityNumber(number)) return notFound(entity);

    const viewer = { userId: gate.user.id, roles: gate.user.roles };
    const result = await changeTeam(pool, viewer, entity, number, { op: "remove", userId }, resolveRolesForUser);
    return respond(entity, gate.user.id, result);
  };
}
