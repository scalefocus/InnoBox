// POST/DELETE /api/likes (INNOBOX_SPEC.md §13.1, §16): POST toggles like/unlike on a challenge or
// solution (what the UI's like button calls); DELETE is the idempotent unlike — removing a like
// that is not there is a no-op success. Both take `{ parentType, parentId }`, answer 404 for an
// item the viewer cannot see, and are rate-limited (the Origin/CSRF check applies to both in the
// middleware). Comments and likes are never anonymous (§9) — the like itself always records the
// real user, only the ITEM's authorship may be masked.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseLikeToggle } from "../challenges/validation";
import { toggleLike } from "../challenges/store";
import { removeLike } from "./store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.value;
  const parsed = parseLikeToggle(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await toggleLike(
    pool,
    { userId: gate.user.id, roles: gate.user.roles },
    parsed.value.parentType,
    parsed.value.parentId,
  );
  if (result.status === "not_found") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ liked: result.liked, count: result.count });
}

async function handleDELETE(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseLikeToggle(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await removeLike(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value.parentType, parsed.value.parentId);
  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ liked: result.liked, count: result.count });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/likes", handlePOST);
export const DELETE = withSystemLog("/api/likes", handleDELETE);
