// §4.3 `people` visibility and the §24.3 visibility request: the tag-field rules the /submit form
// and the admin list editor share, the request validation, and the admin's list input.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_LIST_MAX,
  ACCESS_LIST_REQUIRED,
  EMAILS_REQUIRED,
  EMAIL_TAG_INVALID,
  REQUESTED_EMAILS_MAX,
  REQUESTED_TEAMS_MAX,
  TAG_DUPLICATE,
  TEAMS_REQUIRED,
  TEAM_TAG_INVALID,
  applyPaste,
  checkEmailTag,
  checkTeamTag,
  parseAccessListInput,
  splitPastedEmails,
  splitPastedTeams,
  validateVisibilityRequest,
} from "./challenge-access.js";
import { challengeSharedMessage } from "./challenge-access-db.js";

// ── tag-field rules ──────────────────────────────────────────────────────────────────────────

test("checkEmailTag: a valid address is locked in lower-cased; an invalid one is refused", () => {
  assert.deepEqual(checkEmailTag("  Ann.Lee@Example.COM ", []), { ok: true, value: "ann.lee@example.com" });
  assert.deepEqual(checkEmailTag("ann@", []), { ok: false, error: EMAIL_TAG_INVALID });
  assert.deepEqual(checkEmailTag("not an email", []), { ok: false, error: EMAIL_TAG_INVALID });
  assert.deepEqual(checkEmailTag("", []), { ok: false, error: EMAIL_TAG_INVALID });
});

test("checkEmailTag: duplicates are compared lower-cased", () => {
  assert.deepEqual(checkEmailTag("ANN@example.com", ["ann@example.com"]), { ok: false, error: TAG_DUPLICATE });
});

test("checkTeamTag: at least 3 characters after trimming — any characters count — and at most 100", () => {
  assert.deepEqual(checkTeamTag("  QA1 ", []), { ok: true, value: "QA1" });
  assert.deepEqual(checkTeamTag("R&D", []), { ok: true, value: "R&D" });
  assert.deepEqual(checkTeamTag("Data   Platform", []), { ok: true, value: "Data Platform" });
  assert.deepEqual(checkTeamTag("  ab  ", []), { ok: false, error: TEAM_TAG_INVALID });
  assert.deepEqual(checkTeamTag("x".repeat(101), []), { ok: false, error: TEAM_TAG_INVALID });
  assert.equal(checkTeamTag("x".repeat(100), []).ok, true);
});

test("checkTeamTag: duplicates ignore case, the kept name keeps its case", () => {
  assert.deepEqual(checkTeamTag("payments", ["Payments"]), { ok: false, error: TAG_DUPLICATE });
});

test("paste splitting: e-mails split on spaces too, team names do not", () => {
  assert.deepEqual(splitPastedEmails("a@x.io, b@x.io;c@x.io\nd@x.io  e@x.io"), ["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io"]);
  assert.deepEqual(splitPastedTeams("Data Platform, Payments;\nCore Banking"), ["Data Platform", "Payments", "Core Banking"]);
});

test("applyPaste: valid parts become tags, the rest stay in the field with the first error", () => {
  const outcome = applyPaste("email", "a@x.io nope b@x.io a@x.io", [], 20);
  assert.deepEqual(outcome.added, ["a@x.io", "b@x.io"]);
  assert.equal(outcome.rest, "nope a@x.io");
  assert.equal(outcome.error, EMAIL_TAG_INVALID);
  const teams = applyPaste("team", "Payments, ab", ["Core"], 10);
  assert.deepEqual(teams.added, ["Payments"]);
  assert.equal(teams.rest, "ab");
});

test("applyPaste: never past the field's limit", () => {
  const existing = Array.from({ length: 19 }, (_, i) => `u${i}@x.io`);
  const outcome = applyPaste("email", "a@x.io b@x.io", existing, 20);
  assert.deepEqual(outcome.added, ["a@x.io"]);
  assert.equal(outcome.rest, "b@x.io");
  assert.match(outcome.error ?? "", /At most 20/);
});

// ── the visibility request (§24.3, §24.9) ────────────────────────────────────────────────────

test("validateVisibilityRequest: absent means everyone in the organization", () => {
  assert.deepEqual(validateVisibilityRequest({}), { ok: true, value: { visibility: "org", emails: [], teams: [] } });
});

test("validateVisibilityRequest: people needs 1–20 valid addresses, deduplicated lower-cased", () => {
  assert.deepEqual(validateVisibilityRequest({ visibility: "people", emails: ["A@x.io", "b@x.io"] }), {
    ok: true,
    value: { visibility: "people", emails: ["a@x.io", "b@x.io"], teams: [] },
  });
  assert.deepEqual(validateVisibilityRequest({ visibility: "people", emails: [] }), { ok: false, error: EMAILS_REQUIRED });
  assert.deepEqual(validateVisibilityRequest({ visibility: "people", emails: ["bad"] }), { ok: false, error: EMAIL_TAG_INVALID });
  assert.equal(validateVisibilityRequest({ visibility: "people", emails: ["a@x.io", "A@X.io"] }).ok, false);
  const many = Array.from({ length: REQUESTED_EMAILS_MAX + 1 }, (_, i) => `u${i}@x.io`);
  assert.equal(validateVisibilityRequest({ visibility: "people", emails: many }).ok, false);
});

test("validateVisibilityRequest: teams needs 1–10 names of at least 3 characters", () => {
  assert.deepEqual(validateVisibilityRequest({ visibility: "teams", teams: [" Payments ", "R&D"] }), {
    ok: true,
    value: { visibility: "teams", emails: [], teams: ["Payments", "R&D"] },
  });
  assert.deepEqual(validateVisibilityRequest({ visibility: "teams" }), { ok: false, error: TEAMS_REQUIRED });
  assert.deepEqual(validateVisibilityRequest({ visibility: "teams", teams: ["QA"] }), { ok: false, error: TEAM_TAG_INVALID });
  const many = Array.from({ length: REQUESTED_TEAMS_MAX + 1 }, (_, i) => `Team ${i}`);
  assert.equal(validateVisibilityRequest({ visibility: "teams", teams: many }).ok, false);
});

test("validateVisibilityRequest: the other option's list must be absent or empty, and the value known", () => {
  assert.equal(validateVisibilityRequest({ visibility: "org", emails: ["a@x.io"] }).ok, false);
  assert.equal(validateVisibilityRequest({ visibility: "people", emails: ["a@x.io"], teams: ["Payments"] }).ok, false);
  assert.equal(validateVisibilityRequest({ visibility: "teams", teams: ["Payments"], emails: [] }).ok, true);
  assert.equal(validateVisibilityRequest({ visibility: "namespace" }).ok, false);
  assert.equal(validateVisibilityRequest({ visibility: "people", emails: "a@x.io" }).ok, false);
});

// ── the admin's list (§4.3, §16) ─────────────────────────────────────────────────────────────

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

test("parseAccessListInput: users and addresses, deduplicated, 1–100 in all", () => {
  assert.deepEqual(parseAccessListInput({ userIds: [U1, U1.toUpperCase(), U2], emails: ["New@x.io", "new@x.io"] }), {
    ok: true,
    value: { userIds: [U1, U2], emails: ["new@x.io"] },
  });
  assert.deepEqual(parseAccessListInput({ userIds: [], emails: [] }), { ok: false, error: ACCESS_LIST_REQUIRED });
  assert.deepEqual(parseAccessListInput(null), { ok: false, error: ACCESS_LIST_REQUIRED });
  assert.equal(parseAccessListInput({ userIds: ["not-a-uuid"] }).ok, false);
  assert.equal(parseAccessListInput({ emails: ["nope"] }).ok, false);
  const tooMany = Array.from({ length: ACCESS_LIST_MAX + 1 }, (_, i) => `u${i}@x.io`);
  assert.equal(parseAccessListInput({ emails: tooMany }).ok, false);
  assert.equal(parseAccessListInput({ emails: tooMany.slice(0, ACCESS_LIST_MAX) }).ok, true);
});

// ── event 15 (§12.1) ─────────────────────────────────────────────────────────────────────────

test("challengeSharedMessage: number, title and the masked author — never who shared it", () => {
  assert.equal(
    challengeSharedMessage({ number: "42", title: "Faster onboarding", author: "Anonymous" }),
    'CH-42 "Faster onboarding" (submitted by Anonymous) has been shared with you.',
  );
});
