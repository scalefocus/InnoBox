// Hermetic unit tests for the sign-in relink decision (lib/signin-relink.ts, INNOBOX_SPEC.md §3):
// the candidate test (scim_synced, active, not scrubbed, never used, different external id), the
// exactly-one rule, no UPN claim → no attempt, the unique-index conflict detector, and the
// §14.7 `signin_upn_conflict` row shape (candidate ids only — never UPN, e-mail or oid).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUpnConflictEvent,
  decideRelink,
  isRelinkCandidate,
  isUserNameConflict,
  jitUserName,
  SIGNIN_CALLBACK_ROUTE,
  type UpnHolder,
} from "./signin-relink";

const OID = "00000000-0000-0000-0000-0000000000aa";
const UPN = "Ada.Lovelace@example.com";

const eligible: UpnHolder = {
  id: "11111111-1111-1111-1111-111111111111",
  externalId: "scim-mismatched-external-id",
  active: true,
  scimSynced: true,
  scrubbedAt: null,
  lastSeenAt: null,
};

test("an active, never-used, SCIM-written row with a different external id is a candidate", () => {
  assert.equal(isRelinkCandidate(eligible, OID), true);
});

test("each failed condition disqualifies the row", () => {
  assert.equal(isRelinkCandidate({ ...eligible, scimSynced: false }, OID), false, "JIT / reconciliation stub");
  assert.equal(isRelinkCandidate({ ...eligible, active: false }, OID), false, "deactivated");
  assert.equal(isRelinkCandidate({ ...eligible, scrubbedAt: new Date() }, OID), false, "erased");
  assert.equal(isRelinkCandidate({ ...eligible, lastSeenAt: new Date() }, OID), false, "already used (UPN reuse guard)");
  assert.equal(isRelinkCandidate({ ...eligible, externalId: OID }, OID), false, "already keyed to this oid");
});

test("exactly one candidate → relink that row from its old external id", () => {
  assert.deepEqual(decideRelink([eligible], { oid: OID, preferredUsername: UPN }), {
    action: "relink",
    userId: eligible.id,
    oldExternalId: eligible.externalId,
  });
});

test("no preferred_username claim → no relink attempt, even with an eligible holder", () => {
  assert.deepEqual(decideRelink([eligible], { oid: OID, preferredUsername: undefined }), { action: "jit" });
  assert.deepEqual(decideRelink([eligible], { oid: OID, preferredUsername: "" }), { action: "jit" });
});

test("nobody holds the UPN → JIT", () => {
  assert.deepEqual(decideRelink([], { oid: OID, preferredUsername: UPN }), { action: "jit" });
});

test("a holder the relink does not cover → JIT (never a merge)", () => {
  for (const holder of [
    { ...eligible, lastSeenAt: new Date() },
    { ...eligible, active: false },
    { ...eligible, scimSynced: false },
    { ...eligible, scrubbedAt: new Date() },
  ]) {
    assert.deepEqual(decideRelink([holder], { oid: OID, preferredUsername: UPN }), { action: "jit" });
  }
});

test("more than one candidate (defensive guard) → JIT, never a merge", () => {
  const second = { ...eligible, id: "22222222-2222-2222-2222-222222222222", externalId: "other" };
  assert.deepEqual(decideRelink([eligible, second], { oid: OID, preferredUsername: UPN }), { action: "jit" });
});

test("one candidate among non-candidate holders still relinks the candidate", () => {
  const used = { ...eligible, id: "33333333-3333-3333-3333-333333333333", lastSeenAt: new Date() };
  const d = decideRelink([used, eligible], { oid: OID, preferredUsername: UPN });
  assert.equal(d.action, "relink");
  assert.equal(d.action === "relink" && d.userId, eligible.id);
});

test("JIT user_name keeps the existing fallback chain: UPN, then e-mail, then oid", () => {
  assert.equal(jitUserName({ oid: OID, preferredUsername: UPN, email: "e@example.com" }), UPN);
  assert.equal(jitUserName({ oid: OID, preferredUsername: null, email: "e@example.com" }), "e@example.com");
  assert.equal(jitUserName({ oid: OID }), OID);
});

test("isUserNameConflict matches only the unique violation on the user_name index", () => {
  assert.equal(isUserNameConflict({ code: "23505", constraint: "users_user_name_lower_idx" }), true);
  assert.equal(isUserNameConflict({ code: "23505", constraint: "users_external_id_key" }), false);
  assert.equal(isUserNameConflict({ code: "23503", constraint: "users_user_name_lower_idx" }), false);
  assert.equal(isUserNameConflict(new Error("boom")), false);
  assert.equal(isUserNameConflict(null), false);
});

test("the refusal row: 409, signin_upn_conflict, callback route, no user, candidate ids only", () => {
  const ids = [eligible.id, "44444444-4444-4444-4444-444444444444"];
  const ev = buildUpnConflictEvent(ids);
  assert.equal(ev.status, 409);
  assert.equal(ev.errorCode, "signin_upn_conflict");
  assert.equal(ev.route, SIGNIN_CALLBACK_ROUTE);
  assert.equal(ev.route, "/api/auth/callback/[provider]");
  assert.equal(ev.path, "/api/auth/callback/azure-ad");
  assert.equal(ev.source, "web");
  assert.equal(ev.userId, null);
  assert.equal(ev.actorName, null);
  assert.equal(ev.actorEmail, null);
  for (const id of ids) assert.ok(ev.message.includes(id), "names each candidate id");
  assert.ok(!ev.message.includes("@"), "never an e-mail / UPN");
  assert.ok(!ev.message.includes("§"), "no spec reference in a surfaced string");
  assert.ok(!ev.message.includes("\n"), "one line");
});
