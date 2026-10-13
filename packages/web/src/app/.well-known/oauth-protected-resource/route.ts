// GET /.well-known/oauth-protected-resource (INNOBOX_SPEC.md §25.2): RFC 9728 metadata for the MCP
// resource `<PUBLIC_BASE_URL>/mcp` — the document a 401 from /mcp points to. No credential, and it
// reads nothing but the on/off switch (invariant 2). 503 while agent access is off.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { protectedResourceMetadata } from "@/lib/mcp/oauth";
import { settingsOr503 } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  return Response.json(protectedResourceMetadata(publicBaseUrl()), { headers: { "Access-Control-Allow-Origin": "*" } });
}
