// PATCH /api/notifications/:id (INNOBOX_SPEC.md §12.2): mark a single notification read.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { markOneRead } from "../store";
import { rateLimit } from "@/lib/rate-limit";
import { isUuid } from "../../challenges/validation";

export async function PATCH(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "notification not found" }, { status: 404 });
  const found = await markOneRead(pool, gate.user.id, id);
  if (!found) return Response.json({ error: "notification not found" }, { status: 404 });
  return Response.json({ ok: true });
}
