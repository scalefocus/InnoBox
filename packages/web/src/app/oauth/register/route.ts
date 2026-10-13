// POST /oauth/register (INNOBOX_SPEC.md §25.3): RFC 7591 open dynamic client registration. Any MCP
// client may register and receives a client_id; registration alone grants nothing — a person still
// signs in and consents. Public clients only, exact redirect URIs of the accepted shapes, 10
// registrations per IP per hour; a client never granted within 7 days is swept by the worker.
// No credential, no session, no Origin check (called by programs). Not audited — a metric.
import { MCP_SCOPE } from "@innobox/shared/mcp";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { clientIp, ipLimited, NO_STORE, oauthError, settingsOr503 } from "@/lib/mcp/http";
import { countRegistration } from "@/lib/mcp/metrics";
import { parseRegistration } from "@/lib/mcp/oauth";
import { registerClient } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const limited = ipLimited(req, "mcp-register");
  if (limited) return limited;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const parsed = parseRegistration(read.value);
  if (!parsed.ok) return oauthError(400, parsed.error, parsed.description);

  const client = await registerClient(pool, parsed.value, clientIp(req));
  countRegistration();
  return Response.json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: MCP_SCOPE,
      ...(parsed.value.clientUri ? { client_uri: parsed.value.clientUri } : {}),
      ...(parsed.value.softwareId ? { software_id: parsed.value.softwareId } : {}),
      ...(parsed.value.softwareVersion ? { software_version: parsed.value.softwareVersion } : {}),
    },
    { status: 201, headers: NO_STORE },
  );
}
