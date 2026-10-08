// PATCH/DELETE /api/comments/:id (INNOBOX_SPEC.md §10.2): owner edit/delete within 15
// minutes, or namespace/platform admin moderation (delete anytime, audited).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { deleteComment, editComment } from "../store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { isUuid } from "../validation";
import { withSystemLog } from "@/lib/system-log";

async function handlePATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "comment not found" }, { status: 404 });
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;

  const result = await editComment(pool, { userId: gate.user.id, roles: gate.user.roles }, id, body.body);
  switch (result.status) {
    case "ok":
      return Response.json({ comment: result.comment });
    case "not_found":
      return Response.json({ error: "comment not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "you can only edit your own comment within 15 minutes of posting" }, { status: 403 });
    case "invalid":
      return Response.json({ error: result.error }, { status: 400 });
  }
}

async function handleDELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { id } = await context.params;
  if (!isUuid(id)) return Response.json({ error: "comment not found" }, { status: 404 });

  const result = await deleteComment(pool, { userId: gate.user.id, roles: gate.user.roles }, id);
  switch (result.status) {
    case "ok":
      return new Response(null, { status: 204 });
    case "not_found":
      return Response.json({ error: "comment not found" }, { status: 404 });
    case "forbidden":
      return Response.json({ error: "you can only delete your own comment within 15 minutes, or moderate as an admin" }, { status: 403 });
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const PATCH = withSystemLog("/api/comments/[id]", handlePATCH);
export const DELETE = withSystemLog("/api/comments/[id]", handleDELETE);
