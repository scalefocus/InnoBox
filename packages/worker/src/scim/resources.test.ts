// Hermetic unit tests for SCIM resource shaping — payload parsing and DB-row -> wire mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENTERPRISE_USER_SCHEMA,
  extractPrimaryEmail,
  parseGroupWrite,
  parseUserWrite,
  resolveExternalId,
  scimError,
  scimListResponse,
  toScimGroup,
  toScimUser,
} from "./resources.js";

// ── resolveExternalId / extractPrimaryEmail ─────────────────────────────────────────────

test("resolveExternalId: prefers externalId, falls back to id, else null", () => {
  assert.equal(resolveExternalId({ externalId: "ext-1", id: "id-1" }), "ext-1");
  assert.equal(resolveExternalId({ id: "id-1" }), "id-1");
  assert.equal(resolveExternalId({}), null);
  assert.equal(resolveExternalId({ externalId: "" }), null);
});

test("extractPrimaryEmail: primary:true wins, else first, else null", () => {
  assert.equal(
    extractPrimaryEmail({ emails: [{ value: "a@x.com" }, { value: "b@x.com", primary: true }] }),
    "b@x.com",
  );
  assert.equal(extractPrimaryEmail({ emails: [{ value: "a@x.com" }] }), "a@x.com");
  assert.equal(extractPrimaryEmail({ emails: [] }), null);
  assert.equal(extractPrimaryEmail({}), null);
});

// ── parseUserWrite ───────────────────────────────────────────────────────────────────────

test("parseUserWrite: the literal Entra create payload", () => {
  const body = {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
    externalId: "9f4a...-objectid",
    userName: "ada@contoso.com",
    active: true,
    displayName: "Ada Lovelace",
    name: { givenName: "Ada", familyName: "Lovelace" },
    emails: [{ value: "ada@contoso.com", type: "work", primary: true }],
  };
  const parsed = parseUserWrite(body);
  assert.deepEqual(parsed, {
    externalId: "9f4a...-objectid",
    userName: "ada@contoso.com",
    email: "ada@contoso.com",
    displayName: "Ada Lovelace",
    department: null,
    jobTitle: null,
    active: true,
  });
});

test("parseUserWrite: no emails -> falls back to userName", () => {
  const parsed = parseUserWrite({ externalId: "ext-1", userName: "ada@contoso.com" });
  assert.equal(parsed.email, "ada@contoso.com");
});

test("parseUserWrite: enterprise department + title", () => {
  const parsed = parseUserWrite({
    externalId: "ext-1",
    userName: "ada@contoso.com",
    title: "Principal Engineer",
    [ENTERPRISE_USER_SCHEMA]: { department: "R&D" },
  });
  assert.equal(parsed.jobTitle, "Principal Engineer");
  assert.equal(parsed.department, "R&D");
});

test("parseUserWrite: externalId absent falls back to id", () => {
  const parsed = parseUserWrite({ id: "id-only", userName: "ada@contoso.com" });
  assert.equal(parsed.externalId, "id-only");
});

test("parseUserWrite: active defaults to true when omitted", () => {
  assert.equal(parseUserWrite({ externalId: "e" }).active, true);
  assert.equal(parseUserWrite({ externalId: "e", active: false }).active, false);
});

// ── parseGroupWrite ──────────────────────────────────────────────────────────────────────

test("parseGroupWrite: displayName + externalId + initial members (object form)", () => {
  const parsed = parseGroupWrite({
    externalId: "grp-1",
    displayName: "Engineering",
    members: [{ value: "user-1" }, { value: "user-2" }],
  });
  assert.deepEqual(parsed, { externalId: "grp-1", displayName: "Engineering", memberIds: ["user-1", "user-2"] });
});

test("parseGroupWrite: bare string member ids also accepted", () => {
  const parsed = parseGroupWrite({ externalId: "grp-1", displayName: "Eng", members: ["user-1"] });
  assert.deepEqual(parsed.memberIds, ["user-1"]);
});

test("parseGroupWrite: no members -> empty array, no displayName -> empty string", () => {
  const parsed = parseGroupWrite({ externalId: "grp-1" });
  assert.deepEqual(parsed.memberIds, []);
  assert.equal(parsed.displayName, "");
});

// ── toScimUser / toScimGroup ─────────────────────────────────────────────────────────────

const now = new Date("2026-07-08T12:00:00.000Z");

test("toScimUser: shape includes id, externalId, meta.resourceType, enterprise extension", () => {
  const resource = toScimUser({
    id: "row-1",
    external_id: "ext-1",
    user_name: "ada@contoso.com",
    email: "ada@contoso.com",
    display_name: "Ada Lovelace",
    department: "R&D",
    job_title: "Principal Engineer",
    active: true,
    deactivated_at: null,
    created_at: now,
    updated_at: now,
  });
  assert.equal(resource.id, "row-1");
  assert.equal(resource.externalId, "ext-1");
  assert.equal(resource.meta.resourceType, "User");
  assert.equal(resource.meta.created, now.toISOString());
  assert.equal((resource as any)[ENTERPRISE_USER_SCHEMA].department, "R&D");
  assert.equal((resource as any).title, "Principal Engineer");
  assert.deepEqual(resource.emails, [{ value: "ada@contoso.com", type: "work", primary: true }]);
});

test("toScimUser: no email -> empty emails array; no title -> omitted", () => {
  const resource = toScimUser({
    id: "row-1",
    external_id: "ext-1",
    user_name: "ada",
    email: null,
    display_name: "Ada",
    department: null,
    job_title: null,
    active: false,
    deactivated_at: null,
    created_at: now,
    updated_at: now,
  });
  assert.deepEqual(resource.emails, []);
  assert.equal("title" in resource, false);
  assert.equal(resource.active, false);
});

test("toScimGroup: members shaped as {value: id}", () => {
  const resource = toScimGroup(
    { id: "grp-1", external_id: "ext-grp", display_name: "Engineering", created_at: now, updated_at: now },
    ["user-1", "user-2"],
  );
  assert.deepEqual(resource.members, [{ value: "user-1" }, { value: "user-2" }]);
  assert.equal(resource.meta.resourceType, "Group");
});

// ── envelopes ────────────────────────────────────────────────────────────────────────────

test("scimError: shape matches the RFC 7644 error envelope", () => {
  const err = scimError(409, "duplicate", "uniqueness");
  assert.deepEqual(err, {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: "409",
    scimType: "uniqueness",
    detail: "duplicate",
  });
});

test("scimError: scimType omitted when not given", () => {
  const err = scimError(404, "not found");
  assert.equal("scimType" in err, false);
});

test("scimListResponse: empty result is totalResults 0 with an empty Resources array", () => {
  const list = scimListResponse([], 0);
  assert.equal(list.totalResults, 0);
  assert.deepEqual(list.Resources, []);
  assert.equal(list.startIndex, 1);
});
