// Hermetic unit tests for the pure reconciliation drift logic (ENTRA_AUTH_SPEC.md §5).
// Run directly: node --import tsx --test packages/worker/src/recon/diff.test.ts
// (also picked up compiled by the package's `pnpm test` dist run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMembershipDiff, computeUserHeal, directoryAttr, type GraphUser, type LocalUserAttrs } from "./diff.js";

const local: LocalUserAttrs = {
  userName: "ada@example.com",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  department: "R&D",
  jobTitle: "Engineer",
  officeLocation: "Sofia",
};

const graphSame: GraphUser = {
  exists: true,
  accountEnabled: true,
  displayName: "Ada Lovelace",
  userPrincipalName: "ada@example.com",
  mail: "ada@example.com",
  department: "R&D",
  jobTitle: "Engineer",
  officeLocation: "Sofia",
};

test("computeUserHeal: user missing in tenant → deactivate", () => {
  assert.deepEqual(computeUserHeal(local, { exists: false }), { action: "deactivate" });
});

test("computeUserHeal: disabled account → deactivate, even with attribute drift", () => {
  const heal = computeUserHeal(local, { ...graphSame, accountEnabled: false, displayName: "Ada L." });
  assert.deepEqual(heal, { action: "deactivate" });
});

test("computeUserHeal: identical snapshot → none", () => {
  assert.deepEqual(computeUserHeal(local, graphSame), { action: "none" });
});

test("computeUserHeal: displayName drift → refresh with ONLY display_name in the patch", () => {
  const heal = computeUserHeal(local, { ...graphSame, displayName: "Ada King" });
  assert.deepEqual(heal, { action: "refresh", patch: { display_name: "Ada King" } });
});

test("computeUserHeal: mail removed in Graph → patch nulls email", () => {
  const heal = computeUserHeal(local, { ...graphSame, mail: null });
  assert.deepEqual(heal, { action: "refresh", patch: { email: null } });
});

test("computeUserHeal: UPN case-only change is not drift (compared case-insensitively)", () => {
  const heal = computeUserHeal(local, { ...graphSame, userPrincipalName: "Ada@example.com" });
  assert.deepEqual(heal, { action: "none" });
});

test("computeUserHeal: real UPN rename → patch preserves Graph casing", () => {
  const heal = computeUserHeal(local, { ...graphSame, userPrincipalName: "Ada.King@example.com" });
  assert.deepEqual(heal, { action: "refresh", patch: { user_name: "Ada.King@example.com" } });
});

test("computeUserHeal: directory profile set from null locally → patched (§13.8)", () => {
  const bare: LocalUserAttrs = { ...local, department: null, jobTitle: null, officeLocation: null };
  const heal = computeUserHeal(bare, graphSame);
  assert.deepEqual(heal, {
    action: "refresh",
    patch: { department: "R&D", job_title: "Engineer", office_location: "Sofia" },
  });
});

test("computeUserHeal: officeLocation drift → refresh with ONLY office_location in the patch (§13.8)", () => {
  const heal = computeUserHeal(local, { ...graphSame, officeLocation: "Plovdiv" });
  assert.deepEqual(heal, { action: "refresh", patch: { office_location: "Plovdiv" } });
});

test("computeUserHeal: officeLocation cleared in Graph → patch nulls it (unconditional overwrite, §13.8)", () => {
  const heal = computeUserHeal(local, { ...graphSame, officeLocation: null });
  assert.deepEqual(heal, { action: "refresh", patch: { office_location: null } });
});

test("computeUserHeal: multi-field drift → patch contains exactly the changed fields", () => {
  const heal = computeUserHeal(local, {
    ...graphSame,
    displayName: "Ada King",
    mail: "ada.king@example.com",
    department: null,
  });
  assert.deepEqual(heal, {
    action: "refresh",
    patch: { display_name: "Ada King", email: "ada.king@example.com", department: null },
  });
});

test("computeMembershipDiff: both empty → no changes", () => {
  assert.deepEqual(computeMembershipDiff([], []), { add: [], remove: [] });
});

test("computeMembershipDiff: identical sets → no changes", () => {
  assert.deepEqual(computeMembershipDiff(["a", "b"], ["b", "a"]), { add: [], remove: [] });
});

test("computeMembershipDiff: add only", () => {
  assert.deepEqual(computeMembershipDiff([], ["a", "b"]), { add: ["a", "b"], remove: [] });
});

test("computeMembershipDiff: remove only (Graph side empty)", () => {
  assert.deepEqual(computeMembershipDiff(["a", "b"], []), { add: [], remove: ["a", "b"] });
});

test("computeMembershipDiff: mixed add and remove", () => {
  assert.deepEqual(computeMembershipDiff(["a", "b"], ["b", "c"]), { add: ["c"], remove: ["a"] });
});

test("computeMembershipDiff: duplicates on either side are ignored", () => {
  assert.deepEqual(computeMembershipDiff(["a", "a", "b"], ["b", "c", "c"]), { add: ["c"], remove: ["a"] });
});

test("directoryAttr: absent, empty and whitespace-only → null; otherwise trimmed", () => {
  assert.equal(directoryAttr(undefined), null);
  assert.equal(directoryAttr(null), null);
  assert.equal(directoryAttr(""), null);
  assert.equal(directoryAttr("   "), null);
  assert.equal(directoryAttr("\t\n"), null);
  assert.equal(directoryAttr(" Sofia "), "Sofia");
  assert.equal(directoryAttr("R&D"), "R&D");
});

test("computeUserHeal: an EMPTY / whitespace Graph directory attribute clears the local one to NULL", () => {
  const heal = computeUserHeal(local, { ...graphSame, department: "", jobTitle: "  ", officeLocation: "" });
  assert.deepEqual(heal, { action: "refresh", patch: { department: null, job_title: null, office_location: null } });
});

test("computeUserHeal: an empty Graph attribute against an already-NULL local one is not drift", () => {
  const cleared: LocalUserAttrs = { ...local, department: null, jobTitle: null, officeLocation: null };
  assert.deepEqual(computeUserHeal(cleared, { ...graphSame, department: "", jobTitle: " ", officeLocation: "" }), { action: "none" });
});
