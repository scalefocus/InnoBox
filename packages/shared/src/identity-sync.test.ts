// §14.10 explanation selection and the card summary label.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_SYNC_EXPLANATIONS,
  identitySyncState,
  identitySyncSummaryLabel,
  UNARRIVED_GROUP_HINT,
} from "./identity-sync.js";

test("identitySyncState: nothing at all → nothing_synced", () => {
  assert.equal(identitySyncState({ users: 0, groups: 0 }), "nothing_synced");
});

test("identitySyncState: users but no groups → users_no_groups", () => {
  assert.equal(identitySyncState({ users: 1, groups: 0 }), "users_no_groups");
  assert.equal(identitySyncState({ users: 500, groups: 0 }), "users_no_groups");
});

test("identitySyncState: groups present → ok, with or without users", () => {
  assert.equal(identitySyncState({ users: 12, groups: 3 }), "ok");
  assert.equal(identitySyncState({ users: 0, groups: 2 }), "ok", "groups without users is not one of the fixed explanations");
});

test("explanations: exactly the two non-ok states carry copy, and it names the runbook steps", () => {
  assert.equal(IDENTITY_SYNC_EXPLANATIONS.ok, null);
  assert.match(IDENTITY_SYNC_EXPLANATIONS.nothing_synced ?? "", /\/scim\/v2/);
  assert.match(IDENTITY_SYNC_EXPLANATIONS.nothing_synced ?? "", /Provision on demand/);
  assert.match(IDENTITY_SYNC_EXPLANATIONS.users_no_groups ?? "", /Sync only assigned users and groups/);
  for (const copy of [...Object.values(IDENTITY_SYNC_EXPLANATIONS), UNARRIVED_GROUP_HINT]) {
    assert.ok(!copy?.includes("§"), "no spec reference on a user-facing surface");
  }
});

test("identitySyncSummaryLabel: counts, pluralised, or Not synced", () => {
  assert.equal(identitySyncSummaryLabel({ users: 0, groups: 0 }), "Not synced");
  assert.equal(identitySyncSummaryLabel({ users: 42, groups: 3 }), "42 users · 3 groups");
  assert.equal(identitySyncSummaryLabel({ users: 1, groups: 1 }), "1 user · 1 group");
  assert.equal(identitySyncSummaryLabel({ users: 7, groups: 0 }), "7 users · 0 groups");
});
