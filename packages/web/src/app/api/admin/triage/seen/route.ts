// POST /api/admin/triage/seen (INNOBOX_SPEC.md §14.4): the triage-queue page calls this on open,
// stamping the actor's triage_seen_at = now() so the attention bubble clears until a newer
// actionable item arrives. Admin-only, mirroring the queue's RBAC.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { adminNamespaceIds, markTriageSeen } from "../store";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const adminNs = adminNamespaceIds(gate.user.roles);
  if (adminNs !== "all" && adminNs.length === 0) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  await markTriageSeen(pool, gate.user.id);
  return Response.json({ ok: true });
}
