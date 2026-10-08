// PATCH /api/notifications/:id (INNOBOX_SPEC.md §12.2): mark a single notification read.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { markOneRead } from "../store";

export async function PATCH(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const found = await markOneRead(pool, gate.user.id, id);
  if (!found) return Response.json({ error: "notification not found" }, { status: 404 });
  return Response.json({ ok: true });
}
