// GET /api/users/:userId/photo (INNOBOX_SPEC.md §3.1, §13.6): the authenticated avatar gateway —
// streams a user's cached Entra profile photo (a 240px image synced during reconciliation, §3.1).
// Auth-required like every route; 404 when the user has no photo OR is deactivated (the `active`
// filter), so the client's <AvatarBubble> falls back to the initials bubble. Not anonymity-
// sensitive: the client only ever holds a real user's id for a NON-anonymous author (maskAuthor
// returns userId=null when anonymous, invariant 3), so no photo can be fetched for an anonymous
// author. Honors If-None-Match against the stored photo etag → 304, so a warm browser cache
// revalidates cheaply instead of re-downloading the bytes.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { isUuid } from "../../../challenges/validation";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request, context: { params: Promise<{ userId: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const { userId } = await context.params;
  if (!isUuid(userId)) return new Response(null, { status: 404 });

  const { rows } = await pool.query<{ photo: Buffer | null; photo_etag: string | null }>(
    `select photo, photo_etag from users where id = $1 and active = true`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.photo) return new Response(null, { status: 404 });

  // Conditional revalidation: if the client already holds this exact etag, skip the bytes.
  const etag = row.photo_etag ? `"${row.photo_etag}"` : undefined;
  if (etag && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, max-age=3600, must-revalidate" } });
  }

  return new Response(new Uint8Array(row.photo), {
    status: 200,
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600, must-revalidate",
      ...(etag ? { etag } : {}),
    },
  });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/users/[userId]/photo", handleGET);
