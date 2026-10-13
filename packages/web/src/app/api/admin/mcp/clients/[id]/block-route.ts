// The shared handler behind POST /api/admin/mcp/clients/:id/block and …/unblock (INNOBOX_SPEC.md
// §25.10). Platform admin only; an unknown client is a 404.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { setClientBlocked } from "@/lib/mcp/store";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";

export function blockRoute(blocked: boolean) {
  return withSystemLog(`/api/admin/mcp/clients/[id]/${blocked ? "block" : "unblock"}`, async (_req: Request, context: { params: Promise<{ id: string }> }) => {
    const gate = await requirePlatformAdmin();
    if (!gate.ok) return gate.response;
    const limited = rateLimit(gate.user.id, "mutation");
    if (limited) return limited;
    const { id } = await context.params;
    const client = await setClientBlocked(pool, id, blocked, gate.user.id);
    if (!client) return Response.json({ error: "client not found" }, { status: 404 });
    return Response.json({ client });
  });
}
