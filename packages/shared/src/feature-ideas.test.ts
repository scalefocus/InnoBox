// Unit tests for the pure feature-ideas rules (INNOBOX_SPEC.md §38): the entry ids, proposal and
// published-copy validation, the Approve dialog's pre-fill, the §38.2 order, the §38.3 voter split,
// the §38.8 notification copy and recipient candidates, the §38.9 sweep plan, and the §38.10 award
// keys and Roadmapper badge.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_IDEA_TEASER_MAX,
  FEATURE_IDEA_TEXT_MAX,
  FEATURE_IDEA_TITLE_MAX,
  compareEntries,
  cutAtWord,
  entryIdOf,
  featureAvailableCandidates,
  featureAvailableNotification,
  hasInternalReference,
  ideaEntryId,
  ideaReviewedNotification,
  othersLine,
  parseEntryId,
  planTeaserSweep,
  specEntryId,
  splitVoters,
  teaserPrefill,
  titlePrefill,
  upcomingViewerOf,
  validateDecisionNote,
  validateIdeaText,
  validatePublishedCopy,
  type OrderableEntry,
} from "./feature-ideas.js";
import { BADGES, ITEMLESS_REASONS, awardKey, badgeTiersReached } from "./gamification.js";
import type { UpcomingEntry } from "./upcoming.js";

const ID = "3f2b8c1e-7d4a-4e5b-9c6d-0a1b2c3d4e5f";

test("entry ids: spec:<key> and idea:<uuid> round-trip; anything else is refused", () => {
  assert.deepEqual(parseEntryId(specEntryId("dark-mode")), { kind: "spec", key: "dark-mode" });
  assert.deepEqual(parseEntryId(ideaEntryId(ID.toUpperCase())), { kind: "idea", id: ID });
  assert.equal(entryIdOf({ kind: "idea", id: ID }), `idea:${ID}`);
  for (const bad of [undefined, 42, "", "spec:", "spec:Dark Mode", "idea:not-a-uuid", "dark-mode", `teaser:${ID}`]) {
    assert.equal(parseEntryId(bad), null, String(bad));
  }
});

test("upcomingViewerOf: platform admin, and the distinct namespaces administered", () => {
  const viewer = upcomingViewerOf({
    isPlatformAdmin: false,
    grants: [
      { role: "namespace_admin", namespaceId: "ns-1" },
      { role: "namespace_admin", namespaceId: "ns-1" },
      { role: "committee", namespaceId: "ns-2" },
    ],
  });
  assert.deepEqual(viewer, { platformAdmin: false, namespaceAdmin: ["ns-1"] });
  assert.equal(upcomingViewerOf({ isPlatformAdmin: true, grants: [] }).platformAdmin, true);
});

test("validateIdeaText: required, trimmed, capped at 1 000 characters", () => {
  assert.deepEqual(validateIdeaText("  A dark mode, please.  "), { ok: true, value: "A dark mode, please." });
  assert.equal(validateIdeaText("   ").ok, false);
  assert.equal(validateIdeaText(undefined).ok, false);
  assert.equal(validateIdeaText(12).ok, false);
  assert.equal(validateIdeaText("x".repeat(FEATURE_IDEA_TEXT_MAX)).ok, true);
  assert.equal(validateIdeaText("x".repeat(FEATURE_IDEA_TEXT_MAX + 1)).ok, false);
});

test("validatePublishedCopy: required title and teaser within their caps, a known audience, no internal references", () => {
  const ok = validatePublishedCopy({ title: " Dark mode ", teaser: " Easier on the eyes. ", audience: "everyone" });
  assert.deepEqual(ok, { ok: true, value: { title: "Dark mode", teaser: "Easier on the eyes.", audience: "everyone" } });
  assert.equal(validatePublishedCopy({ title: "", teaser: "t", audience: "everyone" }).ok, false);
  assert.equal(validatePublishedCopy({ title: "t", teaser: " ", audience: "everyone" }).ok, false);
  assert.equal(validatePublishedCopy({ title: "x".repeat(FEATURE_IDEA_TITLE_MAX + 1), teaser: "t", audience: "everyone" }).ok, false);
  assert.equal(validatePublishedCopy({ title: "x".repeat(FEATURE_IDEA_TITLE_MAX), teaser: "t", audience: "admins" }).ok, true);
  assert.equal(validatePublishedCopy({ title: "t", teaser: "x".repeat(FEATURE_IDEA_TEASER_MAX + 1), audience: "everyone" }).ok, false);
  assert.equal(validatePublishedCopy({ title: "t", teaser: "t", audience: "namespace" }).ok, false);
  assert.equal(validatePublishedCopy({ title: `See ${String.fromCharCode(0xa7)}27`, teaser: "t", audience: "everyone" }).ok, false);
  assert.equal(validatePublishedCopy({ title: "t", teaser: "Closes GAP-12", audience: "everyone" }).ok, false);
  assert.equal(validatePublishedCopy(null).ok, false);
  assert.equal(hasInternalReference("A gap in the market"), false);
});

test("validateDecisionNote: optional, trimmed, empty → null, capped", () => {
  assert.deepEqual(validateDecisionNote(undefined), { ok: true, value: null });
  assert.deepEqual(validateDecisionNote("   "), { ok: true, value: null });
  assert.deepEqual(validateDecisionNote(" Already planned. "), { ok: true, value: "Already planned." });
  assert.equal(validateDecisionNote("x".repeat(1001)).ok, false);
  assert.equal(validateDecisionNote(5).ok, false);
});

test("pre-fill: the title is the first sentence, both cut at a word boundary within their caps", () => {
  assert.equal(titlePrefill("Add a dark mode. It would help at night."), "Add a dark mode");
  assert.equal(titlePrefill("Export to CSV\nso we can report on it"), "Export to CSV");
  assert.equal(titlePrefill("Why not?"), "Why not");
  const long = "Let people subscribe to a namespace and get a weekly summary of everything that changed there";
  const title = titlePrefill(long);
  assert.ok(title.length <= FEATURE_IDEA_TITLE_MAX, title);
  assert.ok(title.endsWith("…"));
  assert.ok(!/\s…$/.test(title), "no space before the ellipsis");
  assert.ok(long.startsWith(title.slice(0, -1)), "cut at a word, never mid-word");
  const teaser = teaserPrefill("word ".repeat(100));
  assert.ok(teaser.length <= FEATURE_IDEA_TEASER_MAX);
  assert.equal(teaserPrefill("Short and\n\nsweet."), "Short and sweet.");
  assert.equal(cutAtWord("abcdefghij", 5), "abcd…", "a single long word is cut hard");
});

test("compareEntries: votes first; among equals specified teasers in hand order, then the oldest approval", () => {
  const entries: (OrderableEntry & { name: string })[] = [
    { name: "idea-new", kind: "idea", votes: 2, approvedAt: "2026-10-20T10:00:00Z" },
    { name: "spec-b", kind: "spec", votes: 2, specIndex: 1 },
    { name: "idea-old", kind: "idea", votes: 2, approvedAt: "2026-10-01T10:00:00Z" },
    { name: "top", kind: "idea", votes: 9, approvedAt: "2026-10-21T10:00:00Z" },
    { name: "spec-a", kind: "spec", votes: 2, specIndex: 0 },
    { name: "none", kind: "spec", votes: 0, specIndex: 2 },
  ];
  assert.deepEqual(
    [...entries].sort(compareEntries).map((e) => e.name),
    ["top", "spec-a", "spec-b", "idea-old", "idea-new", "none"],
  );
});

test("splitVoters: named voters in order, opted-out and erased ones counted, the viewer's own vote found", () => {
  const rows = [
    { userId: "u1", displayName: "Ana", deactivated: false, named: true },
    { userId: "me", displayName: "Me", deactivated: false, named: false },
    { userId: "u2", displayName: "Bo", deactivated: true, named: true },
    { userId: "u3", displayName: "Deleted User", deactivated: true, named: false },
  ];
  const list = splitVoters(rows, "me");
  assert.equal(list.votes, 4);
  assert.equal(list.voted, true);
  assert.deepEqual(list.voters.map((v) => v.id), ["u1", "u2"]);
  assert.equal(list.voters[1]!.deactivated, true);
  assert.equal(list.othersCount, 2);
  assert.equal(list.othersIncludesYou, true);
  const theirs = splitVoters(rows, "u1");
  assert.equal(theirs.voted, true);
  assert.equal(theirs.othersIncludesYou, false);
  assert.equal(splitVoters([], "me").voted, false);
});

test("othersLine: 'and N others', 'including you', and a bare count when nobody is named", () => {
  assert.equal(othersLine(0, false, true), "");
  assert.equal(othersLine(3, false, true), "and 3 others");
  assert.equal(othersLine(1, false, true), "and 1 other");
  assert.equal(othersLine(3, true, true), "and 3 others, including you");
  assert.equal(othersLine(2, true, false), "2 people, including you");
  assert.equal(othersLine(1, false, false), "1 person");
});

test("event 19 copy: approved and merged name the published entry; declined quotes the idea and the note; none names an admin", () => {
  const approved = ideaReviewedNotification("approved", { title: "Dark mode", teaser: "Easier at night.", text: "x" });
  assert.equal(approved.message, "Your idea is planned: Dark mode.");
  assert.equal(approved.subject, "Your feature idea is planned");
  assert.match(approved.emailText, /"Dark mode": Easier at night\./);
  assert.equal(approved.link, "/whats-new#coming-soon");

  const merged = ideaReviewedNotification("merged", { title: "Dark mode", teaser: "Easier at night.", text: "x" });
  assert.equal(merged.message, "Your idea is already planned: Dark mode.");
  assert.match(merged.emailText, /upvote was added/);

  const declined = ideaReviewedNotification("declined", { text: "word ".repeat(80), note: "Out of scope." });
  assert.equal(declined.message, "Your feature idea wasn't taken forward.");
  assert.equal(declined.subject, "Your feature idea was reviewed");
  assert.match(declined.emailText, /Note from the reviewer: Out of scope\./);
  assert.ok(declined.emailText.length < 400, "the idea is quoted as an excerpt");
  assert.equal(declined.link, "/profile");
  assert.doesNotMatch(ideaReviewedNotification("declined", { text: "x" }).emailText, /Note/);

  for (const n of [approved, merged, declined]) assert.equal(hasInternalReference(n.message + n.subject + n.emailText), false);
});

test("event 20 copy and candidates: the proposer first, voters deduplicated, the actor left out", () => {
  const proposed = featureAvailableNotification("Dark mode", "proposed");
  assert.equal(proposed.message, "Dark mode is now available. You proposed it.");
  assert.equal(proposed.subject, "Now available: Dark mode");
  assert.equal(proposed.link, "/whats-new");
  assert.match(featureAvailableNotification("Dark mode", "upvoted").message, /You upvoted it\./);

  assert.deepEqual(featureAvailableCandidates("p", ["v1", "p", "v2", "v1", "admin"], "admin"), [
    { userId: "p", relation: "proposed" },
    { userId: "v1", relation: "upvoted" },
    { userId: "v2", relation: "upvoted" },
  ]);
  assert.deepEqual(featureAvailableCandidates(null, ["v1"], null), [{ userId: "v1", relation: "upvoted" }]);
  assert.deepEqual(featureAvailableCandidates("admin", [], "admin"), []);
});

test("planTeaserSweep: live teasers upserted; a vanished key is shipped unless it was dropped", () => {
  const live: UpcomingEntry[] = [{ key: "still-here", ids: ["GAP-1"], title: "Still here (renamed)", teaser: "t", audience: "everyone" }];
  const plan = planTeaserSweep(
    [
      { key: "still-here", title: "Still here", audience: "everyone" },
      { key: "shipped-one", title: "Shipped one", audience: "admins" },
      { key: "descoped", title: "Descoped", audience: "everyone" },
    ],
    live,
    ["descoped"],
  );
  assert.deepEqual(plan.upserts, [{ key: "still-here", title: "Still here (renamed)", audience: "everyone" }]);
  assert.deepEqual(plan.shipped, [{ key: "shipped-one", title: "Shipped one", audience: "admins" }]);
  assert.deepEqual(plan.dropped, [{ key: "descoped", title: "Descoped", audience: "everyone" }]);
  const first = planTeaserSweep([], live, []);
  assert.deepEqual(first.shipped, [], "the first run, with an empty mirror, announces nothing");
});

test("awards: once-per-idea keys, item-less reasons, and Roadmapper at 1 / 3 / 10 shipped ideas", () => {
  assert.equal(awardKey.ideaApproved(ID), `idea_approved:${ID}`);
  assert.equal(awardKey.ideaShipped(ID), `idea_shipped:${ID}`);
  assert.deepEqual([...ITEMLESS_REASONS].sort(), ["agent_connected", "idea_approved", "idea_shipped"]);
  const roadmapper = BADGES.find((b) => b.key === "roadmapper")!;
  assert.equal(roadmapper.counts, "idea_shipped");
  assert.equal(roadmapper.featureIdeas, true);
  assert.deepEqual(
    badgeTiersReached({ idea_shipped: 3 }).filter((r) => r.badgeKey === "roadmapper").map((r) => r.tier),
    [1, 2],
  );
});
