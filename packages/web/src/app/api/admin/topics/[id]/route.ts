// PATCH/DELETE /api/admin/topics/:id (INNOBOX_SPEC.md §34.2, §34.9): edit a topic's name and
// description, retire or reactivate it (PATCH), or delete a retired one (DELETE) — which removes it
// from every challenge and drops its follows, in one transaction, notifying no one. Platform admin
// only; audited as `topic.updated` / `topic.retired` / `topic.reactivated` / `topic.deleted`.
import { ACTIVE_TOPICS_MAX, validateTopicDescription, validateTopicName } from "@innobox/shared";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../challenges/validation";
import { deleteTopic, patchTopic } from "../../../topics/store";

async function handlePATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "topic not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const patch: { name?: string; description?: string | null; active?: boolean } = {};
  if (body.name !== undefined) {
    const name = validateTopicName(body.name);
    if (!name.ok) return Response.json({ error: name.error }, { status: 422 });
    patch.name = name.value;
  }
  if (body.description !== undefined) {
    const description = validateTopicDescription(body.description);
    if (!description.ok) return Response.json({ error: description.error }, { status: 422 });
    patch.description = description.value;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") return Response.json({ error: "active must be true or false" }, { status: 400 });
    patch.active = body.active;
  }

  const result = await patchTopic(pool, id.toLowerCase(), patch, gate.user.id);
  switch (result.status) {
    case "ok":
      return Response.json({ topic: result.topic });
    case "not_found":
      return Response.json({ error: "topic not found" }, { status: 404 });
    case "duplicate":
      return Response.json({ error: "A topic with that name already exists." }, { status: 409 });
    case "cap":
      return Response.json({ error: `There are already ${ACTIVE_TOPICS_MAX} active topics. Retire one first.` }, { status: 409 });
  }
}

async function handleDELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "topic not found" }, { status: 404 });

  const result = await deleteTopic(pool, id.toLowerCase(), gate.user.id);
  switch (result.status) {
    case "ok":
      return Response.json({ deleted: true, challengeCount: result.challengeCount, followerCount: result.followerCount });
    case "not_found":
      return Response.json({ error: "topic not found" }, { status: 404 });
    case "not_retired":
      return Response.json({ error: "Retire the topic before deleting it." }, { status: 409 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PATCH = withSystemLog("/api/admin/topics/[id]", handlePATCH);
export const DELETE = withSystemLog("/api/admin/topics/[id]", handleDELETE);
