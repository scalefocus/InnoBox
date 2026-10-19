// The pure half of InnoBox's OAuth 2.1 authorization server for agent access (INNOBOX_SPEC.md
// §25.2, §25.3): PKCE (S256 only), redirect-URI classification and matching, dynamic-client-
// registration validation, duplicate-parameter rejection, the /oauth/authorize request check,
// token minting/hashing and the two RFC metadata documents. No DB, no Next — the routes and the
// store compose these, and the unit tests drive them directly. Server-only (node:crypto); the
// edge middleware imports the redirect rules from ./redirect-uris directly.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MCP_PATH, MCP_SCOPE } from "@innobox/shared/mcp";
import { classifyRedirectUri, matchRedirectUri } from "./redirect-uris";

export { classifyRedirectUri, consentFormActionSources, matchRedirectUri, type RedirectKind } from "./redirect-uris";

// ── Tokens ───────────────────────────────────────────────────────────────────────────────

/** An opaque, unguessable token: 256 random bits, base64url. Sent to the client once; only its
 *  hash is stored (§25.3). */
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The stored form of a token: SHA-256, hex. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** §25.3 lifetimes that are not settings. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const PENDING_AUTHORIZATION_TTL_MINUTES = 10;

// ── PKCE (RFC 7636, S256 only) ───────────────────────────────────────────────────────────

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && CHALLENGE_RE.test(challenge);
}

/** True when `verifier` is well-formed and BASE64URL(SHA-256(verifier)) equals `challenge`,
 *  compared in constant time. */
export function verifyPkceS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier) || !CHALLENGE_RE.test(challenge)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url"), "ascii");
  const expected = Buffer.from(challenge, "ascii");
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

// ── Dynamic client registration (RFC 7591, §25.3) ───────────────────────────────────────

export interface ClientRegistration {
  clientName: string;
  redirectUris: string[];
  clientUri: string | null;
  logoUri: string | null;
  softwareId: string | null;
  softwareVersion: string | null;
}

export type RegistrationResult = { ok: true; value: ClientRegistration } | { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

const MAX_REDIRECT_URIS = 10;
const PRINTABLE_RE = /^[^\u0000-\u001f\u007f]+$/;

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max || !PRINTABLE_RE.test(value)) return undefined;
  return value;
}

/** §25.3: `client_uri` / `logo_uri`, when sent, must be a well-formed `https:` URL of at most
 *  2048 characters with no credentials — never fetched or rendered, but a future admin view must
 *  never be handed a `javascript:` value. Null when absent, undefined when malformed. */
function optionalHttpsUrl(value: unknown): string | null | undefined {
  const text = optionalText(value, 2048);
  if (text === null || text === undefined) return text;
  if (/\s/.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
  return text;
}

/** Validates a registration body: public clients only, the authorization-code grant (with
 *  refresh), exact redirect URIs of the accepted shapes, a 1–80 character printable name. */
export function parseRegistration(body: Record<string, unknown>): RegistrationResult {
  const bad = (description: string): RegistrationResult => ({ ok: false, error: "invalid_client_metadata", description });
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: "invalid_redirect_uri", description: `redirect_uris must list 1 to ${MAX_REDIRECT_URIS} URIs` };
  }
  for (const uri of uris) {
    if (classifyRedirectUri(uri) === null) {
      return { ok: false, error: "invalid_redirect_uri", description: "each redirect URI must be loopback http, https, or a custom app scheme, with no wildcard or fragment" };
    }
  }
  const name = typeof body.client_name === "string" ? body.client_name.trim() : "";
  if (name.length < 1 || name.length > 80 || !PRINTABLE_RE.test(name)) return bad("client_name is required: 1 to 80 printable characters");
  const method = body.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") return bad("only public clients are supported (token_endpoint_auth_method none)");
  const grants = body.grant_types;
  if (grants !== undefined) {
    if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      return bad("grant_types must be authorization_code, optionally with refresh_token");
    }
  }
  const responseTypes = body.response_types;
  if (responseTypes !== undefined && (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== "code"))) return bad("response_types must be code");
  if (body.scope !== undefined && body.scope !== MCP_SCOPE) return bad(`the only scope is ${MCP_SCOPE}`);
  const clientUri = optionalHttpsUrl(body.client_uri);
  const logoUri = optionalHttpsUrl(body.logo_uri);
  if (clientUri === undefined || logoUri === undefined) return bad("client_uri and logo_uri must be https URLs of at most 2048 characters, without credentials");
  const softwareId = optionalText(body.software_id, 200);
  const softwareVersion = optionalText(body.software_version, 200);
  if (softwareId === undefined || softwareVersion === undefined) return bad("software_id and software_version must be short printable strings");
  return { ok: true, value: { clientName: name, redirectUris: [...new Set(uris as string[])], clientUri, logoUri, softwareId, softwareVersion } };
}

// ── /oauth/authorize (§25.3) ─────────────────────────────────────────────────────────────

/** The first query parameter supplied more than once, or null. Checked before client_id or
 *  redirect_uri is read, so a duplicated redirect_uri can never be resolved to the registered one. */
export function duplicateParameter(params: URLSearchParams): string | null {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/** What the consent row stores (`oauth_pending_authorizations.request`). */
export interface ValidatedAuthorization {
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string;
}

export type AuthorizeCheck =
  | { ok: true; value: ValidatedAuthorization }
  /** Shown on the non-redirecting error page: the redirect target itself cannot be trusted. */
  | { ok: false; redirect: false; message: string }
  /** Sent back to the (validated) redirect URI as `error` / `error_description`. */
  | { ok: false; redirect: true; redirectUri: string; state: string | null; error: string; description: string };

/** The RFC 8707 resource every token is minted for: `<PUBLIC_BASE_URL>/mcp`. */
export function mcpResource(baseUrl: string): string {
  return `${baseUrl}${MCP_PATH}`;
}

/**
 * Validates an authorization request against its (already loaded) client. Duplicate parameters,
 * an unknown client or an unregistered redirect URI answer with the error page; anything else is
 * reported to the client through its redirect URI.
 */
export function checkAuthorizeRequest(
  params: URLSearchParams,
  client: { redirectUris: readonly string[] } | null,
  expectedResource: string,
): AuthorizeCheck {
  const duplicate = duplicateParameter(params);
  if (duplicate) return { ok: false, redirect: false, message: `The request names "${duplicate}" more than once.` };
  if (!client) return { ok: false, redirect: false, message: "This application is not registered with InnoBox." };
  const redirectUri = matchRedirectUri(client.redirectUris, params.get("redirect_uri"));
  if (!redirectUri) return { ok: false, redirect: false, message: "The application asked to return to an address it did not register." };
  const rawState = params.get("state");
  const state = rawState !== null && rawState.length <= 1024 ? rawState : null;
  const fail = (error: string, description: string): AuthorizeCheck => ({ ok: false, redirect: true, redirectUri, state, error, description });
  if (rawState !== null && rawState.length > 1024) return fail("invalid_request", "state is too long");
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  if (params.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  const codeChallenge = params.get("code_challenge");
  if (!isValidCodeChallenge(codeChallenge)) return fail("invalid_request", "code_challenge is missing or malformed");
  const scope = params.get("scope");
  if (scope !== null && scope.split(" ").some((s) => s !== "" && s !== MCP_SCOPE)) return fail("invalid_scope", `the only scope is ${MCP_SCOPE}`);
  if (params.get("resource") !== expectedResource) return fail("invalid_target", `resource must be ${expectedResource}`);
  return { ok: true, value: { redirectUri, codeChallenge, state, resource: expectedResource } };
}

/** The client redirect: the URI with `params` appended to its query (null values skipped). */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return url.toString();
}

// ── /oauth/consent (§25.3) ───────────────────────────────────────────────────────────────

export type ConsentForm = { ok: true; decision: "approve" | "deny"; requestId: string } | { ok: false; message: string };

/**
 * The consent form's three fields: the pending-authorization handle, the choice, and — for an
 * approve only — the "I started this connection from my own AI tool" confirmation (`confirm=1`).
 * An approve without the tick is refused (the handler answers 400); Deny needs nothing. Pure, and
 * checked before the pending row is consumed, so the person can go back, tick the box and submit
 * the same consent again.
 */
export function parseConsentForm(form: URLSearchParams): ConsentForm {
  const decision = form.get("decision");
  if (decision !== "approve" && decision !== "deny") return { ok: false, message: "The form was incomplete." };
  if (decision === "approve" && form.get("confirm") !== "1") {
    return { ok: false, message: "Confirm that you started this connection from your own AI tool, then approve it again." };
  }
  return { ok: true, decision, requestId: form.get("request_id") ?? "" };
}

// ── Metadata documents ───────────────────────────────────────────────────────────────────

/** RFC 9728 protected-resource metadata for `<base>/mcp`. */
export function protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
  return {
    resource: mcpResource(baseUrl),
    authorization_servers: [baseUrl],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "InnoBox",
  };
}

/** RFC 8414 authorization-server metadata. */
export function authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    scopes_supported: [MCP_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The `WWW-Authenticate` value of a 401 from /mcp: where to discover how to sign in. Never why. */
export function bearerChallenge(baseUrl: string): string {
  return `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;
}
