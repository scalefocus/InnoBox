// GET/POST /api/comments (INNOBOX_SPEC.md §10.2): thread on a challenge or solution.
// Posting fires notification event 6 (§12.1) to the item author, other commenters, and
// followers — never the commenter. Messages always reference the parent CHALLENGE's
// number/title (solutions have no title of their own) but recipients are scoped to the
// comment's actual parent (a solution's own commenters/followers).
import { requireUser, resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { dispatchEvent, getFollowerUserIds, getOtherCommenterUserIds } from "@/lib/notify";
import { formatChallengeNumber } from "@innobox/shared";
import { parseCommentCreate, parseParentQuery } from "./validation";
import { createComment, listComments } from "./store";
import { readJsonObject } from "@/lib/http";
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
  const result = await createComment(pool, viewer, parsed.value.parentType, parsed.value.parentId, parsed.value.body);

  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  if (result.status === "invalid") return Response.json({ error: result.error }, { status: 400 });

  await fireCommentNotification(parsed.value.parentType, parsed.value.parentId, result.comment.authorId).catch((err) =>
    console.error(JSON.stringify({ level: "error", msg: "comment notification failed", error: String(err) })),
  );
  return Response.json({ comment: result.comment }, { status: 201 });
}

async function fireCommentNotification(parentType: "challenge" | "solution", parentId: string, commenterId: string): Promise<void> {
  const item =
    parentType === "challenge"
      ? await pool
          .query<{ id: string; number: string; title: string; author_id: string }>(
            `select id, number::text, title, author_id from challenges where id = $1`,
            [parentId],
          )
          .then((r) => (r.rows[0] ? { id: r.rows[0].id, authorId: r.rows[0].author_id, challengeNumber: r.rows[0].number, challengeTitle: r.rows[0].title } : null))
      : await pool
          .query<{ id: string; author_id: string; challenge_number: string; challenge_title: string }>(
            `select s.id, s.author_id, c.number::text as challenge_number, c.title as challenge_title
               from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
            [parentId],
          )
          .then((r) => (r.rows[0] ? { id: r.rows[0].id, authorId: r.rows[0].author_id, challengeNumber: r.rows[0].challenge_number, challengeTitle: r.rows[0].challenge_title } : null));
  if (!item) return;

  const [otherCommenters, followers] = await Promise.all([
    getOtherCommenterUserIds(pool, parentType, item.id),
    getFollowerUserIds(pool, parentType, item.id),
  ]);
  await dispatchEvent(
    { pool, actorId: commenterId, resolveRoles: resolveRolesForUser },
    { parentType, parentId: item.id },
    [item.authorId, ...otherCommenters, ...followers],
    "comment_posted",
    {
      message: `New comment on ${formatChallengeNumber(item.challengeNumber)} "${item.challengeTitle}".`,
      link: `/challenges/${item.challengeNumber}`,
    },
  );
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/comments", handleGET);
export const POST = withSystemLog("/api/comments", handlePOST);
