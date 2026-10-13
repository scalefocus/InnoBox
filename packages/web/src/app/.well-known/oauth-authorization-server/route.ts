// GET /.well-known/oauth-authorization-server (INNOBOX_SPEC.md §25.2): RFC 8414 metadata — InnoBox
// is its own OAuth 2.1 authorization server for agent access (PKCE S256, open dynamic registration,
// public clients). No credential; reads nothing but the on/off switch. 503 while off.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { authorizationServerMetadata } from "@/lib/mcp/oauth";
import { settingsOr503 } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  return Response.json(authorizationServerMetadata(publicBaseUrl()), { headers: { "Access-Control-Allow-Origin": "*" } });
}
