// Unit tests for the §23 gamification rules: the fixed weights, the daily caps (5 comments and 25
// likes per UTC day, 0-point rows beyond), the level curve and progress, tier evaluation including
// multi-tier jumps, leader ties, award-key shape and the achievement copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BADGES,
  LEVELS,
  POINTS,
  achievementMessage,
  awardKey,
  badgeLabel,
  badgeProgress,
  badgeTiersReached,
  leaderBadgeLabel,
  leadersOf,
  levelFor,
  levelsReached,
  parseGamificationPreferences,
  pointsFor,
  utcDayBounds,
} from "./gamification.js";

test("weights are fixed: outcomes dominate, social activity earns 1", () => {
  assert.deepEqual(POINTS, {
    challenge_submitted: 5,
    challenge_validated: 20,
    challenge_solved: 15,
    assignment_solved: 15,
    solution_proposed: 5,
    solution_validated: 20,
    solution_implemented: 50,
    like_received: 1,
    comment_posted: 1,
    agent_connected: 0, // §25.12: a marker for Plugged In, never points
    hype_received: 3, // §26.7: three times a like, for a signal three-a-week scarce
    hype_fulfilled: 0, // §26.7: a marker for Talent Scout, never points
  });
});

test("daily caps: the first 5 comments and 25 likes of a day earn points, later ones earn 0", () => {
  assert.equal(pointsFor("comment_posted", 0), 1);
  assert.equal(pointsFor("comment_posted", 4), 1, "the fifth comment still earns");
  assert.equal(pointsFor("comment_posted", 5), 0, "the sixth is a 0-point row");
  assert.equal(pointsFor("like_received", 24), 1);
  assert.equal(pointsFor("like_received", 25), 0);
  assert.equal(pointsFor("hype_received", 9), 3, "the tenth hype of a day still earns");
  assert.equal(pointsFor("hype_received", 10), 0, "the eleventh is a 0-point row");
  assert.equal(pointsFor("hype_fulfilled", 0), 0, "the Talent Scout marker never earns");
  assert.equal(pointsFor("solution_implemented", 1000), 50, "milestones are never capped");
});

test("utcDayBounds: the cap day is the event's UTC calendar day", () => {
  const { start, end } = utcDayBounds(new Date("2026-03-04T23:59:59.999Z"));
  assert.equal(start.toISOString(), "2026-03-04T00:00:00.000Z");
  assert.equal(end.toISOString(), "2026-03-05T00:00:00.000Z");
});

test("award keys are once-per-item and name the liker for likes", () => {
  assert.equal(awardKey.solutionValidated("s1"), "solution_validated:s1");
  assert.equal(awardKey.likeReceived("challenge", "c1", "u9"), "like_received:challenge:c1:u9");
  assert.equal(awardKey.commentPosted("k"), "comment_posted:k");
});

test("level curve: ten fixed levels and progress between thresholds", () => {
  assert.equal(LEVELS.length, 10);
  assert.deepEqual(levelFor(0), { level: 1, levelName: "Newcomer", progress: 0, next: { level: 2, name: "Contributor", pointsNeeded: 25 } });
  const mid = levelFor(200);
  assert.equal(mid.level, 4);
  assert.equal(mid.levelName, "Problem Solver");
  assert.equal(mid.progress, (200 - 150) / (300 - 150));
  assert.deepEqual(mid.next, { level: 5, name: "Innovator", pointsNeeded: 100 });
  assert.equal(levelFor(25).level, 2, "a threshold is reached exactly at its value");
  assert.equal(levelFor(24).level, 1);
});

test("level 10 is the top: progress stays 1 and there is no next level", () => {
  assert.deepEqual(levelFor(2500), { level: 10, levelName: "Luminary", progress: 1, next: null });
  assert.equal(levelFor(99_999).level, 10);
});

test("levelsReached lists each level crossed, in order", () => {
  assert.deepEqual(levelsReached(20, 80), [2, 3]);
  assert.deepEqual(levelsReached(80, 80), []);
  assert.deepEqual(levelsReached(0, 5000), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("badge tiers: each tier reached is listed, so a multi-tier jump inserts all of them", () => {
  const reached = badgeTiersReached({ solution_implemented: 10, challenge_submitted: 1, like_received: 9 });
  assert.deepEqual(
    reached.filter((r) => r.badgeKey === "implementer"),
    [
      { badgeKey: "implementer", tier: 1 },
      { badgeKey: "implementer", tier: 2 },
      { badgeKey: "implementer", tier: 3 },
    ],
  );
  assert.ok(reached.some((r) => r.badgeKey === "icebreaker" && r.tier === null), "one-off badges carry no tier");
  assert.ok(!reached.some((r) => r.badgeKey === "crowd_favorite"), "9 likes is short of Bronze");
  assert.ok(!reached.some((r) => r.badgeKey === "full_circle"), "Full Circle is not count-based");
});

test("badge thresholds match the catalogue", () => {
  const t = Object.fromEntries(BADGES.map((b) => [b.key, b.thresholds]));
  assert.deepEqual(t.problem_spotter, [1, 5, 15]);
  assert.deepEqual(t.implementer, [1, 3, 10]);
  assert.deepEqual(t.crowd_favorite, [10, 50, 200]);
  assert.deepEqual(t.conversation_starter, [10, 50, 200]);
  assert.deepEqual(t.talent_scout, [1, 5, 20]);
  assert.equal(BADGES.length, 15, "the ten §23.4 badges, the four §25.12 agent badges and §26.7 Talent Scout");
});

test("badgeProgress names the next step and stops once fully earned", () => {
  const spotter = BADGES.find((b) => b.key === "problem_spotter")!;
  assert.deepEqual(badgeProgress(spotter, { challenge_validated: 3 }), { current: 3, target: 5, label: "3 of 5 challenges validated" });
  assert.equal(badgeProgress(spotter, { challenge_validated: 15 }), null);
  assert.equal(badgeProgress(BADGES.find((b) => b.key === "full_circle")!, {}), null);
});

test("leadersOf: everyone tied at the top; nobody when the top is zero", () => {
  assert.deepEqual(leadersOf([{ userId: "a", count: 3 }, { userId: "b", count: 3 }, { userId: "c", count: 2 }]), ["a", "b"]);
  assert.deepEqual(leadersOf([{ userId: "a", count: 0 }]), []);
  assert.deepEqual(leadersOf([]), []);
});

test("leader labels read as metric + window", () => {
  assert.equal(leaderBadgeLabel({ metric: "points", window: "all" }), "Points leader — all time");
  assert.equal(leaderBadgeLabel({ metric: "likes_received", window: "30d" }), "Likes received leader — last 30 days");
});

test("achievementMessage: badges with tiers, then the highest level", () => {
  assert.equal(
    achievementMessage([{ kind: "badge", badgeKey: "implementer", tier: 2 }, { kind: "level", level: 5 }]),
    "You earned Implementer (Silver) and reached level 5 — Innovator.",
  );
  assert.equal(
    achievementMessage([
      { kind: "badge", badgeKey: "implementer", tier: 1 },
      { kind: "badge", badgeKey: "implementer", tier: 3 },
      { kind: "badge", badgeKey: "icebreaker", tier: null },
      { kind: "badge", badgeKey: "full_circle", tier: null },
    ]),
    "You earned Implementer (Gold), Icebreaker and Full Circle.",
    "a multi-tier jump reads as the tier it ended on",
  );
  assert.equal(achievementMessage([{ kind: "level", level: 2 }, { kind: "level", level: 3 }]), "You reached level 3 — Explorer.");
  assert.equal(achievementMessage([]), "");
  assert.equal(badgeLabel("first_idea", null), "First Idea");
});

test("parseGamificationPreferences accepts the two booleans and refuses other types", () => {
  assert.deepEqual(parseGamificationPreferences({ gamificationPublic: false, other: 1 }), { ok: true, value: { gamificationPublic: false } });
  assert.deepEqual(parseGamificationPreferences({}), { ok: true, value: {} });
  assert.equal(parseGamificationPreferences({ notifyAchievements: "yes" }).ok, false);
});

test("§25.12: agent_connected is worth 0, and the four agent badges count via_mcp rows", () => {
  assert.equal(POINTS.agent_connected, 0);
  assert.equal(awardKey.agentConnected(), "agent_connected");
  const agentBadges = BADGES.filter((b) => b.agent).map((b) => b.key);
  assert.deepEqual(agentBadges, ["plugged_in", "co_pilot", "agent_of_change", "human_in_the_loop"]);
  for (const b of BADGES.filter((x) => x.agent)) assert.deepEqual(b.thresholds, [1], `${b.key} is one-off`);
  const keys = (counts: Parameters<typeof badgeTiersReached>[0]) => badgeTiersReached(counts).map((r) => r.badgeKey);
  assert.deepEqual(keys({ agent_connected: 1 }), ["plugged_in"]);
  // A challenge submitted in the browser earns Icebreaker only; through an agent, Co-Pilot as well.
  assert.deepEqual(keys({ challenge_submitted: 1 }), ["icebreaker"]);
  assert.deepEqual(keys({ challenge_submitted: 1, challenge_submitted_via_mcp: 1 }), ["icebreaker", "co_pilot"]);
  assert.deepEqual(keys({ solution_proposed: 1, solution_proposed_via_mcp: 1 }), ["first_idea", "agent_of_change"]);
  assert.ok(keys({ challenge_validated: 1, validated_via_mcp: 1 }).includes("human_in_the_loop"));
});
