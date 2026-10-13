// DELETE /api/me/agents/:grantId (INNOBOX_SPEC.md §25.9): the person revokes one of their own AI
// agent connections — immediate, ends the grant and every token under it, audited
// `mcp.grant_revoked` (reason "user"). Works while agent access is off. Someone else's grant, or one
// already revoked, is a 404 like a missing one.
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { revokeOwnGrant } from "@/lib/mcp/store";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleDELETE(_req: Request, context: { params: Promise<{ grantId: string }> }): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const { grantId } = await context.params;
  if (!(await revokeOwnGrant(pool, gate.user.id, grantId))) return Response.json({ error: "connection not found" }, { status: 404 });
  return Response.json({ ok: true });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const DELETE = withSystemLog("/api/me/agents/[grantId]", handleDELETE);
