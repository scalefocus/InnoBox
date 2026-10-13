// POST /api/admin/public-submissions/:id/accept (INNOBOX_SPEC.md §24.5, §24.6, §24.9):
// `{ namespaceId, visibility, access?, impactAreaId, clientName?, title, description }` → `{ number }`.
// `visibility` may be `people` (§4.3), with the access list `access: { userIds, emails }`. One
// transaction creates the challenge (awaiting_triage, no author) and marks the row accepted; after
// commit, everything a new challenge triggers follows — §12.1 event 1 to the namespace's admins and
// the platform admins. Nobody is auto-followed: there is no author. 409 when another admin decided
// first. Platform admin only.
import { resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { dispatchEvent, getNamespaceAdminUserIds } from "@/lib/notify";
import { logNotifyFailure } from "@/lib/notify-events";
import { withSystemLog } from "@/lib/system-log";
import { isUuid } from "../../../../challenges/validation";
import { TEAMS_NEED_NAMESPACE, acceptPublicSubmission } from "../../store";
import { decisionGate, refusal } from "../decisions";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await decisionGate(context);
  if (!gate.ok) return gate.response;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  if (typeof body.namespaceId !== "string" || !isUuid(body.namespaceId)) return Response.json({ error: "namespaceId must be a uuid" }, { status: 400 });
  if (typeof body.impactAreaId !== "string" || !isUuid(body.impactAreaId)) return Response.json({ error: "impactAreaId must be a uuid" }, { status: 400 });

  const result = await acceptPublicSubmission(pool, { userId: gate.user.id, roles: gate.user.roles }, gate.id, {
    namespaceId: body.namespaceId,
    impactAreaId: body.impactAreaId,
    visibility: body.visibility,
    access: body.access,
    clientName: body.clientName,
    title: body.title,
    description: body.description,
  });
  switch (result.status) {
    case "ok": {
      await dispatchEvent(
        { pool, actorId: gate.user.id, resolveRoles: resolveRolesForUser },
        { parentType: "challenge", parentId: result.challengeId },
        await getNamespaceAdminUserIds(pool, result.namespaceId),
        "challenge_submitted",
        { message: `New challenge ${result.number} "${result.title}" needs triage.`, link: `/challenges/${result.number.replace("CH-", "")}` },
      ).catch(logNotifyFailure("challenge.submitted notification failed"));
      return Response.json({ number: result.number });
    }
    case "not_found":
    case "conflict":
      return refusal(result.status);
    case "unknown_namespace":
      return Response.json({ error: "namespace not found" }, { status: 400 });
    case "namespace_archived":
      return Response.json({ error: "this namespace is archived and accepts no new challenges", code: "namespace_archived" }, { status: 409 });
    case "unknown_impact_area":
      return Response.json({ error: "impact area not found" }, { status: 400 });
    case "inactive_impact_area":
      return Response.json({ error: "impact area is retired" }, { status: 400 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
    case "invalid_access":
      return Response.json({ error: result.error }, { status: 422 });
    case "teams_need_namespace":
      return Response.json({ error: TEAMS_NEED_NAMESPACE, code: "teams_need_namespace" }, { status: 422 });
  }
}

export const POST = withSystemLog("/api/admin/public-submissions/[id]/accept", handlePOST);
