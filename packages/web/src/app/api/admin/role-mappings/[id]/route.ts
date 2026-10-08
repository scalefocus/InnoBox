// DELETE /api/admin/role-mappings/:id — platform-admin only (ENTRA_AUTH_SPEC.md §5 layer 3).
// Deletion is audited (role_mapping.deleted, with the removed grant as `before`) in the store.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { isUuid } from "../../validation";
import { deleteRoleMapping } from "../../store";

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  // Non-uuid ids can't exist — 404 without risking a Postgres cast error.
  if (!isUuid(id)) return Response.json({ error: "role mapping not found" }, { status: 404 });
  const deleted = await deleteRoleMapping(pool, id, gate.user.id);
  if (!deleted) return Response.json({ error: "role mapping not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
