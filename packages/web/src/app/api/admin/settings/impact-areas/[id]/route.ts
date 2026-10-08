// PATCH/DELETE /api/admin/settings/impact-areas/:id (INNOBOX_SPEC.md §5, §14.3): rename or
// retire/reactivate an impact area (PATCH), or delete a retired one — optionally reassigning
// its challenges to another active area via ?reassignToId= (DELETE). Platform-admin only; audited.
import { isUuid } from "../../../../challenges/validation";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { deleteImpactArea, patchImpactArea } from "../../store";
import { parseImpactAreaPatch } from "../../validation";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handlePATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseImpactAreaPatch(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await patchImpactArea(pool, id, parsed.value, gate.user.id);
  switch (result.status) {
    case "ok":
      return Response.json({ area: result.area });
    case "not_found":
      return Response.json({ error: "not found" }, { status: 404 });
    case "duplicate":
      return Response.json({ error: "an impact area with that name already exists" }, { status: 409 });
  }
}

async function handleDELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });

  const reassignToId = new URL(req.url).searchParams.get("reassignToId");
  if (reassignToId !== null && !isUuid(reassignToId)) {
    return Response.json({ error: "reassignToId must be a uuid" }, { status: 400 });
  }

  const result = await deleteImpactArea(pool, id, reassignToId, gate.user.id);
  switch (result.status) {
    case "ok":
      return new Response(null, { status: 204 });
    case "not_found":
      return Response.json({ error: "not found" }, { status: 404 });
    case "not_retired":
      return Response.json({ error: "retire the impact area before deleting it" }, { status: 409 });
    case "has_references":
      return Response.json({ error: "challenges still use this impact area — choose an area to move them to" }, { status: 409 });
    case "target_not_found":
      return Response.json({ error: "the selected reassignment area was not found" }, { status: 400 });
    case "invalid_target":
      return Response.json({ error: "the reassignment area must be a different active area, and cannot be Client" }, { status: 400 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PATCH = withSystemLog("/api/admin/settings/impact-areas/[id]", handlePATCH);
export const DELETE = withSystemLog("/api/admin/settings/impact-areas/[id]", handleDELETE);
