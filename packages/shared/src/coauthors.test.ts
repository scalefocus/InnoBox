// §39 co-author rules (INNOBOX_SPEC.md §39.2–§39.9, §39.13): the joining window, the parsers, the
// team-change decision in its refusal order, the committee bar, the masked team and its compact and
// text forms, the join replay set and the leaderboard's contribution time — plus the eligibility
// matrix the pickers and the team endpoints share (canJoinChallengeTeam / canSeeChallenge).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoleSet } from "./rbac.js";
import { CHALLENGE_STATUSES, SOLUTION_STATUSES, canJoinChallengeTeam, canSeeChallenge, canSeeSolution, decideTransition, maskAuthor } from "./challenges.js";
import type { ChallengeVisibilityInput } from "./challenges.js";
import {
  CO_AUTHORS_MAX,
  TEAM_MAX,
  TEAM_MESSAGES,
  TEAM_REFUSAL_MESSAGE,
  TEAM_REFUSAL_STATUS,
  contributionTime,
  decideTeamChange,
  isBarredAsAuthor,
  isJoiningOpen,
  isReviewEnforcer,
  joinReplayReasons,
  maskTeam,
  parseBaseEditedAt,
  parseCoAuthorIds,
  teamAriaLabel,
  teamChangeMessage,
  teamCsvCell,
  teamText,
} from "./coauthors.js";

const GLOBAL = "00000000-0000-0000-0000-000000000001";
const NS = "aaaaaaaa-0000-0000-0000-000000000001";
const CREATOR = "11111111-0000-4000-8000-000000000001";
const MEMBER = "22222222-0000-4000-8000-000000000002";
const OTHER = "33333333-0000-4000-8000-000000000003";
const CH = "cccccccc-0000-0000-0000-000000000001";

function viewer(userId: string, grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[] = [], access: string[] = []) {
  return { userId, roles: buildRoleSet(grants, { globalNamespaceId: GLOBAL, accessListChallengeIds: access }) };
}

test("the cap is the creator plus four", () => {
  assert.equal(TEAM_MAX, 5);
  assert.equal(CO_AUTHORS_MAX, 4);
});

test("isJoiningOpen: a solution until it moves past valid, a challenge in any non-terminal status", () => {
  const solutionOpen = new Set(["proposed", "in_review", "needs_improvement", "valid"]);
  for (const s of SOLUTION_STATUSES) assert.equal(isJoiningOpen("solution", s), solutionOpen.has(s), s);
  const challengeOpen = new Set(["awaiting_triage", "in_review", "needs_improvement", "meeting_scheduled", "valid"]);
  for (const s of CHALLENGE_STATUSES) assert.equal(isJoiningOpen("challenge", s), challengeOpen.has(s), s);
});

test("parseCoAuthorIds: absent is none; at most four distinct user ids, never the caller", () => {
  assert.deepEqual(parseCoAuthorIds(undefined, CREATOR), { ok: true, value: [] });
  assert.deepEqual(parseCoAuthorIds(null, CREATOR), { ok: true, value: [] });
  assert.deepEqual(parseCoAuthorIds([MEMBER.toUpperCase()], CREATOR), { ok: true, value: [MEMBER] });
  assert.equal(parseCoAuthorIds("x", CREATOR).ok, false);
  assert.equal(parseCoAuthorIds(["not-a-uuid"], CREATOR).ok, false);
  assert.equal(parseCoAuthorIds([MEMBER, MEMBER], CREATOR).ok, false, "no repeats");
  assert.equal(parseCoAuthorIds([MEMBER, CREATOR], CREATOR).ok, false, "never the caller");
  const five = ["1", "2", "3", "4", "5"].map((n) => `4444444${n}-0000-4000-8000-000000000000`);
  assert.equal(parseCoAuthorIds(five.slice(0, 4), CREATOR).ok, true);
  assert.equal(parseCoAuthorIds(five, CREATOR).ok, false, "over four");
});

test("parseBaseEditedAt: null for a never-edited item, an ISO time otherwise; absent is refused", () => {
  assert.deepEqual(parseBaseEditedAt(null), { ok: true, value: null });
  assert.deepEqual(parseBaseEditedAt("2026-10-22T10:00:00.123Z"), { ok: true, value: "2026-10-22T10:00:00.123Z" });
  assert.equal(parseBaseEditedAt(undefined).ok, false);
  assert.equal(parseBaseEditedAt("").ok, false);
  assert.equal(parseBaseEditedAt("yesterday").ok, false);
});

const base = { callerIsMember: true, isAnonymous: false, joiningOpen: true, teamSize: 2 };

test("decideTeamChange: 403 for a non-member comes before every 409 and 422", () => {
  for (const change of [{ op: "add", eligible: false }, { op: "remove", targetIsCreator: true, targetErased: false }, { op: "leave" }] as const) {
    assert.deepEqual(decideTeamChange({ ...base, callerIsMember: false, isAnonymous: true, joiningOpen: false, teamSize: 1, change }), {
      ok: false,
      refusal: "not_member",
    });
  }
});

test("decideTeamChange: adds — anonymous, then the window, then the cap, then eligibility", () => {
  const add = (over: Partial<typeof base>, eligible = true) => decideTeamChange({ ...base, ...over, change: { op: "add", eligible } });
  assert.deepEqual(add({ isAnonymous: true, joiningOpen: false, teamSize: 5 }, false), { ok: false, refusal: "anonymous" });
  assert.deepEqual(add({ joiningOpen: false, teamSize: 5 }, false), { ok: false, refusal: "closed" });
  // The cap counts every row, a "Deleted User" one included — the caller passes the row count.
  assert.deepEqual(add({ teamSize: 5 }, false), { ok: false, refusal: "full" });
  assert.deepEqual(add({ teamSize: 4 }, false), { ok: false, refusal: "ineligible" });
  assert.deepEqual(add({ teamSize: 4 }), { ok: true });
});

test("decideTeamChange: removing someone else — the window, then the creator's protection until erased", () => {
  const remove = (over: Partial<typeof base>, targetIsCreator: boolean, targetErased = false) =>
    decideTeamChange({ ...base, ...over, change: { op: "remove", targetIsCreator, targetErased } });
  assert.deepEqual(remove({ joiningOpen: false }, false), { ok: false, refusal: "closed" });
  assert.deepEqual(remove({}, true), { ok: false, refusal: "creator" });
  assert.deepEqual(remove({}, true, true), { ok: true }, "an erased creator's row can be removed");
  assert.deepEqual(remove({}, false), { ok: true });
});

test("decideTeamChange: leaving works in any status, unless you are the only member", () => {
  assert.deepEqual(decideTeamChange({ ...base, joiningOpen: false, change: { op: "leave" } }), { ok: true });
  assert.deepEqual(decideTeamChange({ ...base, teamSize: 1, change: { op: "leave" } }), { ok: false, refusal: "last_member" });
});

test("refusals map to 403 / 409 / 422 with the spec's messages", () => {
  assert.equal(TEAM_REFUSAL_STATUS.not_member, 403);
  for (const r of ["anonymous", "closed", "full", "creator", "last_member"] as const) assert.equal(TEAM_REFUSAL_STATUS[r], 409, r);
  assert.equal(TEAM_REFUSAL_STATUS.ineligible, 422);
  assert.equal(TEAM_REFUSAL_MESSAGE.full, "A team can have at most five people.");
  assert.equal(TEAM_REFUSAL_MESSAGE.creator, "The creator can only leave on their own.");
  assert.equal(TEAM_REFUSAL_MESSAGE.last_member, "You're the only author, so you can't leave.");
  assert.equal(TEAM_REFUSAL_MESSAGE.anonymous, "Anonymous items can't have co-authors. Reveal yourself as the author first.");
  assert.equal(TEAM_MESSAGES.anonymousCreate, "Anonymous items can't have co-authors.");
});

test("the committee bar: a committee member never reviews an item they are an author of; the assignee role is unaffected", () => {
  const cases: [boolean, boolean, boolean, boolean, boolean][] = [
    // isCommittee, isAssignee, isAuthor → enforcer, barred
    [true, false, false, true, false],
    [true, false, true, false, true],
    [true, true, true, true, false],
    [false, true, true, true, false],
    [false, false, true, false, false],
    [false, false, false, false, false],
  ];
  for (const [isCommittee, isAssignee, isAuthor, enforcer, barred] of cases) {
    const roles = { isCommittee, isAssignee, isAuthor };
    assert.equal(isReviewEnforcer(roles), enforcer, JSON.stringify(roles));
    assert.equal(isBarredAsAuthor(roles), barred, JSON.stringify(roles));
  }
  assert.deepEqual(decideTransition({ from: "in_review", to: "valid", isAdmin: false, isEnforcer: false, isLegalArrow: true, barredAsAuthor: true }), {
    allowed: false,
    reason: "own_item",
  });
  assert.deepEqual(decideTransition({ from: "in_review", to: "valid", isAdmin: false, isEnforcer: false, isLegalArrow: true }), { allowed: false, reason: "forbidden" });
  assert.equal(decideTransition({ from: "in_review", to: "valid", isAdmin: true, isEnforcer: false, isLegalArrow: true, barredAsAuthor: true }).allowed, true, "an admin overrides");
});

const members = [
  { id: CREATOR, displayName: "Ana Petrova", active: true, scrubbed: false, creator: true },
  { id: MEMBER, displayName: "Ben Ode", active: false, scrubbed: false, creator: false },
  { id: OTHER, displayName: "Deleted User", active: false, scrubbed: true, creator: false },
];

test("maskTeam: an anonymous or external item is its single masked shape whatever its rows say", () => {
  const anon = maskAuthor({ isAnonymous: true, authorId: CREATOR, authorDisplayName: "Ana Petrova" });
  assert.deepEqual(maskTeam(anon, members), [anon]);
  assert.ok(!JSON.stringify(maskTeam(anon, members)).includes(CREATOR), "no member id leaks");
  const external = maskAuthor({ isAnonymous: false, authorId: null, authorDisplayName: null, externalCompany: "Acme" });
  assert.deepEqual(maskTeam(external, []), [external]);
});

test("maskTeam: a named team in order, account states carried, the creator flag only when asked", () => {
  const named = maskAuthor({ isAnonymous: false, authorId: CREATOR, authorDisplayName: "Ana Petrova" });
  const team = maskTeam(named, members);
  assert.deepEqual(
    team.map((a) => [a.userId, a.displayName, a.active, a.scrubbed]),
    [
      [CREATOR, "Ana Petrova", true, false],
      [MEMBER, "Ben Ode", false, false],
      [OTHER, "Deleted User", false, true],
    ],
  );
  assert.ok(team.every((a) => !("creator" in a)));
  assert.deepEqual(
    maskTeam(named, members, { creatorFlag: true }).map((a) => a.creator),
    [true, false, false],
  );
  assert.deepEqual(maskTeam(named, []), [named], "no rows falls back to the single author");
});

test("the compact form's aria-label, the text surfaces' line and the CSV cell", () => {
  const one = [{ displayName: "Ana Petrova" }];
  const three = [{ displayName: "Ana Petrova" }, { displayName: "Ben Ode" }, { displayName: "Cara Lim" }];
  assert.equal(teamAriaLabel(one), "Ana Petrova");
  assert.equal(teamAriaLabel(three.slice(0, 2)), "Ana Petrova and 1 co-author");
  assert.equal(teamAriaLabel(three), "Ana Petrova and 2 co-authors");
  assert.equal(teamText(one), "Ana Petrova");
  assert.equal(teamText(three.slice(0, 2)), "Ana Petrova and 1 other");
  assert.equal(teamText(three), "Ana Petrova and 2 others");
  assert.equal(teamCsvCell(three), "Ana Petrova; Ben Ode; Cara Lim");
});

test("event 21's line names the actor, the change and the item", () => {
  assert.equal(teamChangeMessage("Ana Petrova", "added", "SOL-34"), "Ana Petrova added you as a co-author of SOL-34");
  assert.equal(teamChangeMessage("Ana Petrova", "removed", "CH-12"), "Ana Petrova removed you as a co-author of CH-12");
});

test("joinReplayReasons: the submit/propose award, plus validated once reached — never solved or implemented", () => {
  assert.deepEqual(joinReplayReasons("challenge", { validated: false }), ["challenge_submitted"]);
  assert.deepEqual(joinReplayReasons("challenge", { validated: true }), ["challenge_submitted", "challenge_validated"]);
  assert.deepEqual(joinReplayReasons("solution", { validated: false }), ["solution_proposed"]);
  assert.deepEqual(joinReplayReasons("solution", { validated: true }), ["solution_proposed", "solution_validated"]);
});

test("contributionTime: the later of the event and the join", () => {
  const event = new Date("2026-10-01T00:00:00Z");
  const join = new Date("2026-10-10T00:00:00Z");
  assert.equal(contributionTime(event, join), join);
  assert.equal(contributionTime(join, event), join);
});

// ── Eligibility (§39.2) ─────────────────────────────────────────────────────────────────────

function challengeOf(visibility: ChallengeVisibilityInput["visibility"], status: ChallengeVisibilityInput["status"]): ChallengeVisibilityInput {
  return { id: CH, namespaceId: NS, visibility, status, assigneeId: null, authorIds: [CREATOR], trashed: false };
}

test("canJoinChallengeTeam: the visibility rule judged without the awaiting_triage state rule", () => {
  const outsider = viewer(OTHER);
  const nsMember = viewer(OTHER, [{ role: "member", namespaceId: NS }]);
  const onList = viewer(OTHER, [], [CH]);
  const committee = viewer(OTHER, [{ role: "committee", namespaceId: NS }]);
  const platform = viewer(OTHER, [{ role: "platform_admin", namespaceId: null }]);
  for (const status of ["awaiting_triage", "valid"] as const) {
    assert.equal(canJoinChallengeTeam(outsider, challengeOf("org", status)), true, `org ${status}: anyone`);
    assert.equal(canJoinChallengeTeam(outsider, challengeOf("namespace", status)), false, `namespace ${status}: not an outsider`);
    assert.equal(canJoinChallengeTeam(nsMember, challengeOf("namespace", status)), true, `namespace ${status}: a member`);
    assert.equal(canJoinChallengeTeam(platform, challengeOf("namespace", status)), true, `namespace ${status}: a platform admin`);
    assert.equal(canJoinChallengeTeam(nsMember, challengeOf("people", status)), false, `people ${status}: membership alone is not enough`);
    assert.equal(canJoinChallengeTeam(onList, challengeOf("people", status)), true, `people ${status}: the access list`);
    assert.equal(canJoinChallengeTeam(committee, challengeOf("people", status)), true, `people ${status}: the committee`);
  }
  // …whereas seeing it under the full predicate needs the state rule: in triage, only its authors and admins.
  assert.equal(canSeeChallenge(viewer(OTHER), challengeOf("org", "awaiting_triage")), false);
});

test("a solution's team is joined by whoever can see its parent under the full §4.3 predicate", () => {
  const nsMember = viewer(OTHER, [{ role: "member", namespaceId: NS }]);
  assert.equal(canSeeChallenge(nsMember, challengeOf("namespace", "valid")), true);
  assert.equal(canSeeChallenge(viewer(OTHER), challengeOf("namespace", "valid")), false);
  assert.equal(canSeeChallenge(viewer(OTHER), { ...challengeOf("org", "withdrawn") }), false, "a withdrawn parent: its authors and admins only");
});

test("every member sees a team's awaiting_triage challenge and proposed solution; leaving takes that away", () => {
  const triage = { ...challengeOf("namespace", "awaiting_triage"), authorIds: [CREATOR, MEMBER] };
  assert.equal(canSeeChallenge(viewer(MEMBER), triage), true, "a member who is not even in the namespace");
  assert.equal(canSeeChallenge(viewer(MEMBER), { ...triage, authorIds: [CREATOR] }), false, "after leaving");
  const proposed = { status: "proposed" as const, authorIds: [CREATOR, MEMBER], trashed: false };
  assert.equal(canSeeSolution(viewer(MEMBER), { namespaceId: NS, assigneeId: null }, proposed), true);
  assert.equal(canSeeSolution(viewer(OTHER), { namespaceId: NS, assigneeId: null }, proposed), false);
});
