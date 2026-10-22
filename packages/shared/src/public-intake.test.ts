// INNOBOX_SPEC.md §24: the public form's rules, the proof-of-work, the abuse decisions, the
// retention dates, the submitter e-mails, and the "External submission" author projection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildRoleSet } from "./rbac.js";
import { canSeeChallenge, challengeTargetsFor, externalAuthorLabel, isStatusRefusedForExternal, maskAuthor } from "./challenges.js";
import { finalizeRecipients } from "./social.js";
import {
  CONTACT_RETENTION_DAYS,
  MIN_SUBMIT_DELAY_MS,
  PER_ADDRESS_LIMIT,
  PLATFORM_CEILING,
  POW_TTL_MS,
  UNCONFIRMED_RETENTION_DAYS,
  acceptedEmail,
  confirmationEmail,
  contactEraseDueAt,
  declinedEmail,
  isAddressCapped,
  isEmailSyntax,
  isPlatformCeilingReached,
  normalizeEmailForCap,
  outcomeEmail,
  parsePowSolution,
  privacyNoticeSegments,
  retentionCutoffs,
  silentDrop,
  validatePrivacyNotice,
  validatePublicSubmission,
} from "./public-intake.js";
import {
  generateConfirmToken,
  hashConfirmToken,
  isConfirmTokenShape,
  issuePowChallenge,
  parsePublicIntakeKey,
  verifyPowSolution,
} from "./public-intake-pow.js";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

/** Find the secret number the way the browser does. */
function solve(salt: string, challenge: string, maxNumber: number): number {
  for (let n = 0; n <= maxNumber; n++) {
    if (createHash("sha256").update(`${salt}${n}`).digest("hex") === challenge) return n;
  }
  throw new Error("no solution");
}

// ── Proof-of-work ────────────────────────────────────────────────────────────────────────────

test("a solved challenge verifies, and reports when it was issued", () => {
  const c = issuePowChallenge(KEY, NOW, 500);
  assert.equal(c.algorithm, "SHA-256");
  assert.equal(c.maxNumber, 500);
  const number = solve(c.salt, c.challenge, c.maxNumber);
  const verdict = verifyPowSolution(KEY, { salt: c.salt, number, signature: c.signature }, NOW + 5_000, 500);
  assert.deepEqual(verdict, { ok: true, issuedAtMs: NOW });
});

test("a wrong number, a forged signature or another key fails the signature check", () => {
  const c = issuePowChallenge(KEY, NOW, 500);
  const number = solve(c.salt, c.challenge, c.maxNumber);
  const wrong = number === 0 ? 1 : number - 1;
  assert.deepEqual(verifyPowSolution(KEY, { salt: c.salt, number: wrong, signature: c.signature }, NOW, 500), { ok: false, reason: "signature" });
  assert.deepEqual(verifyPowSolution(OTHER_KEY, { salt: c.salt, number, signature: c.signature }, NOW, 500), { ok: false, reason: "signature" });
  const forged = c.signature.replace(/^./, (ch) => (ch === "0" ? "1" : "0"));
  assert.deepEqual(verifyPowSolution(KEY, { salt: c.salt, number, signature: forged }, NOW, 500), { ok: false, reason: "signature" });
});

test("a tampered salt (a later expiry) breaks the signature", () => {
  const c = issuePowChallenge(KEY, NOW, 500);
  const number = solve(c.salt, c.challenge, c.maxNumber);
  const later = c.salt.replace(/expires=\d+/, `expires=${NOW + 99 * POW_TTL_MS}`);
  assert.deepEqual(verifyPowSolution(KEY, { salt: later, number, signature: c.signature }, NOW, 500), { ok: false, reason: "signature" });
});

test("a challenge expires 10 minutes after it was issued", () => {
  const c = issuePowChallenge(KEY, NOW, 500);
  const number = solve(c.salt, c.challenge, c.maxNumber);
  const sol = { salt: c.salt, number, signature: c.signature };
  assert.equal(verifyPowSolution(KEY, sol, NOW + POW_TTL_MS - 1, 500).ok, true);
  assert.deepEqual(verifyPowSolution(KEY, sol, NOW + POW_TTL_MS, 500), { ok: false, reason: "expired" });
});

test("malformed answers are refused before any hashing", () => {
  const c = issuePowChallenge(KEY, NOW, 500);
  assert.deepEqual(verifyPowSolution(KEY, { salt: "nope", number: 1, signature: c.signature }, NOW, 500), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyPowSolution(KEY, { salt: c.salt, number: 501, signature: c.signature }, NOW, 500), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyPowSolution(KEY, { salt: c.salt, number: 1, signature: "zz" }, NOW, 500), { ok: false, reason: "malformed" });
  assert.equal(parsePowSolution(null), null);
  assert.equal(parsePowSolution({ salt: "a", number: "1", signature: "b" }), null);
  assert.equal(parsePowSolution({ salt: "a", number: -1, signature: "b" }), null);
  assert.deepEqual(parsePowSolution({ salt: "a", number: 1, signature: "b" }), { salt: "a", number: 1, signature: "b" });
});

test("two challenges never share a salt (a spent salt is the database's to refuse)", () => {
  const salts = new Set(Array.from({ length: 50 }, () => issuePowChallenge(KEY, NOW, 10).salt));
  assert.equal(salts.size, 50);
});

test("the intake key is 32 bytes of base64", () => {
  assert.equal(parsePublicIntakeKey(undefined), null);
  assert.equal(parsePublicIntakeKey(""), null);
  assert.equal(parsePublicIntakeKey(Buffer.alloc(16).toString("base64")), null);
  assert.ok(parsePublicIntakeKey(Buffer.alloc(32, 1).toString("base64")));
});

// ── The confirmation token ───────────────────────────────────────────────────────────────────

test("the confirmation token is 43 base64url characters; only its SHA-256 is stored", () => {
  const token = generateConfirmToken();
  assert.ok(isConfirmTokenShape(token));
  assert.notEqual(generateConfirmToken(), token);
  assert.equal(hashConfirmToken(token), createHash("sha256").update(token).digest("hex"));
  assert.notEqual(hashConfirmToken(token), token);
  assert.equal(isConfirmTokenShape("short"), false);
  assert.equal(isConfirmTokenShape(42), false);
});

// ── Field validation ─────────────────────────────────────────────────────────────────────────

const VALID = { title: "  A title ", description: "Text", name: "Ann", email: "ann@example.org", company: " Acme ", consent: true, website: "" };

test("a valid form is trimmed; an empty company is null", () => {
  const r = validatePublicSubmission(VALID);
  assert.deepEqual(r, { ok: true, value: { title: "A title", description: "Text", name: "Ann", email: "ann@example.org", company: "Acme", honeypot: "" } });
  const noCompany = validatePublicSubmission({ ...VALID, company: "  " });
  assert.equal(noCompany.ok && noCompany.value.company, null);
});

test("required fields, the §6.1 limits, the e-mail syntax and consent are enforced", () => {
  assert.equal(validatePublicSubmission({ ...VALID, title: "" }).ok, false);
  assert.equal(validatePublicSubmission({ ...VALID, title: "x".repeat(121) }).ok, false);
  assert.equal(validatePublicSubmission({ ...VALID, title: "x".repeat(120) }).ok, true);
  assert.equal(validatePublicSubmission({ ...VALID, description: "x".repeat(10_001) }).ok, false);
  assert.equal(validatePublicSubmission({ ...VALID, name: "x".repeat(121) }).ok, false);
  assert.equal(validatePublicSubmission({ ...VALID, company: "x".repeat(201) }).ok, false);
  assert.equal(validatePublicSubmission({ ...VALID, email: "not-an-address" }).ok, false);
  assert.equal(validatePublicSubmission({ ...VALID, consent: false }).ok, false);
  assert.equal(validatePublicSubmission({ ...VALID, consent: "true" }).ok, false);
});

test("e-mail syntax", () => {
  for (const ok of ["a@b.co", "first.last+tag@sub.example.org"]) assert.ok(isEmailSyntax(ok), ok);
  for (const bad of ["", "a@b", "a b@c.de", "a@@b.de", "<a@b.de>", "a@b..de", `${"x".repeat(250)}@b.de`]) assert.equal(isEmailSyntax(bad), false, bad);
});

// ── Abuse decisions ──────────────────────────────────────────────────────────────────────────

test("a filled honeypot or a too-fast answer is dropped silently", () => {
  assert.equal(silentDrop({ honeypot: "http://spam", issuedAtMs: NOW, nowMs: NOW + 60_000 }), "honeypot");
  assert.equal(silentDrop({ honeypot: "", issuedAtMs: NOW, nowMs: NOW + MIN_SUBMIT_DELAY_MS - 1 }), "too_fast");
  assert.equal(silentDrop({ honeypot: "  ", issuedAtMs: NOW, nowMs: NOW + MIN_SUBMIT_DELAY_MS }), null);
});

test("the per-address cap is 3 in 24 hours and the platform ceiling 100 an hour", () => {
  assert.equal(PER_ADDRESS_LIMIT, 3);
  assert.equal(isAddressCapped(2), false);
  assert.equal(isAddressCapped(3), true);
  assert.equal(PLATFORM_CEILING, 100);
  assert.equal(isPlatformCeilingReached(99), false);
  assert.equal(isPlatformCeilingReached(100), true);
  assert.equal(normalizeEmailForCap(" Ann@Example.ORG "), "ann@example.org");
});

// ── Retention ────────────────────────────────────────────────────────────────────────────────

test("retention: unconfirmed after 7 days, contact details 90 days after closure", () => {
  const now = new Date(NOW);
  const day = 24 * 60 * 60 * 1000;
  const cut = retentionCutoffs(now);
  assert.equal(now.getTime() - cut.unconfirmedBefore.getTime(), UNCONFIRMED_RETENTION_DAYS * day);
  assert.equal(now.getTime() - cut.declinedBefore.getTime(), CONTACT_RETENTION_DAYS * day);
  assert.equal(contactEraseDueAt(now).getTime() - now.getTime(), 90 * day);
});

// ── Privacy notice ───────────────────────────────────────────────────────────────────────────

test("the notice is at most 4 000 characters", () => {
  assert.deepEqual(validatePrivacyNotice("  Hi  "), { ok: true, value: "Hi" });
  assert.equal(validatePrivacyNotice("x".repeat(4_001)).ok, false);
  assert.equal(validatePrivacyNotice(3).ok, false);
});

test("only https URLs become links; trailing punctuation stays text", () => {
  assert.deepEqual(privacyNoticeSegments("Read https://example.org/privacy. Or http://plain.example and <b>x</b>"), [
    { kind: "text", text: "Read " },
    { kind: "link", href: "https://example.org/privacy" },
    { kind: "text", text: ". Or http://plain.example and <b>x</b>" },
  ]);
  assert.deepEqual(privacyNoticeSegments("No links"), [{ kind: "text", text: "No links" }]);
  assert.deepEqual(privacyNoticeSegments(""), []);
});

// ── E-mails ──────────────────────────────────────────────────────────────────────────────────

test("the confirmation e-mail carries nothing the submitter wrote, and the token only in a fragment", () => {
  const mail = confirmationEmail("TOKEN_abc");
  assert.equal(mail.subject, "Confirm your submission");
  assert.equal(mail.link, "/submit/confirm#TOKEN_abc");
  assert.ok(!mail.message.includes("TOKEN_abc"));
  assert.match(mail.message, /ignore this e-mail/);
});

test("the decision and outcome e-mails quote the title as submitted and link nowhere", () => {
  const accepted = acceptedEmail("My idea");
  assert.equal(accepted.subject, "Your submission is under review");
  assert.match(accepted.message, /"My idea"/);
  assert.equal(accepted.link, "");
  assert.equal(declinedEmail("My idea", null).message.includes("note"), false);
  assert.match(declinedEmail("My idea", "Out of scope").message, /Out of scope/);
  assert.equal(declinedEmail("x", null).subject, "About your submission");
  assert.equal(outcomeEmail("x", "solved").subject, "Your submission has been solved");
  assert.equal(outcomeEmail("x", "rejected").subject, "An update on your submission");
  for (const m of [accepted, declinedEmail("x", "n"), outcomeEmail("x", "solved"), outcomeEmail("x", "rejected")]) {
    assert.equal(m.link, "");
    assert.ok(!/https?:\/\//.test(m.message));
  }
});

// ── The external author ──────────────────────────────────────────────────────────────────────

test("an authorless challenge reads External submission, with the company when given", () => {
  assert.equal(externalAuthorLabel(null), "External submission");
  assert.equal(externalAuthorLabel(" Acme "), "External submission · Acme");
  assert.deepEqual(maskAuthor({ isAnonymous: false, authorId: null, authorDisplayName: null, externalCompany: "Acme" }), {
    userId: null,
    displayName: "External submission · Acme",
    anonymous: false,
    external: true,
  });
  // A real author is unchanged and never marked external.
  const real = maskAuthor({ isAnonymous: false, authorId: "u1", authorDisplayName: "Ann" });
  assert.equal(real.external, undefined);
  assert.equal(real.displayName, "Ann");
});

test("needs_improvement is refused for an external challenge, for every role", () => {
  assert.equal(isStatusRefusedForExternal("needs_improvement"), true);
  assert.equal(isStatusRefusedForExternal("in_review"), false);
  assert.ok(challengeTargetsFor("in_review", false).includes("needs_improvement"));
  assert.ok(!challengeTargetsFor("in_review", true).includes("needs_improvement"));
  assert.ok(challengeTargetsFor("in_review", true).includes("valid"));
});

test("an authorless challenge has no author recipient and no author viewer", () => {
  assert.deepEqual(finalizeRecipients([null, "a", undefined, "a", "b"], "b"), ["a"]);
  const GLOBAL = "00000000-0000-0000-0000-000000000001";
  const someone = { userId: "u1", roles: buildRoleSet([], { globalNamespaceId: GLOBAL }) };
  assert.equal(canSeeChallenge(someone, { id: "cccccccc-0000-0000-0000-000000000001", namespaceId: GLOBAL, assigneeId: null, visibility: "org", status: "awaiting_triage", authorIds: [], trashed: false }), false);
  assert.equal(canSeeChallenge(someone, { id: "cccccccc-0000-0000-0000-000000000001", namespaceId: GLOBAL, assigneeId: null, visibility: "org", status: "in_review", authorIds: [], trashed: false }), true);
});
