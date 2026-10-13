// GET /api/admin/public-submissions?status=pending|decided (INNOBOX_SPEC.md §24.5, §24.9): the
// review queue — pending review (oldest first, the default) or decided in the last 90 days (newest
// first). Platform admin only (403 for namespace admins, like every platform-only admin route).
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { listPublicSubmissions } from "./store";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  if (status !== "pending" && status !== "decided") return Response.json({ error: "status must be pending or decided" }, { status: 400 });
  return Response.json({ submissions: await listPublicSubmissions(pool, status) });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/public-submissions", handleGET);
