// Entra tenant pinning (ENTRA_AUTH_SPEC.md §5 layer 1). Sign-in must be pinned to the one tenant:
// the AzureAD provider derives its discovery document — and so the issuer every ID token is
// validated against — from `tenantId`, and an unset value silently falls back to the multi-tenant
// `common` authority. Pure and free of the database/next-auth runtime imports authOptions.ts
// carries, so the provider config and the start-up rule are unit-testable (entra-tenant.test.ts);
// instrumentation.ts applies the rule, authOptions.ts uses the provider.
import AzureADImport from "next-auth/providers/azure-ad";

// next-auth ships CommonJS: Next's bundler unwraps the default export, but Node's own ESM loader
// (the unit tests) hands back the module object — accept either shape.
const AzureADProvider =
  (AzureADImport as unknown as { default?: typeof AzureADImport }).default ?? AzureADImport;

/** Authorities that accept more than one tenant — never a valid ENTRA_TENANT_ID. */
export const MULTI_TENANT_AUTHORITIES: readonly string[] = ["common", "organizations", "consumers"];

/** The v2.0 issuer for a tenant — what the tenant's discovery document advertises and every
 *  accepted ID token's `iss` must equal. */
export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

/** The fatal structured log line when a production build has no single tenant to pin sign-in to
 *  (ENTRA_TENANT_ID unset, blank, or a multi-tenant authority, compared case-insensitively), else
 *  null. Names the variable; the value is not echoed. */
export function entraTenantStartupViolation(env: { NODE_ENV?: string; ENTRA_TENANT_ID?: string }): string | null {
  if (env.NODE_ENV !== "production") return null;
  const tenant = env.ENTRA_TENANT_ID?.trim() ?? "";
  const multiTenant = MULTI_TENANT_AUTHORITIES.includes(tenant.toLowerCase());
  if (tenant !== "" && !multiTenant) return null;
  return JSON.stringify({
    level: "fatal",
    msg: multiTenant
      ? "ENTRA_TENANT_ID names a multi-tenant authority in a production build — refusing to start. Set it to the directory (tenant) id."
      : "ENTRA_TENANT_ID is not set in a production build — refusing to start. Set it to the directory (tenant) id.",
    variable: "ENTRA_TENANT_ID",
  });
}

export interface EntraProviderEnv {
  ENTRA_TENANT_ID?: string;
  ENTRA_CLIENT_ID?: string;
  ENTRA_CLIENT_SECRET?: string;
}

/** The Entra ID OIDC provider. The tenant id (trimmed) pins the discovery URL and so the issuer;
 *  token validation itself (audience = client id, RS256 via the tenant JWKS, pkce/state/nonce) is
 *  delegated to the library. Outside production an unset tenant still reaches the library default
 *  — the start-up guard above is what refuses it in production. */
export function buildEntraProvider(env: EntraProviderEnv) {
  return AzureADProvider({
    // Display name shown on any provider-labeled control ("Sign in with Entra ID") — never
    // the library default "Azure Active Directory". The sign-in UI is in-shell (AppShell),
    // not the removed default Auth.js page (ENTRA_AUTH_SPEC.md §5, layer 1).
    name: "Entra ID",
    tenantId: env.ENTRA_TENANT_ID?.trim() || undefined,
    clientId: env.ENTRA_CLIENT_ID ?? "",
    clientSecret: env.ENTRA_CLIENT_SECRET ?? "",
    authorization: { params: { scope: "openid profile email" } },
    checks: ["pkce", "state", "nonce"],
    // Replaces the provider default, which also fetches the user photo from Graph —
    // reconciliation owns photos (spec §5); sign-in needs claims only.
    profile(claims) {
      return {
        id: (claims.oid as string | undefined) ?? claims.sub,
        name: (claims.name as string | undefined) ?? null,
        email: claims.email ?? null,
      };
    },
  });
}
