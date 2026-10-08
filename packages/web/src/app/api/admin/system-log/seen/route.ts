// POST /api/admin/system-log/seen (INNOBOX_SPEC.md §14.7): the page calls this on open, stamping
// system_log_seen_at so the console card's badge clears until newer events arrive. Platform
// admin only. GET returns the current unseen count for the badge.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { withSystemLog } from "@/lib/system-log";
import { countUnseenSystemEvents, markSystemLogSeen } from "../store";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

async function handlePOST(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  await markSystemLogSeen(pool, gate.user.id);
  return Response.json({ ok: true });
}

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const count = await countUnseenSystemEvents(pool, gate.user.id);
  return Response.json({ count });
}

export const POST = withSystemLog("/api/admin/system-log/seen", handlePOST);
export const GET = withSystemLog("/api/admin/system-log/seen", handleGET);
