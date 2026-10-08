// GET/POST /api/challenges (INNOBOX_SPEC.md §13.1): the gallery list and challenge
// submission (§6.1). Auth-required (any authenticated user may submit and browse per
// their visibility); every list is visibility-filtered and anonymity-masked server-side.
// Submission auto-follows the author (§12.3) and notifies namespace admins (§12.1 event 1).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchEvent, getNamespaceAdminUserIds } from "@/lib/notify";
import { autoFollow } from "../follows/store";
import { parseChallengeCreateIds, parseChallengeListFilters } from "./validation";
import { createChallenge, listChallenges } from "./store";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const parsed = parseChallengeListFilters(url.searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const challenges = await listChallenges(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value);
  return Response.json({ challenges });
}

export async function POST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }

  const ids = parseChallengeCreateIds(body);
  if (!ids.ok) return Response.json({ error: ids.error }, { status: 400 });

  const rec = body as Record<string, unknown>;
  const result = await createChallenge(
    pool,
    { userId: gate.user.id, roles: gate.user.roles },
    {
      impactAreaId: ids.value.impactAreaId,
      namespaceId: ids.value.namespaceId,
      title: rec.title,
      description: rec.description,
      clientName: rec.clientName,
      visibility: rec.visibility,
      isAnonymous: rec.isAnonymous,
      draftKey: rec.draftKey,
    },
  );

  switch (result.status) {
    case "ok": {
      await autoFollow(pool, gate.user.id, "challenge", result.challenge.id);
      await dispatchEvent(
        { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
        { parentType: "challenge", parentId: result.challenge.id },
        await getNamespaceAdminUserIds(pool, ids.value.namespaceId),
        "challenge_submitted",
        {
          message: `New challenge ${result.challenge.number} "${result.challenge.title}" needs triage.`,
          link: `/challenges/${result.challenge.number.replace("CH-", "")}`,
        },
      ).catch((err) => console.error(JSON.stringify({ level: "error", msg: "challenge.submitted notification failed", error: String(err) })));
      return Response.json({ challenge: result.challenge }, { status: 201 });
    }
    case "unknown_namespace":
      return Response.json({ error: "namespace not found or archived" }, { status: 400 });
    case "forbidden_namespace":
      return Response.json({ error: "you are not a member of that namespace" }, { status: 403 });
    case "unknown_impact_area":
      return Response.json({ error: "impact area not found" }, { status: 400 });
    case "inactive_impact_area":
      return Response.json({ error: "impact area is retired" }, { status: 400 });
    case "attachments_not_clean":
      return Response.json({ error: "wait for all attachments to finish scanning (or remove any that failed) before submitting" }, { status: 409 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
  }
}
