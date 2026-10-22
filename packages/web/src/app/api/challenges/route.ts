// GET/POST /api/challenges (INNOBOX_SPEC.md §13.1): the gallery list and challenge
// submission (§6.1). Auth-required (any authenticated user may submit and browse per
// their visibility); every list is visibility-filtered and anonymity-masked server-side.
// Submission auto-follows the author (§12.3) and notifies namespace admins (§12.1 event 1).
import { parseTopicIds, TOPIC_SET_ERROR } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyChallengeSubmitted } from "@/lib/notify-events";
import { autoFollow } from "../follows/store";
import { parseChallengeCreateIds, parseChallengeListFilters, parseSimilarAcknowledged } from "./validation";
import { createChallenge, listChallenges } from "./store";
import { getHypeEnabled } from "@/lib/hype-settings";
import { withHypePoints } from "../hypes/store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const parsed = parseChallengeListFilters(url.searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  // §26.8: while hype is off the "most hyped" sort falls back to newest and no hype number ships.
  const hypeOn = await getHypeEnabled(pool);
  const filters = !hypeOn && parsed.value.sort === "most_hyped" ? { ...parsed.value, sort: "newest" as const } : parsed.value;
  const challenges = await listChallenges(pool, { userId: gate.user.id, roles: gate.user.roles }, filters);
  return Response.json({ challenges: hypeOn ? await withHypePoints(pool, challenges) : challenges });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "create");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;

  const ids = parseChallengeCreateIds(body);
  if (!ids.ok) return Response.json({ error: ids.error }, { status: 400 });
  // §34.3: optional — absent means no topics.
  const topicIds = body.topicIds === undefined ? { ok: true as const, value: [] } : parseTopicIds(body.topicIds);
  if (!topicIds.ok) return Response.json({ error: topicIds.error }, { status: 422 });

  const result = await createChallenge(
    pool,
    { userId: gate.user.id, roles: gate.user.roles },
    {
      impactAreaId: ids.value.impactAreaId,
      namespaceId: ids.value.namespaceId,
      title: body.title,
      description: body.description,
      clientName: body.clientName,
      visibility: body.visibility,
      isAnonymous: body.isAnonymous,
      draftKey: body.draftKey,
      similarAcknowledged: parseSimilarAcknowledged(body.similarAcknowledged),
      topicIds: topicIds.value,
    },
  );

  switch (result.status) {
    case "ok": {
      await autoFollow(pool, gate.user.id, "challenge", result.challenge.id);
      await notifyChallengeSubmitted(
        { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
        { id: result.challenge.id, number: result.challenge.number, title: result.challenge.title, namespaceId: ids.value.namespaceId },
      ).catch(logNotifyFailure("challenge.submitted notification failed"));
      return Response.json({ challenge: result.challenge }, { status: 201 });
    }
    case "unknown_namespace":
      return Response.json({ error: "namespace not found" }, { status: 400 });
    case "namespace_archived":
      return Response.json({ error: "this namespace is archived and accepts no new challenges", code: "namespace_archived" }, { status: 409 });
    case "forbidden_namespace":
      return Response.json({ error: "you are not a member of that namespace" }, { status: 403 });
    case "unknown_impact_area":
      return Response.json({ error: "impact area not found" }, { status: 400 });
    case "inactive_impact_area":
      return Response.json({ error: "impact area is retired" }, { status: 400 });
    case "invalid_topics":
      return Response.json({ error: TOPIC_SET_ERROR[result.problem] }, { status: 422 });
    case "attachments_not_clean":
      return Response.json(
        { error: "wait for all attachments to finish scanning (or remove any that failed) before submitting", code: "attachments_not_clean" },
        { status: 409 },
      );
    case "attachments_over_limit":
      return Response.json({ error: "too many attachments — remove some before submitting", code: "attachments_over_limit" }, { status: 409 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/challenges", handleGET);
export const POST = withSystemLog("/api/challenges", handlePOST);
