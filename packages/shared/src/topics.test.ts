// §34 topic rules (INNOBOX_SPEC.md §34.2, §34.3, §34.5, §34.9): the field limits, the tagging
// rules, the bulk outcomes and the event-18 copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOPICS_PER_CHALLENGE_MAX,
  TOPIC_SET_ERROR,
  bulkTopicChange,
  checkTopicSet,
  parseTopicIds,
  topicDiff,
  topicDigestLine,
  topicListLabel,
  topicNoticeFootnote,
  topicNoticeMessage,
  topicNoticeSubject,
  validateTopicDescription,
  validateTopicName,
} from "./topics.js";

const A = "0b6a4a5e-0000-4000-8000-00000000000a";
const B = "0b6a4a5e-0000-4000-8000-00000000000b";
const C = "0b6a4a5e-0000-4000-8000-00000000000c";
const D = "0b6a4a5e-0000-4000-8000-00000000000d";
const R = "0b6a4a5e-0000-4000-8000-0000000000ff"; // retired

test("validateTopicName trims, collapses inner whitespace and caps at 40", () => {
  assert.deepEqual(validateTopicName("  Customer   onboarding "), { ok: true, value: "Customer onboarding" });
  assert.equal(validateTopicName("").ok, false);
  assert.equal(validateTopicName("   ").ok, false);
  assert.equal(validateTopicName(42).ok, false);
  assert.equal(validateTopicName("x".repeat(40)).ok, true);
  assert.equal(validateTopicName("x".repeat(41)).ok, false);
});

test("validateTopicDescription: optional, empty is none, at most 200", () => {
  assert.deepEqual(validateTopicDescription(undefined), { ok: true, value: null });
  assert.deepEqual(validateTopicDescription(null), { ok: true, value: null });
  assert.deepEqual(validateTopicDescription("  "), { ok: true, value: null });
  assert.deepEqual(validateTopicDescription(" Machine learning "), { ok: true, value: "Machine learning" });
  assert.equal(validateTopicDescription("x".repeat(200)).ok, true);
  assert.equal(validateTopicDescription("x".repeat(201)).ok, false);
  assert.equal(validateTopicDescription(7).ok, false);
});

test("parseTopicIds: an array of distinct ids, at most three", () => {
  assert.deepEqual(parseTopicIds([]), { ok: true, value: [] });
  assert.deepEqual(parseTopicIds([A, B.toUpperCase()]), { ok: true, value: [A, B] });
  assert.equal(parseTopicIds("x").ok, false);
  assert.equal(parseTopicIds(["not-a-uuid"]).ok, false);
  assert.equal(parseTopicIds([A, A]).ok, false);
  assert.deepEqual(parseTopicIds([A, B, C, D]), { ok: false, error: TOPIC_SET_ERROR.too_many });
});

test("checkTopicSet: the cap, unknown ids, and adding only active topics", () => {
  const known = new Map([
    [A, { active: true }],
    [B, { active: true }],
    [C, { active: true }],
    [D, { active: true }],
    [R, { active: false }],
  ]);
  assert.equal(checkTopicSet([A, B, C], [], known), null);
  assert.equal(checkTopicSet([A, B, C, D], [], known), "too_many");
  assert.equal(checkTopicSet(["0b6a4a5e-0000-4000-8000-000000000999"], [], known), "unknown");
  assert.equal(checkTopicSet([R], [], known), "inactive", "a retired topic cannot be added");
  assert.equal(checkTopicSet([R, A], [R], known), null, "a retired topic already on the challenge may stay");
  assert.equal(checkTopicSet([A, B, R, C].slice(0, TOPICS_PER_CHALLENGE_MAX), [R], known), null);
  assert.equal(checkTopicSet([R, A, B, C], [R], known), "too_many", "a retired topic counts toward the three");
  assert.equal(checkTopicSet([], [R, A], known), null, "removing is always allowed");
});

test("topicDiff reports what was added and removed", () => {
  assert.deepEqual(topicDiff([A, B], [B, C]), { added: [C], removed: [A] });
  assert.deepEqual(topicDiff([A], [A]), { added: [], removed: [] });
});

test("bulkTopicChange: ok, unchanged and topic_limit", () => {
  assert.deepEqual(bulkTopicChange([A], "add", B), { outcome: "ok", next: [A, B] });
  assert.deepEqual(bulkTopicChange([A], "add", A), { outcome: "unchanged", next: [A] });
  assert.deepEqual(bulkTopicChange([A, B, C], "add", D), { outcome: "topic_limit", next: [A, B, C] });
  assert.deepEqual(bulkTopicChange([A, B, C], "add", C), { outcome: "unchanged", next: [A, B, C] }, "already there beats the limit");
  assert.deepEqual(bulkTopicChange([A, B], "remove", A), { outcome: "ok", next: [B] });
  assert.deepEqual(bulkTopicChange([B], "remove", A), { outcome: "unchanged", next: [B] });
});

test("event-18 copy names the topics alphabetically, one or several", () => {
  assert.equal(topicListLabel(["automation", "AI", "Customer onboarding"]), "AI, automation, Customer onboarding");
  assert.equal(topicNoticeMessage({ topics: ["AI"], number: "412", title: "Reduce invoice matching time" }), 'New in AI: CH-412 "Reduce invoice matching time" is open for solutions.');
  assert.equal(topicNoticeMessage({ topics: ["Automation", "AI"], number: 412, title: "T" }), 'New in AI, Automation: CH-412 "T" is open for solutions.');
  assert.equal(topicNoticeSubject(["AI"], "412"), "New in AI: CH-412 is open for solutions");
  assert.equal(topicNoticeFootnote(["AI"]), "You get this because you follow AI. Manage your topics:");
  assert.equal(topicDigestLine(["Automation", "AI"]), "New in a topic you follow — AI, Automation");
});
