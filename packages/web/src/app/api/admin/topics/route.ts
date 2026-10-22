// GET/POST /api/admin/topics (INNOBOX_SPEC.md §34.2, §34.9): the Topics card on Platform settings —
// every topic with its challenge and follower counts (bare numbers, never who), and adding one.
// Platform admin only (403 otherwise); audited as `topic.created`. At most 100 active topics (409).
import { validateTopicDescription, validateTopicName, ACTIVE_TOPICS_MAX } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { createTopic, listAllTopics } from "../../topics/store";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json({ topics: await listAllTopics(pool) });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const name = validateTopicName(read.value.name);
  if (!name.ok) return Response.json({ error: name.error }, { status: 422 });
  const description = validateTopicDescription(read.value.description);
  if (!description.ok) return Response.json({ error: description.error }, { status: 422 });

  const result = await createTopic(pool, { name: name.value, description: description.value }, gate.user.id);
  switch (result.status) {
    case "ok":
      return Response.json({ topic: result.topic }, { status: 201 });
    case "duplicate":
      return Response.json({ error: "A topic with that name already exists." }, { status: 409 });
    case "cap":
      return Response.json({ error: `There are already ${ACTIVE_TOPICS_MAX} active topics. Retire one first.` }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/topics", handleGET);
export const POST = withSystemLog("/api/admin/topics", handlePOST);
