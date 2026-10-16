// POST /oauth/token (INNOBOX_SPEC.md §25.3): the authorization-code exchange (PKCE) and refresh-token
// rotation, for public clients. No session and no Origin check (called by programs); 60 requests per
// IP per minute. A refresh token presented again after rotation, or an authorization code presented
// a second time, revokes the whole grant and writes the `mcp_refresh_reuse_detected` /
// `mcp_code_reuse_detected` system-log row; a blocked client is refused and logged as
// `mcp_client_blocked` (§25.11). Token issue and rotation are metrics, not audit rows. Nothing
// here ever logs a code, verifier or token.
import { pool } from "@/lib/db";
import { ipLimited, NO_STORE, oauthError, readParams, recordMcpEvent, settingsOr503 } from "@/lib/mcp/http";
import { countTokenEvent } from "@/lib/mcp/metrics";
import { exchangeCode, findClient, refreshTokens, type TokenResult } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

const ROUTE = "/oauth/token";
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 2048 ? v : null);

export async function POST(req: Request): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const limited = ipLimited(req, "mcp-ip");
  if (limited) return limited;
  const read = await readParams(req);
  if (!read.ok) return read.response;
  const p = read.params;

  const client = await findClient(pool, text(p.client_id));
  if (!client) return oauthError(401, "invalid_client", "unknown client_id");

  let result: TokenResult;
  if (p.grant_type === "authorization_code") {
    const code = text(p.code);
    if (!code) return oauthError(400, "invalid_request", "code is required");
    result = await exchangeCode(
      pool,
      { code, codeVerifier: p.code_verifier, clientId: client.clientId, redirectUri: text(p.redirect_uri), resource: text(p.resource) },
      gate.settings,
    );
  } else if (p.grant_type === "refresh_token") {
    const refreshToken = text(p.refresh_token);
    if (!refreshToken) return oauthError(400, "invalid_request", "refresh_token is required");
    result = await refreshTokens(pool, { refreshToken, clientId: client.clientId, resource: text(p.resource) }, gate.settings);
  } else {
    return oauthError(400, "unsupported_grant_type");
  }

  switch (result.status) {
    case "ok":
      countTokenEvent(result.rotated ? "refreshed" : "issued");
      return Response.json(result.tokens, { headers: NO_STORE });
    case "blocked":
      recordMcpEvent({ status: 400, route: ROUTE, errorCode: "mcp_client_blocked", message: `blocked client "${result.clientName}" asked for a token`, userId: result.userId });
      return oauthError(400, "unauthorized_client", "this application has been blocked by an administrator");
    case "reuse":
      countTokenEvent("reuse");
      countTokenEvent("revoked");
      recordMcpEvent({
        status: 400,
        route: ROUTE,
        errorCode: result.of === "code" ? "mcp_code_reuse_detected" : "mcp_refresh_reuse_detected",
        message:
          result.of === "code"
            ? `an already-exchanged authorization code of client "${result.clientName}" was presented again; the connection was revoked`
            : `a rotated refresh token of client "${result.clientName}" was presented again; the connection was revoked`,
        userId: result.userId,
      });
      return oauthError(400, "invalid_grant");
    case "invalid_client":
      return oauthError(401, "invalid_client");
    case "invalid_grant":
      return oauthError(400, "invalid_grant");
  }
}
