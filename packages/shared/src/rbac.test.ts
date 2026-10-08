import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoleSet, type RoleGrant } from "./rbac.js";

const GLOBAL = "00000000-0000-0000-0000-000000000001";
const NS_A = "aaaaaaaa-0000-0000-0000-000000000001";
const NS_B = "bbbbbbbb-0000-0000-0000-000000000002";

test("empty grants: baseline is implicit global member only", () => {
  const rs = buildRoleSet([], { globalNamespaceId: GLOBAL });
  assert.deepEqual(rs.grants, [{ role: "member", namespaceId: GLOBAL }]);
  assert.equal(rs.isPlatformAdmin, false);
  assert.equal(rs.isMemberOf(GLOBAL), true);
  assert.equal(rs.isMemberOf(NS_A), false);
  assert.equal(rs.isNamespaceAdmin(GLOBAL), false);
  assert.equal(rs.isCommittee(GLOBAL), false);
  assert.deepEqual(rs.memberNamespaces(), [GLOBAL]);
});

test("multi-namespace union of grants", () => {
  const grants: RoleGrant[] = [
    { role: "member", namespaceId: NS_A },
    { role: "committee", namespaceId: NS_B },
  ];
  const rs = buildRoleSet(grants, { globalNamespaceId: GLOBAL });
  assert.equal(rs.isMemberOf(NS_A), true);
  assert.equal(rs.isMemberOf(NS_B), true);
  assert.equal(rs.isCommittee(NS_B), true);
  assert.equal(rs.isCommittee(NS_A), false);
  assert.deepEqual(new Set(rs.memberNamespaces()), new Set([NS_A, NS_B, GLOBAL]));
});

test("platform admin implies namespace admin and member everywhere", () => {
  const rs = buildRoleSet([{ role: "platform_admin", namespaceId: null }], {
    globalNamespaceId: GLOBAL,
  });
  assert.equal(rs.isPlatformAdmin, true);
  assert.equal(rs.isNamespaceAdmin(NS_A), true);
  assert.equal(rs.isNamespaceAdmin(NS_B), true);
  assert.equal(rs.isMemberOf(NS_A), true);
  assert.equal(rs.isMemberOf(NS_B), true);
});

test("committee is strict: neither namespace admin nor platform admin qualifies", () => {
  const rs = buildRoleSet(
    [
      { role: "platform_admin", namespaceId: null },
      { role: "namespace_admin", namespaceId: NS_A },
    ],
    { globalNamespaceId: GLOBAL },
  );
  assert.equal(rs.isNamespaceAdmin(NS_A), true);
  assert.equal(rs.isCommittee(NS_A), false);
  assert.equal(rs.isCommittee(NS_B), false);
});

test("namespace admin grant also confers membership in that namespace", () => {
  const rs = buildRoleSet([{ role: "namespace_admin", namespaceId: NS_A }], {
    globalNamespaceId: GLOBAL,
  });
  assert.equal(rs.isMemberOf(NS_A), true);
  assert.equal(rs.isMemberOf(NS_B), false);
});

test("dedupe: identical grants collapse, explicit global member merges with implicit", () => {
  const rs = buildRoleSet(
    [
      { role: "member", namespaceId: NS_A },
      { role: "member", namespaceId: NS_A },
      { role: "member", namespaceId: GLOBAL },
    ],
    { globalNamespaceId: GLOBAL },
  );
  assert.deepEqual(rs.grants, [
    { role: "member", namespaceId: NS_A },
    { role: "member", namespaceId: GLOBAL },
  ]);
});

test("bootstrap flag injects platform_admin, deduped against an explicit grant", () => {
  const boot = buildRoleSet([], { bootstrapPlatformAdmin: true, globalNamespaceId: GLOBAL });
  assert.equal(boot.isPlatformAdmin, true);
  assert.equal(boot.isNamespaceAdmin(NS_A), true);

  const both = buildRoleSet([{ role: "platform_admin", namespaceId: null }], {
    bootstrapPlatformAdmin: true,
    globalNamespaceId: GLOBAL,
  });
  assert.equal(both.grants.filter((g) => g.role === "platform_admin").length, 1);
});

test("bootstrap flag off/false injects nothing", () => {
  const rs = buildRoleSet([], { bootstrapPlatformAdmin: false, globalNamespaceId: GLOBAL });
  assert.equal(rs.isPlatformAdmin, false);
});

test("memberNamespaces includes global exactly once", () => {
  const rs = buildRoleSet(
    [
      { role: "member", namespaceId: GLOBAL },
      { role: "committee", namespaceId: GLOBAL },
      { role: "member", namespaceId: NS_A },
    ],
    { globalNamespaceId: GLOBAL },
  );
  const globals = rs.memberNamespaces().filter((id) => id === GLOBAL);
  assert.equal(globals.length, 1);
});

test("platform admin: memberNamespaces still lists only granted namespaces plus global", () => {
  const rs = buildRoleSet([{ role: "platform_admin", namespaceId: null }], {
    globalNamespaceId: GLOBAL,
  });
  assert.deepEqual(rs.memberNamespaces(), [GLOBAL]);
  // ... while isMemberOf remains true everywhere (checked above); the list is what the
  // user belongs to, not what they can see.
});
