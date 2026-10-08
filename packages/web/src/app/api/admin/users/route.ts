// GET /api/admin/users?q= (INNOBOX_SPEC.md §3): platform-admin directory search that includes
// inactive/scrubbed users — the picker behind the GDPR "Delete user info" action. Distinct
// from /api/users (the active-only assignment picker any signed-in user may call).
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { searchUsersForAdmin } from "../../users/store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < 2) return Response.json({ users: [] });
  const users = await searchUsersForAdmin(pool, q);
  return Response.json({ users });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/users", handleGET);
