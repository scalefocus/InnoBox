// PUT /api/challenges/:number/topics (INNOBOX_SPEC.md §34.3, §34.9): a namespace admin of the
// challenge's namespace or a platform admin replaces its topics — curation, not a content edit
// (no edited_at), audited as `challenge.topics_changed`. 404 when the caller cannot see the
// challenge, the shared 409 on a trashed one (the platform admin's read-only view, §10.4), 403 for
// any other viewer, 422 for the tagging rules. A topic added while the challenge is `valid` tells
// that topic's followers (§34.5 event 18).
import { parseTopicIds, TOPIC_SET_ERROR } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyTopicFollowers } from "@/lib/notify-events";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isEntityNumber } from "../../validation";
import { setChallengeTopics } from "../../../topics/store";

export const dynamic = "force-dynamic";

async function handlePUT(req: Request, context: { params: Promise<{ number: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { number } = await context.params;
  if (!isEntityNumber(number)) return Response.json({ error: "challenge not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const topicIds = parseTopicIds(read.value.topicIds);
  if (!topicIds.ok) return Response.json({ error: topicIds.error }, { status: 422 });

  const result = await setChallengeTopics(pool, { userId: gate.user.id, roles: gate.user.roles }, number, topicIds.value);
  switch (result.status) {
    case "ok":
      if (result.addedTopicIds.length > 0) {
        await notifyTopicFollowers({ pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser }, result.challengeId, {
          via: "topic_added",
          topicIds: result.addedTopicIds,
        }).catch(logNotifyFailure("topic notification failed"));
      }
      return Response.json({ topics: result.topics });
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: "you must be a namespace or platform admin to change topics" }, { status: 403 });
    case "invalid_topics":
      return Response.json({ error: TOPIC_SET_ERROR[result.problem] }, { status: 422 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PUT = withSystemLog("/api/challenges/[number]/topics", handlePUT);
