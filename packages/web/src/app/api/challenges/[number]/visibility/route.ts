// POST /api/challenges/:number/visibility (INNOBOX_SPEC.md §4.3, §14.2, §16): a namespace/platform
// admin changes a challenge's visibility (org | namespace | people) after submission. `people`
// takes the whole access list `{ access: { userIds, emails } }`, which the same call also uses to
// edit the list of a challenge that stays `people`. Audited as `challenge.visibility_changed` and
// `challenge.access_changed` (§15). Solutions/comments/likes inherit the new visibility. A change on
// a `valid` challenge may tell its topics' followers who can now see it (§34.5 event 18).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyTopicFollowers } from "@/lib/notify-events";
import { setChallengeVisibility } from "../../store";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isEntityNumber } from "../../validation";
import { withSystemLog } from "@/lib/system-log";

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
  const body = read.value;
  const visibility = body.visibility;
  if (typeof visibility !== "string") return Response.json({ error: "visibility is required" }, { status: 400 });

  const result = await setChallengeVisibility(pool, { userId: gate.user.id, roles: gate.user.roles }, number, visibility, body.access);
  switch (result.status) {
    case "ok":
      // §34.5 event 18: a `valid` challenge that more people can now see tells its topics'
      // followers among them (the dispatch checks the status and who could see it before).
      if (result.previousVisibility) {
        await notifyTopicFollowers({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.challenge.id, {
          via: "widened",
          previousVisibility: result.previousVisibility,
        }).catch(logNotifyFailure("topic notification failed"));
      }
      return Response.json({ challenge: result.challenge });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: "you must be a namespace or platform admin to change visibility" }, { status: 403 });
    case "invalid":
      return Response.json({ error: "visibility must be 'org', 'namespace' or 'people'" }, { status: 400 });
    case "invalid_access":
      return Response.json({ error: result.error }, { status: 422 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/challenges/[number]/visibility", handlePOST);
