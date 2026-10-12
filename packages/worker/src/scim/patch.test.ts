// Hermetic unit tests for the PATCH normalizer — every Entra deactivation serialization,
// case-insensitive ops, and the group membership Add/Remove forms (the Entra
// provisioning contract in ENTRA_AUTH_SPEC.md §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGroupPatch, normalizeUserPatch, parseActiveValue } from "./patch.js";

// ── parseActiveValue ─────────────────────────────────────────────────────────────────────

test("parseActiveValue: boolean passthrough", () => {
  assert.equal(parseActiveValue(true), true);
  assert.equal(parseActiveValue(false), false);
});

test("parseActiveValue: capitalized string quirk", () => {
  assert.equal(parseActiveValue("False"), false);
  assert.equal(parseActiveValue("false"), false);
  assert.equal(parseActiveValue("FALSE"), false);
  assert.equal(parseActiveValue("True"), true);
  assert.equal(parseActiveValue("true"), true);
});

test("parseActiveValue: unrecognized -> undefined", () => {
  assert.equal(parseActiveValue("yes"), undefined);
  assert.equal(parseActiveValue(1), undefined);
  assert.equal(parseActiveValue(null), undefined);
});

// ── normalizeUserPatch ───────────────────────────────────────────────────────────────────

test("user patch: standard boolean deactivation", () => {
  const result = normalizeUserPatch([{ op: "replace", path: "active", value: false }]);
  assert.deepEqual(result, { active: false });
});

test("user patch: capitalized-string deactivation, case-insensitive op", () => {
  const result = normalizeUserPatch([{ op: "Replace", path: "active", value: "False" }]);
  assert.deepEqual(result, { active: false });
});

test("user patch: path-less replace with an attribute object", () => {
  const result = normalizeUserPatch([{ op: "replace", value: { active: false } }]);
  assert.deepEqual(result, { active: false });
});

test("user patch: op casing variants all recognized", () => {
  for (const op of ["add", "Add", "replace", "Replace", "Remove", "REMOVE"]) {
    const result = normalizeUserPatch([{ op, path: "active", value: true }]);
    assert.deepEqual(result, { active: true }, `op=${op}`);
  }
});

test("user patch: reactivation clears via true", () => {
  assert.deepEqual(normalizeUserPatch([{ op: "replace", path: "active", value: true }]), { active: true });
});

test("user patch: displayName, title, enterprise department", () => {
  const result = normalizeUserPatch([
    { op: "replace", path: "displayName", value: "Ada L." },
    { op: "replace", path: "title", value: "Principal Engineer" },
    {
      op: "replace",
      path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
      value: "R&D",
    },
  ]);
  assert.deepEqual(result, { displayName: "Ada L.", jobTitle: "Principal Engineer", department: "R&D" });
});

// The work e-mail, in both forms Entra sends (ENTRA_AUTH_SPEC.md §5 PATCH quirks).
test("user patch: work e-mail via the emails[type eq \"work\"].value filter path (Entra's literal payload)", () => {
  const result = normalizeUserPatch([
    { op: "Replace", path: 'emails[type eq "work"].value', value: "ada.lovelace@example.com" },
  ]);
  assert.deepEqual(result, { email: "ada.lovelace@example.com" });
});

test("user patch: work e-mail filter path tolerates spacing and casing", () => {
  const result = normalizeUserPatch([{ op: "add", path: 'Emails[ Type EQ "work" ].Value', value: " ada@example.com " }]);
  assert.deepEqual(result, { email: "ada@example.com" });
});

test("user patch: work e-mail via a path-less emails array", () => {
  const result = normalizeUserPatch([
    {
      op: "replace",
      value: { emails: [{ type: "work", value: "ada.lovelace@example.com", primary: true }] },
    },
  ]);
  assert.deepEqual(result, { email: "ada.lovelace@example.com" });
});

test("user patch: emails array on the bare emails path prefers type work, then primary, then first", () => {
  const work = normalizeUserPatch([
    {
      op: "replace",
      path: "emails",
      value: [
        { type: "other", value: "home@example.com", primary: true },
        { type: "work", value: "work@example.com" },
      ],
    },
  ]);
  assert.deepEqual(work, { email: "work@example.com" });
  const primary = normalizeUserPatch([
    { op: "replace", path: "emails", value: [{ value: "a@example.com" }, { value: "b@example.com", primary: true }] },
  ]);
  assert.deepEqual(primary, { email: "b@example.com" });
  const first = normalizeUserPatch([{ op: "replace", path: "emails", value: [{ value: "a@example.com" }] }]);
  assert.deepEqual(first, { email: "a@example.com" });
});

test("user patch: a non-work filter path, blank value or empty array leaves the e-mail alone", () => {
  assert.deepEqual(normalizeUserPatch([{ op: "replace", path: 'emails[type eq "home"].value', value: "h@example.com" }]), {});
  assert.deepEqual(normalizeUserPatch([{ op: "replace", path: 'emails[type eq "work"].value', value: "  " }]), {});
  assert.deepEqual(normalizeUserPatch([{ op: "replace", value: { emails: [] } }]), {});
});

test("user patch: externalId (Entra's literal payload, and the path-less form)", () => {
  const oid = "8d2f1b6e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
  assert.deepEqual(normalizeUserPatch([{ op: "Replace", path: "externalId", value: oid }]), { externalId: oid });
  assert.deepEqual(normalizeUserPatch([{ op: "replace", value: { externalId: oid, active: true } }]), {
    externalId: oid,
    active: true,
  });
  assert.deepEqual(normalizeUserPatch([{ op: "replace", path: "externalId", value: "" }]), {}, "blank is ignored");
});

test("user patch: unknown path is ignored, never throws", () => {
  assert.deepEqual(normalizeUserPatch([{ op: "replace", path: "name.givenName", value: "Ada" }]), {});
  assert.deepEqual(normalizeUserPatch([{ op: "replace", path: "nickName", value: "Ada" }]), {});
});

test("user patch: malformed operations array tolerated", () => {
  assert.deepEqual(normalizeUserPatch(undefined), {});
  assert.deepEqual(normalizeUserPatch(null), {});
  assert.deepEqual(normalizeUserPatch("not an array"), {});
  assert.deepEqual(normalizeUserPatch([null, 42, { op: "bogus" }]), {});
});

// ── normalizeGroupPatch ──────────────────────────────────────────────────────────────────

test("group patch: Add members via value array of {value: id}", () => {
  const result = normalizeGroupPatch([{ op: "Add", path: "members", value: [{ value: "user-1" }, { value: "user-2" }] }]);
  assert.deepEqual(result.addMemberIds, ["user-1", "user-2"]);
  assert.deepEqual(result.removeMemberIds, []);
  assert.equal(result.removeAll, false);
});

test("group patch: Remove via members[value eq \"...\"] filter path", () => {
  const result = normalizeGroupPatch([{ op: "Remove", path: 'members[value eq "user-1"]' }]);
  assert.deepEqual(result.removeMemberIds, ["user-1"]);
  assert.deepEqual(result.addMemberIds, []);
});

test("group patch: Remove with bare members path and no value clears the whole roster", () => {
  const result = normalizeGroupPatch([{ op: "Remove", path: "members" }]);
  assert.equal(result.removeAll, true);
  assert.deepEqual(result.removeMemberIds, []);
});

test("group patch: Remove with bare members path and a value array removes just those ids", () => {
  const result = normalizeGroupPatch([{ op: "Remove", path: "members", value: [{ value: "user-1" }] }]);
  assert.equal(result.removeAll, false);
  assert.deepEqual(result.removeMemberIds, ["user-1"]);
});

test("group patch: displayName rename via replace", () => {
  const result = normalizeGroupPatch([{ op: "replace", path: "displayName", value: "Engineering (renamed)" }]);
  assert.equal(result.displayName, "Engineering (renamed)");
});

test("group patch: path-less replace with members array (initial-members quirk)", () => {
  const result = normalizeGroupPatch([{ op: "replace", value: { displayName: "Eng", members: [{ value: "user-9" }] } }]);
  assert.equal(result.displayName, "Eng");
  assert.deepEqual(result.addMemberIds, ["user-9"]);
});

test("group patch: unknown path ignored, never throws", () => {
  const result = normalizeGroupPatch([{ op: "replace", path: "nonMember", value: "x" }]);
  assert.deepEqual(result, { addMemberIds: [], removeMemberIds: [], removeAll: false });
});

test("group patch: malformed operations tolerated", () => {
  const empty = { addMemberIds: [], removeMemberIds: [], removeAll: false };
  assert.deepEqual(normalizeGroupPatch(undefined), empty);
  assert.deepEqual(normalizeGroupPatch([null, "x", { op: "add" }]), empty);
});

test("group patch: bare string member ids also accepted (defensive, beyond the {value} form)", () => {
  const result = normalizeGroupPatch([{ op: "Add", path: "members", value: ["user-1"] }]);
  assert.deepEqual(result.addMemberIds, ["user-1"]);
});
