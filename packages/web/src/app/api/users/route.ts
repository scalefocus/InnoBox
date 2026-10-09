// GET /api/users?q= (INNOBOX_SPEC.md §7.3): searchable directory of active users, for the
// namespace admin's assignment picker. Auth-required; returns id/displayName/email only —
// no role/namespace data (this isn't an admin-only endpoint).
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { searchActiveUsers } from "./store";
import { withSystemLog } from "@/lib/system-log";
import { rateLimit } from "@/lib/rate-limit";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  // §2.4: the directory picker is a search/autocomplete read — the limited "search" bucket.
  const limited = rateLimit(gate.user.id, "search");
  if (limited) return limited;
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ users: [] });

  const users = await searchActiveUsers(pool, q);
  return Response.json({ users });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/users", handleGET);
