// GET /api/users?q=&challenge= (INNOBOX_SPEC.md §7.3): searchable directory of active users,
// for the namespace admin's assignment picker. Auth-required; returns id/displayName/email only —
// no role/namespace data (this isn't an admin-only endpoint). With `challenge=<number>` (the
// per-challenge pickers) only users who can see that challenge are returned. Which users those are
// reveals namespace membership and admin roles, so the filtered form answers only an admin of the
// challenge's namespace — the same gate as the assign endpoint; anyone else, and any challenge the
// caller cannot see or that does not exist, gets no users (§2.4 existence-not-disclosed).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { getAssignmentAudience } from "../challenges/store";
import { searchActiveUsers } from "./store";
import { withSystemLog } from "@/lib/system-log";
import { rateLimit } from "@/lib/rate-limit";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  // §2.4: the directory picker is a search/autocomplete read — the limited "search" bucket.
  const limited = rateLimit(gate.user.id, "search");
  if (limited) return limited;
  const searchParams = new URL(req.url).searchParams;
  const q = searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ users: [] });

  const challenge = searchParams.get("challenge");
  if (challenge === null) return Response.json({ users: await searchActiveUsers(pool, q) });
  const audience = await getAssignmentAudience(pool, { userId: gate.user.id, roles: gate.user.roles }, challenge.replace(/^CH-/i, ""));
  if (!audience) return Response.json({ users: [] });
  const users = await searchActiveUsers(pool, q, audience);
  return Response.json({ users });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/users", handleGET);
