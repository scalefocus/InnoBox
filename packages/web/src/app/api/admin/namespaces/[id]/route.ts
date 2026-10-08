// PATCH /api/admin/namespaces/:id — rename and/or archive/unarchive (ENTRA_AUTH_SPEC.md §5
// layer 3). The built-in 'global' namespace can be renamed but never archived (400). Every
// effected change is audited (namespace.renamed|archived|unarchived) in the store.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { isUuid, parseNamespacePatch } from "../../validation";
import { patchNamespace } from "../../store";

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  // Non-uuid ids can't exist — 404 without risking a Postgres cast error.
  if (!isUuid(id)) return Response.json({ error: "namespace not found" }, { status: 404 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const parsed = parseNamespacePatch(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const result = await patchNamespace(pool, id, parsed.value, gate.user.id);
  if (result.status === "not_found") {
    return Response.json({ error: "namespace not found" }, { status: 404 });
  }
  if (result.status === "global_archive") {
    return Response.json({ error: "the global namespace cannot be archived" }, { status: 400 });
  }
  return Response.json({ namespace: result.namespace });
}
