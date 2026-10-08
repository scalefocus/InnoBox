// GET /api/admin/triage/attention (INNOBOX_SPEC.md §14.4): the "unseen actionable items" count
// behind the Triage/Administration nav bubble. Admin-only (namespace admins → their namespaces,
// platform admins → everywhere); polled by the app shell on the notification-bell cadence.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, countTriageAttention } from "../store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const viewer = { userId: gate.user.id, roles: gate.user.roles };
  const adminNs = adminNamespaceIds(viewer.roles);
  if (adminNs !== "all" && adminNs.length === 0) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const count = await countTriageAttention(pool, viewer);
  return Response.json({ count });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/triage/attention", handleGET);
