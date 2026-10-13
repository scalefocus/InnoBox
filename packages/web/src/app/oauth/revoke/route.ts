// POST /oauth/revoke (INNOBOX_SPEC.md §25.3): RFC 7009 token revocation for public clients. An
// access token ends alone; a refresh token ends its whole grant (audited `mcp.grant_revoked`,
// reason "user" — the person, through their client, disconnected). Always 200 for a well-formed
// request, known token or not. No session and no Origin check (called by programs).
import { pool } from "@/lib/db";
import { ipLimited, NO_STORE, oauthError, readParams, settingsOr503 } from "@/lib/mcp/http";
import { countTokenEvent } from "@/lib/mcp/metrics";
import { revokeToken } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const limited = ipLimited(req, "mcp-ip");
  if (limited) return limited;
  const read = await readParams(req);
  if (!read.ok) return read.response;
  const token = typeof read.params.token === "string" && read.params.token.length <= 2048 ? read.params.token : null;
  if (!token) return oauthError(400, "invalid_request", "token is required");
  const clientId = typeof read.params.client_id === "string" ? read.params.client_id : null;
  if ((await revokeToken(pool, token, clientId)) !== "none") countTokenEvent("revoked");
  return new Response(null, { status: 200, headers: NO_STORE });
}
