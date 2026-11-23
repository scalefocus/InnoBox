// GET/POST /api/comments (INNOBOX_SPEC.md §10.2): thread on a challenge or solution.
// Posting fires notification event 6 (§12.1) to the item author, other commenters, and
// followers — never the commenter. Messages always reference the parent CHALLENGE's
// number/title (solutions have no title of their own) but recipients are scoped to the
// comment's actual parent (a solution's own commenters/followers). A reply (§10.2, `replyTo`) is a
// comment like any other; its row also counts it as a reply for the author of the comment answered.
//
// §44: a comment is Markdown with mentions. The POST takes the box's `mentions: [{ userId, name }]`;
// each person it newly mentions is told at once by event 27 — INSTEAD of event 6 for this comment —
// and the GET returns display text with each mention's place, plus the viewer's room under the caps.
import { COMMENT_MENTION_MESSAGES, DUPLICATE_MESSAGES, parseMentionsInput } from "@innobox/shared";
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { logNotifyFailure, notifyCommentMentioned, notifyCommentPosted } from "@/lib/notify-events";
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

  const list = await listComments(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value.parentType, parsed.value.parentId);
  if (list === null) return Response.json({ error: "not found" }, { status: 404 });
  // §44.10: `mentionsLeftToday` is the viewer's room under the daily cap, shared with solution text.
  return Response.json({ comments: list.comments, mentionsLeftToday: list.mentionsLeftToday });
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
  // §44.10: the box's Mentioned row. Absent (or null) is "no list": the comment mentions nobody.
  const mentions = parseMentionsInput(body.mentions);
  if (!mentions.ok) return Response.json({ error: mentions.error }, { status: 400 });

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const result = await createComment(pool, viewer, parsed.value.parentType, parsed.value.parentId, parsed.value.body, undefined, parsed.value.replyTo, undefined, {
    candidates: mentions.value,
    resolveRoles: resolveRolesForUser,
  });

  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  if (result.status === "trashed") return trashedResponse();
  // §10.2 / §42.5: a duplicate (or a solution under one) takes no new comment or reply.
  if (result.status === "closed") return Response.json({ error: DUPLICATE_MESSAGES.commentsClosed, code: "comments_closed" }, { status: 409 });
  if (result.status === "invalid") return Response.json({ error: result.error }, { status: 400 });
  if (result.status === "unprocessable") return Response.json({ error: result.error }, { status: 422 });
  // §44.5: one answer for every reason a person can't be mentioned; the caps are 409. Nothing was written.
  if (result.status === "ineligible_mention") return Response.json({ error: COMMENT_MENTION_MESSAGES.ineligible }, { status: 422 });
  if (result.status === "mention_cap") {
    return Response.json({ error: result.reason === "comment_cap" ? COMMENT_MENTION_MESSAGES.commentCap : COMMENT_MENTION_MESSAGES.dailyCap, code: result.reason }, { status: 409 });
  }

  const ctx = { pool, actorId: result.comment.authorId, resolveRoles: resolveRolesForUser };
  // §44.6 event 27 first: whoever it reaches is left out of this comment's event 6. A person it does
  // not reach — their Mentions preference is off — stays on event 6's own routes.
  const told = await notifyCommentMentioned(ctx, result.comment, result.mentioned).catch((err: unknown) => {
    logNotifyFailure("comment mention notification failed")(err);
    return [] as string[];
  });
  await notifyCommentPosted(ctx, parsed.value.parentType, parsed.value.parentId, result.comment.authorId, result.replyToAuthorId, told).catch(
    logNotifyFailure("comment notification failed"),
  );
  return Response.json({ comment: result.comment }, { status: 201 });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/comments", handleGET);
export const POST = withSystemLog("/api/comments", handlePOST);
