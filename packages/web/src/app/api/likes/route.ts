// POST /api/likes (INNOBOX_SPEC.md §13.1, likes pulled forward from Phase 3): toggle
// like/unlike on a challenge or solution. Comments and likes are never anonymous (§9) —
// the like itself always records the real user, only the ITEM's authorship may be masked.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { parseLikeToggle } from "../challenges/validation";
import { toggleLike } from "../challenges/store";
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
