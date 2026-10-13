// POST /oauth/consent (INNOBOX_SPEC.md §25.3): the consent form's Approve / Deny, answered with a
// 303 to the client's redirect URI. Session required, and the §2.4 Origin check applies (the
// middleware). The handler reads ONLY the pending-authorization id and the choice from the form;
// everything else comes from that row, which is consumed in the same statement that reads it —
// single use, 10 minutes, bound to the person — so anything else fails closed with 400 and a double
// submit cannot mint two codes. Approve writes or refreshes the grant and mints the code.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { getSessionUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readBytesLimited, JSON_BODY_MAX_BYTES } from "@/lib/http";
import { htmlResponse, renderErrorPage } from "@/lib/mcp/consent-page";
import { recordMcpEvent, settingsOr503 } from "@/lib/mcp/http";
import { redirectWith } from "@/lib/mcp/oauth";
import { approveAuthorization, consumePendingAuthorization, findClientById } from "@/lib/mcp/store";

export const dynamic = "force-dynamic";

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "cache-control": "no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const user = await getSessionUser();
  if (!user) return htmlResponse(renderErrorPage("Your session has ended. Sign in and start the connection again."), 401);

  const bytes = await readBytesLimited(req, JSON_BODY_MAX_BYTES);
  if (!bytes.ok) return bytes.response;
  const form = new URLSearchParams(new TextDecoder().decode(bytes.value));
  const decision = form.get("decision");
  if (decision !== "approve" && decision !== "deny") return htmlResponse(renderErrorPage("The form was incomplete."), 400);

  const pending = await consumePendingAuthorization(pool, form.get("request_id") ?? "", user.id);
  if (!pending) return htmlResponse(renderErrorPage("This approval has expired or was already used."), 400);
  const { request } = pending;
  const iss = publicBaseUrl();

  if (decision === "deny") return seeOther(redirectWith(request.redirectUri, { error: "access_denied", state: request.state, iss }));

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
