// GET /api/admin/email/connect (INNOBOX_SPEC.md §12.1): starts the delegated Graph consent
// flow (Mail.Send + offline_access, PKCE) for the notification service mailbox. Redirects
// to Entra's authorize endpoint; state + PKCE verifier ride in short-lived httpOnly cookies
// bound to this browser, consumed by the callback.
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { buildAuthorizeUrl, createPkcePair } from "@innobox/shared/email";
import { requirePlatformAdmin } from "@/lib/auth";
import { EMAIL_OAUTH_STATE_COOKIE, EMAIL_OAUTH_VERIFIER_COOKIE, webBaseUrl, webGraphMailEnv } from "@/lib/email";

export async function GET(): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const env = webGraphMailEnv();
  if (!env) {
    return Response.json(
      { error: "Graph credentials are not configured (ENTRA_TENANT_ID / ENTRA_EMAIL_CLIENT_ID / ENTRA_EMAIL_CLIENT_SECRET / EMAIL_TOKEN_ENC_KEY)" },
      { status: 400 },
    );
  }

  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = createPkcePair();
  const redirectUri = `${webBaseUrl()}/api/admin/email/callback`;
  const authorizeUrl = buildAuthorizeUrl(env, { redirectUri, state, codeChallenge: challenge });

  const res = NextResponse.redirect(authorizeUrl);
  const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax" as const, maxAge: 600, path: "/" };
  res.cookies.set(EMAIL_OAUTH_STATE_COOKIE, state, cookieOpts);
  res.cookies.set(EMAIL_OAUTH_VERIFIER_COOKIE, verifier, cookieOpts);
  return res;
}
