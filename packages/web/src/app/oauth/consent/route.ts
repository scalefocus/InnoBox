// POST /oauth/consent (INNOBOX_SPEC.md §25.3): the consent form's Approve / Deny, answered with a
// 303 to the client's redirect URI. Session required, and the §2.4 Origin check applies — in the
// middleware AND again here (this route is not mounted through the §14.7 wrapper that re-checks it
// for every /api route, so it carries the second check itself). The handler reads ONLY the pending-authorization id, the choice and the "I started
// this connection from my own AI tool" confirmation from the form; everything else comes from the
// pending row, which is consumed in the same statement that reads it — single use, 10 minutes,
// bound to the person — so anything else fails closed with 400 and a double submit cannot mint two
// codes. An approve without the confirmation is refused with 400 BEFORE the pending row is
// consumed: the form itself is incomplete, nothing has been read from the row, and the person can
// go back, tick the box and submit the same consent (the row stays single-use either way — the
// first submit that reaches the consume statement wins). Approve writes or refreshes the grant and
// mints the code.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { getSessionUser } from "@/lib/auth";
import { isRequestOriginAllowed } from "@/lib/csrf";
import { pool } from "@/lib/db";
import { readBytesLimited, JSON_BODY_MAX_BYTES } from "@/lib/http";
import { htmlResponse, renderErrorPage } from "@/lib/mcp/consent-page";
import { recordMcpEvent, settingsOr503 } from "@/lib/mcp/http";
import { parseConsentForm, redirectWith } from "@/lib/mcp/oauth";
import { approveAuthorization, consumePendingAuthorization, findClientById } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "cache-control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  // §2.4: the Origin check, independent of the middleware's (same rule, same 403).
  if (!isRequestOriginAllowed(req, process.env)) return Response.json({ error: "forbidden" }, { status: 403 });
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const user = await getSessionUser();
  if (!user) return htmlResponse(renderErrorPage("Your session has ended. Sign in and start the connection again."), 401);

  const bytes = await readBytesLimited(req, JSON_BODY_MAX_BYTES);
  if (!bytes.ok) return bytes.response;
  const form = parseConsentForm(new URLSearchParams(new TextDecoder().decode(bytes.value)));
  if (!form.ok) return htmlResponse(renderErrorPage(form.message), 400);

  const pending = await consumePendingAuthorization(pool, form.requestId, user.id);
  if (!pending) return htmlResponse(renderErrorPage("This approval has expired or was already used."), 400);
  const { request } = pending;
  const iss = publicBaseUrl();

  if (form.decision === "deny") return seeOther(redirectWith(request.redirectUri, { error: "access_denied", state: request.state, iss }));

  const client = await findClientById(pool, pending.clientRowId);
  const approved = client && !client.blocked ? await approveAuthorization(pool, user.id, pending.clientRowId, request) : ({ status: "blocked" } as const);
  if (approved.status === "blocked") {
    recordMcpEvent({
      status: 403,
      route: "/oauth/consent",
      errorCode: "mcp_client_blocked",
      message: `blocked client "${client?.clientName ?? "unknown"}" asked for a new grant`,
      userId: user.id,
    });
    return htmlResponse(renderErrorPage("An administrator has blocked this application."), 403);
  }
  return seeOther(redirectWith(request.redirectUri, { code: approved.code, state: request.state, iss }));
}
