// GET /oauth/authorize (INNOBOX_SPEC.md §25.3): validates the authorization request, then shows the
// consent page — outside AppShell, no script. Needs a session: the middleware sends a signed-out
// visitor through the Entra sign-in and back here. A parameter supplied twice is refused BEFORE
// client_id or redirect_uri is read, with the non-redirecting error page, as are an unknown client
// and an unregistered redirect URI; every other problem goes back to the client's redirect URI.
// The validated request is stored in oauth_pending_authorizations and the form carries only that
// row's id. This page's CSP widens form-action to the client redirect shapes (the middleware).
import { publicBaseUrl } from "@innobox/shared/public-url";
import { getSessionUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { htmlResponse, renderConsentPage, renderErrorPage } from "@/lib/mcp/consent-page";
import { recordMcpEvent, settingsOr503 } from "@/lib/mcp/http";
import { checkAuthorizeRequest, duplicateParameter, mcpResource, redirectWith } from "@/lib/mcp/oauth";
import { createPendingAuthorization, findClient } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const params = url.searchParams;

  const user = await getSessionUser();
  if (!user) {
    const home = new URL("/", publicBaseUrl() || url.origin);
    home.searchParams.set("callbackUrl", url.pathname + url.search);
    return Response.redirect(home.toString(), 302);
  }

  const duplicate = duplicateParameter(params);
  if (duplicate) return htmlResponse(renderErrorPage(`The request names "${duplicate}" more than once.`), 400);

  const client = await findClient(pool, params.get("client_id"));
  if (client?.blocked) {
    recordMcpEvent({
      status: 403,
      method: "GET",
      route: "/oauth/authorize",
      errorCode: "mcp_client_blocked",
      message: `blocked client "${client.clientName}" asked for a new grant`,
      userId: user.id,
    });
    return htmlResponse(renderErrorPage("An administrator has blocked this application."), 403);
  }
  const base = publicBaseUrl();
  const check = checkAuthorizeRequest(params, client, mcpResource(base));
  if (!check.ok) {
    if (!check.redirect) return htmlResponse(renderErrorPage(check.message), 400);
    return new Response(null, {
      status: 303,
      headers: {
        Location: redirectWith(check.redirectUri, { error: check.error, error_description: check.description, state: check.state, iss: base }),
        "cache-control": "no-store",
      },
    });
  }

  const requestId = await createPendingAuthorization(pool, user.id, client!.id, check.value);
  const target = new URL(check.value.redirectUri);
  return htmlResponse(
    renderConsentPage({
      clientName: client!.clientName,
      redirectTarget: target.protocol === "http:" || target.protocol === "https:" ? target.host : target.protocol,
      personName: user.displayName,
      requestId,
      restrictedShared: gate.settings.restrictedContentEnabled,
    }),
  );
}
