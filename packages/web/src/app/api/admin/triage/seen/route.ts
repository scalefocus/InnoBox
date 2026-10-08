// POST /api/admin/triage/seen (INNOBOX_SPEC.md §14.4): the triage-queue page calls this on open,
// stamping the actor's triage_seen_at = now() so the attention bubble clears until a newer
// actionable item arrives. Admin-only, mirroring the queue's RBAC.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, markTriageSeen } from "../store";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handlePOST(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;

  const adminNs = adminNamespaceIds(gate.user.roles);
  if (adminNs !== "all" && adminNs.length === 0) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  await markTriageSeen(pool, gate.user.id);
  return Response.json({ ok: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/triage/seen", handlePOST);
