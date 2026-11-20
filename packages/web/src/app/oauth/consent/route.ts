// POST /oauth/consent (INNOBOX_SPEC.md §25.3): the consent form's Approve / Deny, answered with the
// forwarding page that sends the browser on to the client's redirect URI — 200, never a redirect
// (lib/mcp/consent.ts says why). Session required, and the §2.4 Origin check applies — in the
// middleware AND again here (this route is not mounted through the §14.7 wrapper that re-checks it
// for every /api route, so it carries the second check itself). What the handler reads from the
// form, the single-use pending row and the approve/deny outcomes live in answerConsent().
import { publicBaseUrl } from "@innobox/shared/public-url";
import { getSessionUser } from "@/lib/auth";
import { isRequestOriginAllowed } from "@/lib/csrf";
import { pool } from "@/lib/db";
import { readBytesLimited, JSON_BODY_MAX_BYTES } from "@/lib/http";
import { answerConsent } from "@/lib/mcp/consent";
import { htmlResponse, renderErrorPage } from "@/lib/mcp/consent-page";
import { recordMcpEvent, settingsOr503 } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  // §2.4: the Origin check, independent of the middleware's (same rule, same 403).
  if (!isRequestOriginAllowed(req, process.env)) return Response.json({ error: "forbidden" }, { status: 403 });
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const user = await getSessionUser();
  if (!user) return htmlResponse(renderErrorPage("Your session has ended. Sign in and start the connection again."), 401);

  const bytes = await readBytesLimited(req, JSON_BODY_MAX_BYTES);
  if (!bytes.ok) return bytes.response;
  const answer = await answerConsent(pool, user.id, new URLSearchParams(new TextDecoder().decode(bytes.value)), publicBaseUrl());
  if (answer.blockedClientName !== null) {
    recordMcpEvent({
      status: 403,
      route: "/oauth/consent",
      errorCode: "mcp_client_blocked",
      message: `blocked client "${answer.blockedClientName}" asked for a new grant`,
      userId: user.id,
    });
  }
  return answer.response;
}
