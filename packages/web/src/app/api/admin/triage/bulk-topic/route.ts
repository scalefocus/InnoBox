// POST /api/admin/triage/bulk-topic (INNOBOX_SPEC.md §14.1, §34.6): bulk *Add topic* / *Remove
// topic* over a selection — `{ numbers, action: "add" | "remove", topicId }`. Each changed challenge
// is re-tagged in its own transaction and audited on its own (`challenge.topics_changed`, `via:
// "bulk"`); per item the outcome is ok, unchanged or topic_limit. A topic added to a `valid`
// challenge tells that topic's followers, exactly as the detail page's control does (§34.5).
import { TOPIC_SET_ERROR } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { logNotifyFailure, notifyTopicFollowers } from "@/lib/notify-events";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { loadTopics } from "../../../topics/tagging";
import { bulkChangeTopic } from "../../../topics/store";
import { adminNamespaceIds } from "../store";
import { parseBulkTopicBody } from "../validation";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const admin = { userId: gate.user.id, roles: gate.user.roles };
  const adminNs = adminNamespaceIds(admin.roles);
  if (adminNs !== "all" && adminNs.length === 0) return Response.json({ error: "forbidden" }, { status: 403 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseBulkTopicBody(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  // §34.3: the topic must exist, and may be added only while active (removing a retired one is fine).
  const topic = (await loadTopics(pool, [parsed.value.topicId])).get(parsed.value.topicId);
  if (!topic) return Response.json({ error: TOPIC_SET_ERROR.unknown }, { status: 422 });
  if (parsed.value.action === "add" && !topic.active) return Response.json({ error: TOPIC_SET_ERROR.inactive }, { status: 422 });

  const notify = { pool, actorId: admin.userId, resolveRoles: resolveRolesForUser };
  const outcomes = await bulkChangeTopic(pool, admin, parsed.value.numbers, parsed.value.action, parsed.value.topicId, (challengeId, topicIds) =>
    notifyTopicFollowers(notify, challengeId, { via: "topic_added", topicIds }).catch(logNotifyFailure("bulk topic notification failed")),
  );
  return Response.json({ outcomes });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/triage/bulk-topic", handlePOST);
