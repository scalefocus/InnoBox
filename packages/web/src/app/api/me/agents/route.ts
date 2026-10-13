// GET /api/me/agents (INNOBOX_SPEC.md §25.9): the AI agents page — the server URL, whether agent
// access is on, whether restricted content is shared, and the caller's live connections. Any
// authenticated user; while access is off the connections are still listed so they can be revoked.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { mcpResource } from "@/lib/mcp/oauth";
import { getMcpSettings, listConnections } from "@/lib/mcp/store";
import { withSystemLog } from "@/lib/system-log";

export const dynamic = "force-dynamic";

async function handleGET(): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const [settings, connections] = await Promise.all([getMcpSettings(pool), listConnections(pool, gate.user.id)]);
  const base = publicBaseUrl();
  return Response.json({
    enabled: settings.enabled,
    serverUrl: base ? mcpResource(base) : "",
    restrictedShared: settings.restrictedContentEnabled,
    connections,
  });
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/me/agents", handleGET);
