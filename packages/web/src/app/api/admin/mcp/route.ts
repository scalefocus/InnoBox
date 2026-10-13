// GET/PATCH /api/admin/mcp (INNOBOX_SPEC.md §25.10): the AI agents (MCP) card — the two switches,
// the two token lifetimes (validated server-side), the read-only server URL and the counts of live
// connections and registered clients. Platform admin only (403 for everyone else, namespace admins
// included). Every change is audited `settings.mcp_changed` with all four settings. Off means
// dormant: nothing is revoked, and switching back on resumes every connection.
import { parseMcpSettingsPatch } from "@innobox/shared/mcp";
import { publicBaseUrl } from "@innobox/shared/public-url";
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { mcpResource } from "@/lib/mcp/oauth";
import { getMcpSettings, mcpCounts, setMcpSettings } from "@/lib/mcp/store";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import type { McpSettings } from "@innobox/shared";

export const dynamic = "force-dynamic";

async function payload(settings: McpSettings): Promise<Record<string, unknown>> {
  const base = publicBaseUrl();
  return { ...settings, serverUrl: base ? mcpResource(base) : "", ...(await mcpCounts(pool)) };
}

async function handleGET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  return Response.json(await payload(await getMcpSettings(pool)));
}

async function handlePATCH(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseMcpSettingsPatch(read.value);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  return Response.json(await payload(await setMcpSettings(pool, parsed.value, gate.user.id)));
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const GET = withSystemLog("/api/admin/mcp", handleGET);
export const PATCH = withSystemLog("/api/admin/mcp", handlePATCH);
