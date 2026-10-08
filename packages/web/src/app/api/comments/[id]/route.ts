// PATCH/DELETE /api/comments/:id (INNOBOX_SPEC.md §10.2): owner edit/delete within 15
// minutes, or namespace/platform admin moderation (delete anytime, audited).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { deleteComment, editComment } from "../store";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  const rec = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  const result = await editComment(pool, { userId: gate.user.id, roles: gate.user.roles }, id, rec.body);
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

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { id } = await context.params;

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
