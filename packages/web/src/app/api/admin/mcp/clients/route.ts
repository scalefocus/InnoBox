// GET /api/admin/mcp/clients (INNOBOX_SPEC.md §25.10): the registered AI agent clients — name,
// registration date, last used, live connections and blocked state. Platform admin only.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { listAdminClients } from "@/lib/mcp/store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json({ clients: await listAdminClients(pool) });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/mcp/clients", handleGET);
