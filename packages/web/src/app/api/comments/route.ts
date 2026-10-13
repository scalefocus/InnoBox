// GET/POST /api/comments (INNOBOX_SPEC.md §10.2): thread on a challenge or solution.
// Posting fires notification event 6 (§12.1) to the item author, other commenters, and
// followers — never the commenter. Messages always reference the parent CHALLENGE's
// number/title (solutions have no title of their own) but recipients are scoped to the
// comment's actual parent (a solution's own commenters/followers). A reply (§10.2, `replyTo`) is a
// comment like any other; its row also counts it as a reply for the author of the comment answered.
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyCommentPosted } from "@/lib/notify-events";
import { parseCommentCreate, parseParentQuery } from "./validation";
import { createComment, listComments } from "./store";
import { readJsonObject, trashedResponse } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const parsed = parseParentQuery(url.searchParams);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const comments = await listComments(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value.parentType, parsed.value.parentId);
  if (comments === null) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ comments });
}

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "comment");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseCommentCreate(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const result = await createComment(pool, viewer, parsed.value.parentType, parsed.value.parentId, parsed.value.body, undefined, parsed.value.replyTo);

  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  if (result.status === "trashed") return trashedResponse();
  if (result.status === "invalid") return Response.json({ error: result.error }, { status: 400 });
  if (result.status === "unprocessable") return Response.json({ error: result.error }, { status: 422 });

  await notifyCommentPosted(
    { pool, actorId: result.comment.authorId, resolveRoles: resolveRolesForUser },
    parsed.value.parentType,
    parsed.value.parentId,
    result.comment.authorId,
    result.replyToAuthorId,
  ).catch(logNotifyFailure("comment notification failed"));
  return Response.json({ comment: result.comment }, { status: 201 });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/comments", handleGET);
export const POST = withSystemLog("/api/comments", handlePOST);
