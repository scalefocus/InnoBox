// POST /oauth/consent without its session layer (INNOBOX_SPEC.md §25.3): what the handler does once
// it knows who is asking. The route keeps the §2.4 Origin check, the on/off gate, the session and
// the body read; everything after that lives here so the live-DB suite can run it.
//
// It reads ONLY the pending-authorization id, the choice and the "I started this connection from my
// own AI tool" confirmation from the form. Everything else comes from the pending row, which is
// consumed in the same statement that reads it — single use, 10 minutes, bound to the person — so
// anything else fails closed with 400 and a double submit cannot mint two codes. An approve without
// the confirmation is refused with 400 BEFORE the pending row is consumed: the form itself is
// incomplete, nothing has been read from the row, and the person can go back, tick the box and
// submit the same consent (the row stays single-use either way — the first submit that reaches the
// consume statement wins). Approve writes or refreshes the grant and mints the code.
//
// Approve and Deny are answered with the forwarding page — 200, never a redirect, never a
// `Location` header. A browser applies the page's CSP form-action to every redirect that follows a
// form submission, so a 303 to the client's origin is blocked by any policy that does not name
// that origin, after the row is consumed and the code minted. The page starts a new navigation
// instead, which no policy governs.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import { htmlResponse, renderErrorPage, renderForwardPage } from "./consent-page";
import { parseConsentForm, redirectWith } from "./oauth";
import { approveAuthorization, consumePendingAuthorization, findClientById } from "./store";

export interface ConsentAnswer {
  response: Response;
  /** Set when a blocked client was refused: the route records the §25.11 system-log event. */
  blockedClientName: string | null;
}

/** `iss` is the canonical base URL — the issuer the client checks the answer against. */
export async function answerConsent(pool: Pool, userId: string, form: URLSearchParams, iss: string): Promise<ConsentAnswer> {
  const refuse = (message: string, status: number, blockedClientName: string | null = null): ConsentAnswer => ({
    response: htmlResponse(renderErrorPage(message), status),
    blockedClientName,
  });
  const parsed = parseConsentForm(form);
  if (!parsed.ok) return refuse(parsed.message, 400);

  const pending = await consumePendingAuthorization(pool, parsed.requestId, userId);
  if (!pending) return refuse("This approval has expired or was already used.", 400);
  const { request } = pending;
  const forward = (outcome: "approved" | "denied", params: Record<string, string | null>): ConsentAnswer => ({
    response: htmlResponse(renderForwardPage({ outcome, redirectUri: request.redirectUri, target: redirectWith(request.redirectUri, params) })),
    blockedClientName: null,
  });

  if (parsed.decision === "deny") return forward("denied", { error: "access_denied", state: request.state, iss });

  const client = await findClientById(pool, pending.clientRowId);
  const approved = client && !client.blocked ? await approveAuthorization(pool, userId, pending.clientRowId, request) : ({ status: "blocked" } as const);
  if (approved.status === "blocked") return refuse("An administrator has blocked this application.", 403, client?.clientName ?? "unknown");
  return forward("approved", { code: approved.code, state: request.state, iss });
}
