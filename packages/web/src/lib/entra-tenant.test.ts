// Unit tests for Entra tenant pinning (ENTRA_AUTH_SPEC.md §5 layer 1, §8 "Tenant pinning"):
// the provider's issuer is pinned to ENTRA_TENANT_ID, and a production build refuses to start
// without a single tenant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEntraProvider, entraIssuer, entraTenantStartupViolation } from "./entra-tenant";

const TENANT = "4f1d2c3b-9a8e-4d7c-b6a5-0e1f2a3b4c5d";

test("entraIssuer: the tenant's v2.0 issuer", () => {
  assert.equal(entraIssuer(TENANT), `https://login.microsoftonline.com/${TENANT}/v2.0`);
});

test("buildEntraProvider: discovery — and so the validated issuer — is pinned to ENTRA_TENANT_ID", () => {
  const provider = buildEntraProvider({ ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: "client-1", ENTRA_CLIENT_SECRET: "s" });
  assert.equal(provider.id, "azure-ad");
  // next-auth merges `options` over the provider defaults when it parses providers.
  assert.equal(provider.options?.name, "Entra ID");
  assert.ok(
    provider.wellKnown?.startsWith(`${entraIssuer(TENANT)}/.well-known/openid-configuration`),
    `wellKnown ${provider.wellKnown} is the tenant's own discovery document`,
  );
  assert.ok(!/\/(common|organizations|consumers)\//i.test(provider.wellKnown ?? ""), "never a multi-tenant authority");
  assert.deepEqual(provider.options?.checks, ["pkce", "state", "nonce"]);
});

test("buildEntraProvider: the tenant id is trimmed before it reaches the discovery URL", () => {
  const provider = buildEntraProvider({ ENTRA_TENANT_ID: `  ${TENANT}\n`, ENTRA_CLIENT_ID: "client-1" });
  assert.ok(provider.wellKnown?.startsWith(`${entraIssuer(TENANT)}/`));
});

test("entraTenantStartupViolation: production with no tenant (unset, empty, blank) → fatal, naming the variable", () => {
  for (const value of [undefined, "", "   "]) {
    const line = entraTenantStartupViolation({ NODE_ENV: "production", ENTRA_TENANT_ID: value });
    assert.ok(line, `value ${JSON.stringify(value)} is refused`);
    const parsed = JSON.parse(line) as { level: string; variable: string; msg: string };
    assert.equal(parsed.level, "fatal");
    assert.equal(parsed.variable, "ENTRA_TENANT_ID");
    assert.match(parsed.msg, /ENTRA_TENANT_ID/);
  }
});

test("entraTenantStartupViolation: production with a multi-tenant authority (any case) → fatal, value not echoed", () => {
  for (const value of ["common", "organizations", "consumers", "Common", "ORGANIZATIONS", " consumers "]) {
    const line = entraTenantStartupViolation({ NODE_ENV: "production", ENTRA_TENANT_ID: value });
    assert.ok(line, `value ${JSON.stringify(value)} is refused`);
    const parsed = JSON.parse(line) as { variable: string; msg: string };
    assert.equal(parsed.variable, "ENTRA_TENANT_ID");
    assert.match(parsed.msg, /multi-tenant/);
    assert.ok(!line.toLowerCase().includes(`"${value.trim().toLowerCase()}"`), "the value is not echoed as a field");
  }
});

test("entraTenantStartupViolation: production with a single tenant starts", () => {
  assert.equal(entraTenantStartupViolation({ NODE_ENV: "production", ENTRA_TENANT_ID: TENANT }), null);
  assert.equal(entraTenantStartupViolation({ NODE_ENV: "production", ENTRA_TENANT_ID: "contoso.onmicrosoft.com" }), null);
});

test("entraTenantStartupViolation: outside production nothing is enforced (local dev / e2e)", () => {
  assert.equal(entraTenantStartupViolation({ NODE_ENV: "development" }), null);
  assert.equal(entraTenantStartupViolation({ NODE_ENV: "test", ENTRA_TENANT_ID: "common" }), null);
  assert.equal(entraTenantStartupViolation({}), null);
});
