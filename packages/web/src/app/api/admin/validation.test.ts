// Hermetic unit tests for the /api/admin request validators (ENTRA_AUTH_SPEC.md §5 layer
// 3): pure, no DB — every 400-worthy shape the routes must reject before it reaches SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isUuid,
  parseNamespaceCreate,
  parseNamespacePatch,
  parseRoleMappingCreate,
} from "./validation";

test("isUuid accepts a well-formed uuid and rejects everything else", () => {
  assert.equal(isUuid("6a2f6f3e-0000-4000-8000-000000000001"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
});

test("parseNamespaceCreate accepts a valid slug + display name, trimming the name", () => {
  const parsed = parseNamespaceCreate({ slug: "sales-eu", displayName: "  Sales (EU)  " });
  assert.deepEqual(parsed, { ok: true, value: { slug: "sales-eu", displayName: "Sales (EU)" } });
});

test("parseNamespaceCreate rejects a non-object body", () => {
  assert.equal(parseNamespaceCreate(null).ok, false);
  assert.equal(parseNamespaceCreate("x").ok, false);
  assert.equal(parseNamespaceCreate([]).ok, false);
});

test("parseNamespaceCreate rejects slugs outside [a-z0-9-]{2,40}", () => {
  for (const slug of ["A", "ab_cd", "Sales", "a", "x".repeat(41), ""]) {
    const parsed = parseNamespaceCreate({ slug, displayName: "Name" });
    assert.equal(parsed.ok, false, `expected slug "${slug}" to be rejected`);
  }
});

test("parseNamespaceCreate rejects a missing or blank displayName", () => {
  assert.equal(parseNamespaceCreate({ slug: "sales" }).ok, false);
  assert.equal(parseNamespaceCreate({ slug: "sales", displayName: "   " }).ok, false);
  assert.equal(parseNamespaceCreate({ slug: "sales", displayName: "x".repeat(121) }).ok, false);
});

test("parseNamespacePatch accepts displayName only, archived only, or both", () => {
  assert.deepEqual(parseNamespacePatch({ displayName: "New name" }), {
    ok: true,
    value: { displayName: "New name" },
  });
  assert.deepEqual(parseNamespacePatch({ archived: true }), { ok: true, value: { archived: true } });
  assert.deepEqual(parseNamespacePatch({ displayName: "New name", archived: false }), {
    ok: true,
    value: { displayName: "New name", archived: false },
  });
});

test("parseNamespacePatch rejects an empty patch and wrong-typed fields", () => {
  assert.equal(parseNamespacePatch({}).ok, false);
  assert.equal(parseNamespacePatch({ archived: "true" }).ok, false);
  assert.equal(parseNamespacePatch({ displayName: 5 }).ok, false);
});

test("parseRoleMappingCreate accepts a platform_admin mapping with a null namespace", () => {
  const parsed = parseRoleMappingCreate({
    groupExternalId: "11111111-1111-1111-1111-111111111111",
    role: "platform_admin",
    namespaceId: null,
  });
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      groupExternalId: "11111111-1111-1111-1111-111111111111",
      role: "platform_admin",
      namespaceId: null,
    },
  });
});

test("parseRoleMappingCreate accepts a namespace-scoped role with a uuid namespaceId", () => {
  const nsId = "6a2f6f3e-0000-4000-8000-000000000001";
  const parsed = parseRoleMappingCreate({
    groupExternalId: "grp-1",
    role: "namespace_admin",
    namespaceId: nsId,
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.namespaceId, nsId);
});

test("parseRoleMappingCreate rejects platform_admin paired with a namespace id", () => {
  const parsed = parseRoleMappingCreate({
    groupExternalId: "grp-1",
    role: "platform_admin",
    namespaceId: "6a2f6f3e-0000-4000-8000-000000000001",
  });
  assert.equal(parsed.ok, false);
});

test("parseRoleMappingCreate rejects a namespace-scoped role with no namespace id", () => {
  for (const role of ["namespace_admin", "committee", "member"]) {
    const parsed = parseRoleMappingCreate({ groupExternalId: "grp-1", role, namespaceId: null });
    assert.equal(parsed.ok, false, `expected ${role} without a namespace to be rejected`);
  }
});

test("parseRoleMappingCreate rejects an unknown role and a malformed namespaceId", () => {
  assert.equal(
    parseRoleMappingCreate({ groupExternalId: "grp-1", role: "superuser", namespaceId: null }).ok,
    false,
  );
  assert.equal(
    parseRoleMappingCreate({ groupExternalId: "grp-1", role: "member", namespaceId: "not-a-uuid" }).ok,
    false,
  );
});

test("parseRoleMappingCreate rejects a missing or blank groupExternalId", () => {
  assert.equal(parseRoleMappingCreate({ role: "member", namespaceId: "x" }).ok, false);
  assert.equal(
    parseRoleMappingCreate({ groupExternalId: "   ", role: "member", namespaceId: "x" }).ok,
    false,
  );
});
