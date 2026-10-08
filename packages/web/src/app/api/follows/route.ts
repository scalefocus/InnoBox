// POST /api/follows (INNOBOX_SPEC.md §12.3): toggle follow/unfollow on a challenge or
// solution. Auto-follow on submit/propose is called directly by the challenges store.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseFollowToggle } from "./validation";
import { toggleFollow } from "./store";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(req: Request): Promise<Response> {
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
