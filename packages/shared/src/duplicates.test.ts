// §42 Mark as duplicate (INNOBOX_SPEC.md §42.3, §42.5, §42.6, §42.9): who may mark from which status,
// the original's status and visibility rules, the note, the number parser, and every string the
// feature shows — the refusals, the banner, the comments notice, the preview and event 25's copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGE_STATUSES,
  CHALLENGE_TERMINAL_STATUSES,
  isSettableByTransition,
  isSolutionOpen,
  type ChallengeStatus,
  type ChallengeVisibility,
} from "./challenges.js";
import {
  DUPLICATE_MESSAGES,
  DUPLICATE_NOTE_MAX,
  closedAsDuplicateDigestLine,
  closedAsDuplicateMessage,
  closedAsDuplicateSubject,
  decideDuplicateActor,
  duplicateAuthorHint,
  duplicateBannerText,
  duplicateCommentsNotice,
  duplicateOfLine,
  duplicatePreviewLines,
  isOriginalStatusAllowed,
  isVisibilityPairAllowed,
  parseOriginalNumber,
  validateDuplicateNote,
} from "./duplicates.js";
import { areLikesFrozen, NOTIFICATION_TYPES } from "./social.js";
import { isDigestableEvent, renderDigest } from "./email-digest.js";
import { mergedEmail, submitterOutboxType } from "./public-intake.js";

test("duplicate is a terminal challenge status that no transition sets", () => {
  assert.ok((CHALLENGE_STATUSES as readonly string[]).includes("duplicate"));
  assert.ok(CHALLENGE_TERMINAL_STATUSES.has("duplicate"));
  assert.equal(isSettableByTransition("duplicate"), false);
  for (const s of CHALLENGE_STATUSES.filter((s) => s !== "duplicate")) assert.equal(isSettableByTransition(s), true, s);
  // §8.3: likes freeze on a duplicate like on every closed challenge.
  assert.equal(areLikesFrozen("duplicate"), true);
});

test("an open solution is any non-terminal one, proposed included", () => {
  assert.equal(isSolutionOpen("proposed"), true);
  assert.equal(isSolutionOpen("accepted_internally"), true);
  for (const s of ["implemented", "rejected", "not_selected", "withdrawn"] as const) assert.equal(isSolutionOpen(s), false, s);
});

test("decideDuplicateActor: admins from any open status, reviewers from in_review / meeting_scheduled", () => {
  const admin = (status: ChallengeStatus) => decideDuplicateActor({ status, isAdmin: true, isEnforcer: false });
  const reviewer = (status: ChallengeStatus) => decideDuplicateActor({ status, isAdmin: false, isEnforcer: true });
  for (const s of ["awaiting_triage", "in_review", "needs_improvement", "meeting_scheduled", "valid"] as const) {
    assert.deepEqual(admin(s), { allowed: true, mode: "override" }, s);
  }
  for (const s of ["solved", "rejected", "withdrawn", "duplicate"] as const) assert.deepEqual(admin(s), { allowed: false, reason: "status" }, s);
  for (const s of ["in_review", "meeting_scheduled"] as const) assert.deepEqual(reviewer(s), { allowed: true, mode: "enforced" }, s);
  for (const s of ["awaiting_triage", "needs_improvement", "valid", "solved", "rejected", "withdrawn", "duplicate"] as const) {
    assert.deepEqual(reviewer(s), { allowed: false, reason: "status" }, s);
  }
  // Both roles: the admin's wider window.
  assert.deepEqual(decideDuplicateActor({ status: "valid", isAdmin: true, isEnforcer: true }), { allowed: true, mode: "override" });
  // Nobody else; a committee member barred as an author is told why (§39.5).
  assert.deepEqual(decideDuplicateActor({ status: "in_review", isAdmin: false, isEnforcer: false }), { allowed: false, reason: "forbidden" });
  assert.deepEqual(decideDuplicateActor({ status: "in_review", isAdmin: false, isEnforcer: false, barredAsAuthor: true }), { allowed: false, reason: "own_item" });
});

test("isOriginalStatusAllowed: past triage, neither withdrawn nor a duplicate", () => {
  const allowed = CHALLENGE_STATUSES.filter(isOriginalStatusAllowed);
  assert.deepEqual(allowed, ["in_review", "needs_improvement", "meeting_scheduled", "valid", "solved", "rejected"]);
});

test("isVisibilityPairAllowed over all nine pairs — the original is at least as visible", () => {
  const vis: ChallengeVisibility[] = ["org", "namespace", "people"];
  const ns = "ns-a";
  const expected: Record<string, boolean> = {
    "org→org": true,
    "org→namespace": false,
    "org→people": false,
    "namespace→org": true,
    "namespace→namespace": true,
    "namespace→people": false,
    "people→org": true,
    "people→namespace": false,
    "people→people": false,
  };
  for (const d of vis) {
    for (const o of vis) {
      assert.equal(isVisibilityPairAllowed({ visibility: d, namespaceId: ns }, { visibility: o, namespaceId: ns }), expected[`${d}→${o}`], `${d}→${o}`);
    }
  }
  // namespace-only in ANOTHER namespace is refused.
  assert.equal(isVisibilityPairAllowed({ visibility: "namespace", namespaceId: "a" }, { visibility: "namespace", namespaceId: "b" }), false);
  // An org original serves any duplicate, across namespaces.
  assert.equal(isVisibilityPairAllowed({ visibility: "namespace", namespaceId: "a" }, { visibility: "org", namespaceId: "b" }), true);
});

test("validateDuplicateNote: optional, trimmed, at most 500", () => {
  assert.deepEqual(validateDuplicateNote(undefined), { ok: true, value: null });
  assert.deepEqual(validateDuplicateNote(null), { ok: true, value: null });
  assert.deepEqual(validateDuplicateNote("   "), { ok: true, value: null });
  assert.deepEqual(validateDuplicateNote("  same problem  "), { ok: true, value: "same problem" });
  assert.deepEqual(validateDuplicateNote("x".repeat(DUPLICATE_NOTE_MAX)), { ok: true, value: "x".repeat(DUPLICATE_NOTE_MAX) });
  assert.deepEqual(validateDuplicateNote("x".repeat(DUPLICATE_NOTE_MAX + 1)), { ok: false, error: DUPLICATE_MESSAGES.noteTooLong });
  assert.equal(validateDuplicateNote(42).ok, false);
});

test("parseOriginalNumber accepts CH-12, ch-12, 12 and a number; refuses the rest", () => {
  assert.equal(parseOriginalNumber("CH-12"), "12");
  assert.equal(parseOriginalNumber("ch-12"), "12");
  assert.equal(parseOriginalNumber(" 12 "), "12");
  assert.equal(parseOriginalNumber(12), "12");
  assert.equal(parseOriginalNumber("CH-007"), "7");
  for (const bad of ["", "SOL-12", "12a", "CH-", null, undefined, {}, "1".repeat(13)]) assert.equal(parseOriginalNumber(bad), null, String(bad));
});

test("refusal messages name what they may and carry no section mark", () => {
  assert.equal(DUPLICATE_MESSAGES.notFound("12"), "There is no challenge CH-12 that you can see.");
  assert.equal(DUPLICATE_MESSAGES.originalIsDuplicate("20", "10"), "CH-20 is itself a duplicate of CH-10. Choose CH-10.");
  assert.equal(DUPLICATE_MESSAGES.originalIsDuplicate("20", null), "CH-20 is itself closed as a duplicate.");
  assert.equal(DUPLICATE_MESSAGES.originalStatus("5"), "CH-5 can't be the original while it is awaiting triage or withdrawn.");
  assert.match(DUPLICATE_MESSAGES.visibility("30"), /^Everyone who can see CH-30 must be able to see the original\./);
  const all: string[] = [
    ...(Object.values(DUPLICATE_MESSAGES) as unknown[]).filter((m): m is string => typeof m === "string"),
    DUPLICATE_MESSAGES.notFound("1"),
    DUPLICATE_MESSAGES.visibility("1"),
    duplicateBannerText(null),
    duplicateCommentsNotice(null),
  ];
  for (const m of all) assert.ok(!m.includes("§"), m);
});

test("the banner, the authors' line, the comments notice and the card line — both kinds of viewer", () => {
  assert.equal(duplicateBannerText({ number: "CH-12" }), "Closed as a duplicate of CH-12");
  assert.equal(duplicateBannerText(null), "Closed as a duplicate.");
  assert.equal(duplicateAuthorHint({ number: "12" }), "Think this is a mistake? Say so on CH-12, or ask an admin to reopen this challenge.");
  assert.equal(duplicateAuthorHint(null), "Ask an admin if you think this is a mistake.");
  assert.equal(duplicateCommentsNotice({ number: "CH-12" }), "Comments are closed. The discussion continues on CH-12.");
  assert.equal(duplicateCommentsNotice(null), "Comments are closed on this challenge.");
  assert.equal(duplicateOfLine("CH-12"), "Duplicate of CH-12");
});

test("duplicatePreviewLines leaves out what has nothing to report", () => {
  const none = { followersToMove: 0, marksToCopy: 0, authorsMark: false, repointed: 0, outsideSubmitter: false, hasAuthors: false };
  assert.deepEqual(duplicatePreviewLines("CH-30", "CH-12", none), ["CH-30 closes, and so do its comments."]);
  assert.deepEqual(
    duplicatePreviewLines("CH-30", "CH-12", { followersToMove: 3, marksToCopy: 2, authorsMark: true, repointed: 1, outsideSubmitter: false, hasAuthors: true }),
    [
      "CH-30 closes, and so do its comments.",
      "3 followers will follow CH-12 instead.",
      "2 people's marks and the author's estimate will count toward CH-12's reach.",
      "The author is told where the discussion continues.",
      "1 challenge marked as a duplicate of CH-30 will point to CH-12.",
    ],
  );
  assert.deepEqual(duplicatePreviewLines("30", "12", { ...none, followersToMove: 1, authorsMark: true, outsideSubmitter: true }), [
    "CH-30 closes, and so do its comments.",
    "1 follower will follow CH-12 instead.",
    "The author's estimate will count toward CH-12's reach.",
    "The outside submitter is told their submission joins an existing challenge.",
  ]);
});

test("event 25's copy: per recipient, the original only for those who can see it", () => {
  assert.ok((NOTIFICATION_TYPES as readonly string[]).includes("closed_as_duplicate"));
  assert.equal(
    closedAsDuplicateMessage({ number: "30", original: { number: "12" }, author: true }),
    "Your challenge CH-30 was closed as a duplicate of CH-12 — the discussion continues there.",
  );
  assert.equal(closedAsDuplicateMessage({ number: "30", original: { number: "12" }, author: false }), "CH-30 was closed as a duplicate of CH-12 — the discussion continues there.");
  assert.equal(closedAsDuplicateMessage({ number: "30", original: null, author: false }), "CH-30 was closed as a duplicate.");
  assert.equal(closedAsDuplicateSubject({ number: "30", author: true }), "Your challenge CH-30 was closed as a duplicate");
  assert.equal(closedAsDuplicateSubject({ number: "30", author: false }), "CH-30 was closed as a duplicate");
  assert.equal(closedAsDuplicateDigestLine("12"), "Closed as a duplicate of CH-12");
  assert.equal(closedAsDuplicateDigestLine(null), "Closed as a duplicate");
});

test("event 25 is follower-type for the digest, never held on the authors' route", () => {
  assert.equal(isDigestableEvent(25), true);
  assert.equal(isDigestableEvent(25, true), false);
  const at = new Date("2026-11-16T08:00:00Z");
  const digest = renderDigest(
    [
      { kind: "duplicate", challengeNumber: "30", challengeTitle: "Invoices by hand", originalNumber: "12", count: 1, at },
      { kind: "duplicate", challengeNumber: "31", challengeTitle: "Hidden one", originalNumber: null, count: 1, at },
    ],
    "daily",
    "https://innobox.example",
  )!;
  assert.match(digest.text, /CH-30 — Invoices by hand\nhttps:\/\/innobox\.example\/challenges\/30\n- Closed as a duplicate of CH-12/);
  assert.match(digest.text, /CH-31 — Hidden one\nhttps:\/\/innobox\.example\/challenges\/31\n- Closed as a duplicate(\n|$)/);
});

test("the outside submitter's merge mail names no number, link or person", () => {
  const mail = mergedEmail("Manual invoice matching");
  assert.equal(mail.kind, "merged");
  assert.equal(mail.subject, "Your submission joins an existing challenge");
  assert.equal(mail.link, "");
  assert.match(mail.message, /"Manual invoice matching"/);
  assert.ok(!/CH-\d/.test(mail.message));
  assert.equal(submitterOutboxType("merged"), "public_submission_merged");
});
