// GET /api/admin/presence?window=5m|1h|8h|24h|30d (INNOBOX_SPEC.md §14.5): the rolling
// DAU/WAU/MAU tiles plus the capped, most-recent-first list of users active in the window.
// PLATFORM ADMIN ONLY — namespace admins get 403; there is no non-admin presence surface.
//
// Audited. Reads are normally unaudited in InnoBox (cf. §13.8's hover card), and this is the
// deliberate exception: "an admin looked at who is online" is precisely the access a DPO
// asks about. With the panel's auto-refresh off (§14.5) it is one row per deliberate load.
import { requirePlatformAdmin } from "@/lib/auth";
import { appendAudit } from "@/lib/audit";
import { pool } from "@/lib/db";
import { parsePresenceWindow } from "@/lib/presence";
import { presenceSummary } from "./store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const window = parsePresenceWindow(new URL(req.url).searchParams.get("window"));
  const summary = await presenceSummary(pool, window);

  await appendAudit(pool, {
    actorUserId: gate.user.id,
    action: "presence.view",
    targetType: "presence",
    after: { window, listed: summary.users.length, total: summary.total },
  });

  return Response.json(summary);
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/presence", handleGET);
