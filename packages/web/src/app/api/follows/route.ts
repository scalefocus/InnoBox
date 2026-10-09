// POST/DELETE /api/follows (INNOBOX_SPEC.md §12.3, §16): POST toggles follow/unfollow on a
// challenge or solution (what the UI's follow button calls); DELETE is the idempotent unfollow —
// unfollowing something not followed is a no-op success. Both take `{ parentType, parentId }`,
// answer 404 for an item the viewer cannot see, and are rate-limited (the Origin/CSRF check
// applies to both in the middleware). Auto-follow on submit/propose is called directly by the
// challenges store.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseFollowToggle } from "./validation";
import { toggleFollow, unfollow } from "./store";
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
  const parsed = parseFollowToggle(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await toggleFollow(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value.parentType, parsed.value.parentId);
  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ following: result.following });
}

async function handleDELETE(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseFollowToggle(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

  const result = await unfollow(pool, { userId: gate.user.id, roles: gate.user.roles }, parsed.value.parentType, parsed.value.parentId);
  if (result.status === "not_found") return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ following: result.following });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/follows", handlePOST);
export const DELETE = withSystemLog("/api/follows", handleDELETE);
