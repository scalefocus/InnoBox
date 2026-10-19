// Pins the pure rules of the agent-access OAuth server (INNOBOX_SPEC.md §25.3): PKCE S256, redirect
// URI shapes and matching (loopback on any port incl. localhost, exact https, custom schemes, no
// wildcards), duplicate-parameter rejection before the client is read, registration validation,
// the authorization-request check, the consent page's widened form-action, and the metadata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authorizationServerMetadata,
  bearerChallenge,
  checkAuthorizeRequest,
  classifyRedirectUri,
  consentFormActionSources,
  duplicateParameter,
  hashToken,
  matchRedirectUri,
  mcpResource,
  mintToken,
  parseConsentForm,
  parseRegistration,
  protectedResourceMetadata,
  redirectWith,
  verifyPkceS256,
} from "./oauth";

const BASE = "https://innobox.example.com";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

test("PKCE: S256 only, constant shape, verifier must match", () => {
  assert.equal(CHALLENGE, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"); // RFC 7636 appendix B
  assert.equal(verifyPkceS256(VERIFIER, CHALLENGE), true);
  assert.equal(verifyPkceS256(`${VERIFIER}x`, CHALLENGE), false);
  assert.equal(verifyPkceS256("short", CHALLENGE), false, "a verifier under 43 characters is malformed");
  assert.equal(verifyPkceS256(VERIFIER, VERIFIER), false, "plain is not accepted");
  assert.equal(verifyPkceS256(undefined, CHALLENGE), false);
});

test("tokens: opaque, random, stored only as a SHA-256 hash", () => {
  const a = mintToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, mintToken());
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.notEqual(hashToken(a), a);
});

test("redirect URIs: loopback http, https, custom schemes; nothing else", () => {
  assert.equal(classifyRedirectUri("http://127.0.0.1:33418/callback"), "loopback");
  assert.equal(classifyRedirectUri("http://[::1]:8080/cb"), "loopback");
  assert.equal(classifyRedirectUri("http://localhost:6274/oauth/callback"), "loopback");
  assert.equal(classifyRedirectUri("https://claude.ai/api/mcp/auth_callback"), "https");
  assert.equal(classifyRedirectUri("cursor://anysphere.cursor-retrieval/oauth/callback"), "custom");
  assert.equal(classifyRedirectUri("com.example.app:/oauth"), "custom");
  for (const bad of [
    "http://example.com/cb",
    "http://192.168.1.5:8080/cb",
    "https://*.example.com/cb",
    "https://example.com/cb#frag",
    "https://user:pw@example.com/cb",
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "not a uri",
    "",
  ]) {
    assert.equal(classifyRedirectUri(bad), null, bad);
  }
});

test("redirect matching: exact, except loopback on any port", () => {
  const registered = ["http://127.0.0.1:1234/callback", "http://localhost:5555/cb", "https://app.example.com/cb", "myapp:/done"];
  assert.equal(matchRedirectUri(registered, "http://127.0.0.1:9999/callback"), "http://127.0.0.1:9999/callback");
  assert.equal(matchRedirectUri(registered, "http://localhost:40000/cb"), "http://localhost:40000/cb");
  assert.equal(matchRedirectUri(registered, "http://127.0.0.1:9999/other"), null, "path must match");
  assert.equal(matchRedirectUri(registered, "http://localhost:9999/callback"), null, "host must match (no localhost↔127.0.0.1 swap)");
  assert.equal(matchRedirectUri(registered, "http://127.0.0.1:9999/callback?x=1"), null, "query must match");
  assert.equal(matchRedirectUri(registered, "https://app.example.com/cb"), "https://app.example.com/cb");
  assert.equal(matchRedirectUri(registered, "https://app.example.com:8443/cb"), null, "https is exact (no port wildcard)");
  assert.equal(matchRedirectUri(registered, "https://app.example.com/cb/"), null);
  assert.equal(matchRedirectUri(registered, "myapp:/done"), "myapp:/done");
  assert.equal(matchRedirectUri(registered, "myapp:/other"), null);
  assert.equal(matchRedirectUri(registered, undefined), null);
});

test("duplicate parameters are found before anything else is read", () => {
  assert.equal(duplicateParameter(new URLSearchParams("a=1&b=2")), null);
  assert.equal(duplicateParameter(new URLSearchParams("redirect_uri=x&client_id=c&redirect_uri=y")), "redirect_uri");
  const check = checkAuthorizeRequest(new URLSearchParams("client_id=c&redirect_uri=a&redirect_uri=b"), { redirectUris: ["a"] }, mcpResource(BASE));
  assert.equal(check.ok, false);
  assert.equal(check.ok === false && check.redirect, false, "a duplicated redirect_uri is never redirected to");
});

test("authorize request: non-redirecting vs redirected errors, and the happy path", () => {
  const client = { redirectUris: ["http://127.0.0.1:1/cb"] };
  const resource = mcpResource(BASE);
  const params = (extra: Record<string, string> = {}, drop: string[] = []) => {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: "c",
      redirect_uri: "http://127.0.0.1:5000/cb",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "s1",
      resource,
      ...extra,
    });
    for (const d of drop) p.delete(d);
    return p;
  };
  const ok = checkAuthorizeRequest(params(), client, resource);
  assert.deepEqual(ok, { ok: true, value: { redirectUri: "http://127.0.0.1:5000/cb", codeChallenge: CHALLENGE, state: "s1", resource } });

  const unknown = checkAuthorizeRequest(params(), null, resource);
  assert.equal(unknown.ok === false && unknown.redirect, false);
  const wrongRedirect = checkAuthorizeRequest(params({ redirect_uri: "https://evil.example/cb" }), client, resource);
  assert.equal(wrongRedirect.ok === false && wrongRedirect.redirect, false);

  const expectRedirected = (p: URLSearchParams, error: string) => {
    const r = checkAuthorizeRequest(p, client, resource);
    assert.ok(r.ok === false && r.redirect, error);
    if (r.ok === false && r.redirect) {
      assert.equal(r.error, error);
      assert.equal(r.state, "s1");
    }
  };
  expectRedirected(params({ code_challenge_method: "plain" }), "invalid_request");
  expectRedirected(params({}, ["code_challenge"]), "invalid_request");
  expectRedirected(params({ response_type: "token" }), "unsupported_response_type");
  expectRedirected(params({ scope: "admin" }), "invalid_scope");
  expectRedirected(params({ resource: `${BASE}/api` }), "invalid_target");
  expectRedirected(params({}, ["resource"]), "invalid_target");
});

test("registration: public clients, exact redirect shapes, a 1–80 character name", () => {
  const ok = parseRegistration({ client_name: "Claude Code", redirect_uris: ["http://localhost:1234/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
  assert.equal(ok.ok, true);
  assert.equal(parseRegistration({ client_name: "x", redirect_uris: [] }).ok, false);
  assert.equal(parseRegistration({ client_name: "x", redirect_uris: ["https://a.example/*"] }).ok, false);
  assert.equal(parseRegistration({ redirect_uris: ["https://a.example/cb"] }).ok, false, "client_name is required");
  assert.equal(parseRegistration({ client_name: "x".repeat(81), redirect_uris: ["https://a.example/cb"] }).ok, false);
  assert.equal(parseRegistration({ client_name: "bad\u0007", redirect_uris: ["https://a.example/cb"] }).ok, false);
  assert.equal(parseRegistration({ client_name: "x", redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }).ok, false);
  assert.equal(parseRegistration({ client_name: "x", redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] }).ok, false);
  assert.equal(parseRegistration({ client_name: "x", redirect_uris: ["https://a.example/cb"], grant_types: ["password", "authorization_code"] }).ok, false);
  const bad = parseRegistration({ client_name: "x", redirect_uris: ["http://intranet.example/cb"] });
  assert.equal(bad.ok === false && bad.error, "invalid_redirect_uri");
});

test("registration: client_uri and logo_uri must be https URLs without credentials, or absent", () => {
  const reg = (extra: Record<string, unknown>) => parseRegistration({ client_name: "x", redirect_uris: ["https://a.example/cb"], ...extra });
  const ok = reg({ client_uri: "https://agent.example/about", logo_uri: "https://cdn.example/logo.png" });
  assert.ok(ok.ok && ok.value.clientUri === "https://agent.example/about" && ok.value.logoUri === "https://cdn.example/logo.png");
  const absent = reg({ client_uri: null });
  assert.ok(absent.ok && absent.value.clientUri === null && absent.value.logoUri === null);
  for (const bad of ["javascript:alert(1)", "http://agent.example/about", "https://user:pw@agent.example/", "data:text/html,x", "not a url", "https://", `https://a.example/${"x".repeat(2048)}`, 42]) {
    const r = reg({ client_uri: bad });
    assert.ok(r.ok === false && r.error === "invalid_client_metadata", `client_uri ${String(bad).slice(0, 40)}`);
    const l = reg({ logo_uri: bad });
    assert.ok(l.ok === false && l.error === "invalid_client_metadata", `logo_uri ${String(bad).slice(0, 40)}`);
  }
});

test("consent form: approve needs the confirmation tick, deny does not, malformed is refused", () => {
  assert.deepEqual(parseConsentForm(new URLSearchParams("request_id=r1&decision=approve&confirm=1")), { ok: true, decision: "approve", requestId: "r1" });
  assert.deepEqual(parseConsentForm(new URLSearchParams("request_id=r1&decision=deny")), { ok: true, decision: "deny", requestId: "r1" });
  assert.equal(parseConsentForm(new URLSearchParams("request_id=r1&decision=approve")).ok, false, "approve without the tick is refused");
  assert.equal(parseConsentForm(new URLSearchParams("request_id=r1&decision=approve&confirm=on")).ok, false, "only confirm=1 counts");
  assert.equal(parseConsentForm(new URLSearchParams("request_id=r1&decision=maybe&confirm=1")).ok, false);
  assert.equal(parseConsentForm(new URLSearchParams("")).ok, false);
  const refused = parseConsentForm(new URLSearchParams("decision=approve"));
  assert.ok(refused.ok === false && !refused.message.includes("§"));
});

test("consent page CSP: loopback shapes and https always; a custom scheme only when used", () => {
  assert.deepEqual(consentFormActionSources(null), ["http://127.0.0.1:*", "http://localhost:*", "https:"]);
  assert.deepEqual(consentFormActionSources("myapp:/done"), ["http://127.0.0.1:*", "http://localhost:*", "https:", "myapp:"]);
  assert.ok(consentFormActionSources("http://[::1]:5/cb").includes("http://[::1]:*"));
  assert.deepEqual(consentFormActionSources("javascript:alert(1)"), ["http://127.0.0.1:*", "http://localhost:*", "https:"]);
});

test("metadata, challenge header and redirect builder", () => {
  assert.equal(protectedResourceMetadata(BASE).resource, `${BASE}/mcp`);
  assert.deepEqual(protectedResourceMetadata(BASE).authorization_servers, [BASE]);
  const as = authorizationServerMetadata(BASE);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.equal(bearerChallenge(BASE), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`);
  assert.equal(redirectWith("http://127.0.0.1:5/cb?x=1", { code: "c", state: null }), "http://127.0.0.1:5/cb?x=1&code=c");
});
