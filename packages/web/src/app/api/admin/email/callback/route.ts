// GET /api/admin/email/callback (INNOBOX_SPEC.md §12.1): the Entra redirect target. Verifies
// state, exchanges the code (PKCE), decodes the service account's identity, and stores the
// encrypted tokens (replacing any previously connected account). Always redirects back to
// the settings page with a query flag — this endpoint has no UI of its own.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeAuthCode, parseIdTokenClaims } from "@innobox/shared/email";
import { requirePlatformAdmin } from "@/lib/auth";
import { EMAIL_OAUTH_STATE_COOKIE, EMAIL_OAUTH_VERIFIER_COOKIE, finishConnect, webBaseUrl, webGraphMailEnv } from "@/lib/email";
import { validateCallbackParams } from "../validation";

export async function GET(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const settingsUrl = (query: string) => `${webBaseUrl()}/admin/settings?${query}`;
  const clearOauthCookies = (res: NextResponse): NextResponse => {
    res.cookies.set(EMAIL_OAUTH_STATE_COOKIE, "", { maxAge: 0, path: "/" });
    res.cookies.set(EMAIL_OAUTH_VERIFIER_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };

  const cookieStore = await cookies();
  const validated = validateCallbackParams({
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    errorParam: url.searchParams.get("error"),
    expectedState: cookieStore.get(EMAIL_OAUTH_STATE_COOKIE)?.value,
    verifier: cookieStore.get(EMAIL_OAUTH_VERIFIER_COOKIE)?.value,
  });
  if (!validated.ok) return clearOauthCookies(NextResponse.redirect(settingsUrl(`emailError=${encodeURIComponent(validated.errorCode)}`)));

  const env = webGraphMailEnv();
  if (!env) return clearOauthCookies(NextResponse.redirect(settingsUrl("emailError=not_configured")));

  try {
    const tokens = await exchangeAuthCode(env, {
      code: validated.code,
      redirectUri: `${webBaseUrl()}/api/admin/email/callback`,
      codeVerifier: validated.verifier,
    });
    const claims = parseIdTokenClaims(tokens.idToken);
    await finishConnect(env, { claims, tokens, actorUserId: gate.user.id });
  } catch (err) {
    // The raw exception (Graph HTTP details, malformed id_token, etc.) is logged server-side
    // only — the redirect carries a generic code so internal error text never lands in the
    // browser's address bar or history.
    console.error(JSON.stringify({ level: "error", msg: "email service account connect failed", error: String((err as Error).message ?? err) }));
    return clearOauthCookies(NextResponse.redirect(settingsUrl("emailError=connect_failed")));
  }

  return clearOauthCookies(NextResponse.redirect(settingsUrl("emailConnected=1")));
}
