// Pins the §2.3 bootstrap-admin notice decision (INNOBOX_SPEC.md): shown only while the variable is
// set AND a platform_admin role mapping exists; and that its copy carries no spec reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOOTSTRAP_ADMIN_NOTICE, bootstrapAdminGroupActive } from "./bootstrap-admin";

const GROUP = "11111111-2222-3333-4444-555555555555";

test("bootstrapAdminGroupActive: set variable + at least one platform_admin mapping → true", () => {
  assert.equal(bootstrapAdminGroupActive(GROUP, 1), true);
  assert.equal(bootstrapAdminGroupActive(GROUP, 3), true);
});

test("bootstrapAdminGroupActive: unset, blank or whitespace-only variable → false whatever the count", () => {
  for (const env of [undefined, null, "", "   ", "\t"]) {
    assert.equal(bootstrapAdminGroupActive(env, 5), false, JSON.stringify(env));
  }
});

test("bootstrapAdminGroupActive: set variable but no platform_admin mapping yet → false (the grant is still needed)", () => {
  assert.equal(bootstrapAdminGroupActive(GROUP, 0), false);
});

test("the notice wording is the spec's, names the variable, and carries no section reference", () => {
  assert.equal(BOOTSTRAP_ADMIN_NOTICE, "Bootstrap admin group is still configured; remove INNOBOX_BOOTSTRAP_ADMIN_GROUP once a role mapping grants platform admin.");
  assert.equal(BOOTSTRAP_ADMIN_NOTICE.includes("§"), false);
});
