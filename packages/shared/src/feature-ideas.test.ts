// Unit tests for the pure feature-ideas rules (INNOBOX_SPEC.md §38): the audiences, the entry ids,
// proposal and published-copy validation, the Approve dialog's pre-fill, the §38.2 order and the
// §38.3 re-sort and announcement, the §38.3 voter split, who may propose (§38.11) and who earns
// (§38.10), the §38.8 notification copy and recipient candidates, and the §38.10 award keys and
// Roadmapper badge.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_IDEA_TEASER_MAX,
  FEATURE_IDEA_TEXT_MAX,
  FEATURE_IDEA_TITLE_MAX,
  ENTRY_AUDIENCES,
  appliesTo,
  applyOwnVote,
  audienceViewerOf,
  canProposeFeature,
  compareEntries,
  cutAtWord,
  featureAvailableCandidates,
  featureAvailableNotification,
  hasInternalReference,
  ideaEarnsAwards,
  ideaReviewedNotification,
  isEntryAudience,
  moveAnnouncement,
  ordinal,
  othersLine,
  parseEntryId,
  sortEntries,
  splitVoters,
  teaserPrefill,
  titlePrefill,
  validateDecisionNote,
  validateIdeaText,
  validateIdeaTitle,
  validatePublishedCopy,
  type OrderableEntry,
} from "./feature-ideas.js";
import { BADGES, ITEMLESS_REASONS, awardKey, badgeTiersReached } from "./gamification.js";

const ID = "3f2b8c1e-7d4a-4e5b-9c6d-0a1b2c3d4e5f";

test("entry ids: a row's uuid, lower-cased; anything else is refused", () => {
  assert.equal(parseEntryId(ID), ID);
  assert.equal(parseEntryId(ID.toUpperCase()), ID);
  for (const bad of [undefined, 42, "", `idea:${ID}`, `spec:dark-mode`, "dark-mode", `${ID}x`]) {
    assert.equal(parseEntryId(bad), null, String(bad));
  }
});

test("audiences: a member sees everyone-entries, an admin also admin ones, a platform admin all", () => {
  const member = { platformAdmin: false, namespaceAdmin: [] };
  const nsAdmin = { platformAdmin: false, namespaceAdmin: ["ns-1"] };
  const platform = { platformAdmin: true, namespaceAdmin: [] };
  assert.deepEqual(ENTRY_AUDIENCES.filter((a) => appliesTo(a, member)), ["everyone"]);
  assert.deepEqual(ENTRY_AUDIENCES.filter((a) => appliesTo(a, nsAdmin)), ["everyone", "admins"]);
  assert.deepEqual(ENTRY_AUDIENCES.filter((a) => appliesTo(a, platform)), ["everyone", "admins", "platform_admin"]);
  assert.equal(isEntryAudience("admins"), true);
  assert.equal(isEntryAudience("namespace_admin"), false);
});

test("audienceViewerOf: platform admin, and the distinct namespaces administered", () => {
  const viewer = audienceViewerOf({
    isPlatformAdmin: false,
    grants: [
      { role: "namespace_admin", namespaceId: "ns-1" },
      { role: "namespace_admin", namespaceId: "ns-1" },
      { role: "committee", namespaceId: "ns-2" },
    ],
  });
  assert.deepEqual(viewer, { platformAdmin: false, namespaceAdmin: ["ns-1"] });
  assert.equal(audienceViewerOf({ isPlatformAdmin: true, grants: [] }).platformAdmin, true);
});

test("canProposeFeature: platform admins always; everyone else while proposals are open", () => {
  assert.equal(canProposeFeature(true, false), true);
  assert.equal(canProposeFeature(true, true), true);
  assert.equal(canProposeFeature(false, true), true);
  assert.equal(canProposeFeature(false, false), false);
});

test("ideaEarnsAwards: only a proposer someone else approved", () => {
  assert.equal(ideaEarnsAwards("p", "admin"), true);
  assert.equal(ideaEarnsAwards("admin", "admin"), false, "self-approval earns nothing");
  assert.equal(ideaEarnsAwards(null, null), false, "a seeded entry has no proposer");
  assert.equal(ideaEarnsAwards(null, "admin"), false);
  assert.equal(ideaEarnsAwards("p", null), true, "an approver erased since does not take the award away");
});

test("validateIdeaText: required, trimmed, capped at 1 000 characters", () => {
  assert.deepEqual(validateIdeaText("  A dark mode, please.  "), { ok: true, value: "A dark mode, please." });
  assert.equal(validateIdeaText("   ").ok, false);
  assert.equal(validateIdeaText(undefined).ok, false);
  assert.equal(validateIdeaText(12).ok, false);
  assert.equal(validateIdeaText("x".repeat(FEATURE_IDEA_TEXT_MAX)).ok, true);
  assert.equal(validateIdeaText("x".repeat(FEATURE_IDEA_TEXT_MAX + 1)).ok, false);
});

test("validateIdeaTitle: required, trimmed, one line, capped at the published title's 60 characters", () => {
  assert.deepEqual(validateIdeaTitle("  Dark mode  "), { ok: true, value: "Dark mode" });
  assert.equal(validateIdeaTitle("   ").ok, false);
  assert.equal(validateIdeaTitle(undefined).ok, false);
  assert.equal(validateIdeaTitle(7).ok, false);
  assert.equal(validateIdeaTitle("x".repeat(FEATURE_IDEA_TITLE_MAX)).ok, true);
  assert.equal(validateIdeaTitle("x".repeat(FEATURE_IDEA_TITLE_MAX + 1)).ok, false);
  assert.equal(validateIdeaTitle("Dark\nmode").ok, false, "a line break is refused");
  assert.equal(validateIdeaTitle("Dark\r\nmode").ok, false);
  assert.deepEqual(validateIdeaTitle("Dark mode\n"), { ok: true, value: "Dark mode" }, "a trailing break is trimmed away");
  // Never published as is, so a section mark is the Approve dialog's business, not the proposer's.
  assert.equal(validateIdeaTitle(`See ${String.fromCharCode(0xa7)}38`).ok, true);
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

test("titlePrefill never leaves a proposal untitled: a first sentence of marks alone falls back to the text", () => {
  assert.equal(titlePrefill("?! Then the rest."), "?! Then the rest.", "the text's start, cut like the teaser");
  assert.equal(titlePrefill("..."), "...");
  assert.equal(titlePrefill("!".repeat(80)), "…");
  for (const text of ["?", "...\nmore", "Add a dark mode.", "x"]) assert.notEqual(titlePrefill(text), "", text);
});

test("pre-fill stays linear on long punctuation runs — whatever a person typed", () => {
  const bang = "!".repeat(50_000);
  const started = Date.now();
  assert.equal(titlePrefill(`Ship it${bang}`), "Ship it");
  assert.equal(titlePrefill(`${bang}x`).length <= FEATURE_IDEA_TITLE_MAX, true);
  assert.ok(teaserPrefill(`word ${bang} word`).length <= FEATURE_IDEA_TEASER_MAX);
  assert.equal(titlePrefill("Wait... what? Yes."), "Wait", "an ellipsis before a space ends the sentence, as before");
  assert.ok(Date.now() - started < 1000, "no backtracking blow-up");
});

test("compareEntries: votes first; among equals the oldest approval, then the id", () => {
  const entries: (OrderableEntry & { name: string })[] = [
    { id: "e", name: "new", votes: 2, approvedAt: "2026-10-20T10:00:00.000Z" },
    { id: "b", name: "seeded-2", votes: 2, approvedAt: "2026-10-22T00:00:02.000Z" },
    { id: "d", name: "old", votes: 2, approvedAt: "2026-10-01T10:00:00.000Z" },
    { id: "f", name: "top", votes: 9, approvedAt: "2026-10-21T10:00:00.000Z" },
    { id: "z", name: "same-time-z", votes: 0, approvedAt: "2026-10-22T00:00:01.000Z" },
    { id: "a", name: "same-time-a", votes: 0, approvedAt: "2026-10-22T00:00:01.000Z" },
  ];
  assert.deepEqual(
    sortEntries(entries).map((e) => e.name),
    ["top", "old", "new", "seeded-2", "same-time-a", "same-time-z"],
  );
  assert.equal(compareEntries(entries[0]!, entries[0]!), 0);
});

test("applyOwnVote: flips the vote, moves the count by one and re-sorts; a repeat is a no-op", () => {
  const list = sortEntries([
    { id: "a", title: "A", votes: 3, voted: false, approvedAt: "2026-10-01T00:00:00.000Z" },
    { id: "b", title: "B", votes: 3, voted: false, approvedAt: "2026-10-02T00:00:00.000Z" },
    { id: "c", title: "C", votes: 1, voted: true, approvedAt: "2026-10-03T00:00:00.000Z" },
  ]);
  const up = applyOwnVote(list, "b", true);
  assert.deepEqual(up.map((e) => [e.id, e.votes, e.voted]), [["b", 4, true], ["a", 3, false], ["c", 1, true]]);
  assert.deepEqual(applyOwnVote(up, "b", true), up, "already voted: nothing changes");
  const back = applyOwnVote(up, "b", false);
  assert.deepEqual(back.map((e) => e.id), ["a", "b", "c"], "the revert restores the order");
  const down = applyOwnVote(list, "c", false);
  assert.equal(down.find((e) => e.id === "c")!.votes, 0);
  assert.equal(list[0]!.votes, 3, "the input is never mutated");
});

test("ordinal and moveAnnouncement: the voted row's new place, or nothing when it stayed", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  const before = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];
  const after = [{ id: "b", title: "B" }, { id: "a", title: "A" }, { id: "c", title: "C" }];
  assert.equal(moveAnnouncement(before, after, "b"), "B is now 1st of 3");
  assert.equal(moveAnnouncement(before, before, "b"), null);
  assert.equal(moveAnnouncement(before, after, "gone"), null);
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

test("event 19 copy: approved and merged name the published entry; declined names the idea by its own title, quotes it and the note; none names an admin", () => {
  const approved = ideaReviewedNotification("approved", { title: "Dark mode", teaser: "Easier at night.", text: "x" });
  assert.equal(approved.message, "Your idea is planned: Dark mode.");
  assert.equal(approved.subject, "Your feature idea is planned");
  assert.match(approved.emailText, /"Dark mode": Easier at night\./);
  assert.equal(approved.link, "/whats-new#coming-soon");

  const merged = ideaReviewedNotification("merged", { title: "Dark mode", teaser: "Easier at night.", text: "x" });
  assert.equal(merged.message, "Your idea is already planned: Dark mode.");
  assert.match(merged.emailText, /upvote was added/);

  const declined = ideaReviewedNotification("declined", { title: "Bigger logo", text: "word ".repeat(80), note: "Out of scope." });
  assert.equal(declined.message, "Your feature idea wasn't taken forward: Bigger logo.");
  assert.equal(declined.subject, "Your feature idea was reviewed", "the subject carries no title");
  assert.match(declined.emailText, /your feature idea "Bigger logo" and isn't taking it forward/);
  assert.match(declined.emailText, /Note from the reviewer: Out of scope\./);
  assert.ok(declined.emailText.length < 450, "the idea is quoted as an excerpt");
  assert.equal(declined.link, "/profile");
  assert.doesNotMatch(ideaReviewedNotification("declined", { title: "t", text: "x" }).emailText, /Note/);
  assert.equal(ideaReviewedNotification("declined", { text: "x" }).message, "Your feature idea wasn't taken forward.", "no title, no colon");

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

test("awards: once-per-idea keys, item-less reasons, and Roadmapper at 1 / 3 / 10 shipped ideas", () => {
  assert.equal(awardKey.ideaApproved(ID), `idea_approved:${ID}`);
  assert.equal(awardKey.ideaShipped(ID), `idea_shipped:${ID}`);
  assert.deepEqual([...ITEMLESS_REASONS].sort(), ["agent_connected", "idea_approved", "idea_shipped"]);
  const roadmapper = BADGES.find((b) => b.key === "roadmapper")!;
  assert.equal(roadmapper.counts, "idea_shipped");
  assert.equal("featureIdeas" in roadmapper, false, "Roadmapper is never hidden by the proposals switch");
  assert.deepEqual(
    badgeTiersReached({ idea_shipped: 3 }).filter((r) => r.badgeKey === "roadmapper").map((r) => r.tier),
    [1, 2],
  );
});
