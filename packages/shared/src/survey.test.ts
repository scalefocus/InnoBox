// Unit tests for the §13.10 survey rules: catalog integrity, offer composition and liveness, the
// eligibility predicate (every condition), the 90-day fallback, the roll, segment derivation and
// submission validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_QUESTIONS,
  GENERAL_QUESTIONS,
  RETIRED_QUESTIONS,
  ROTATING_QUESTIONS,
  SURVEY_FEATURES,
  SURVEY_FREE_TEXT_MAX,
  SURVEY_QUESTION_ORDER,
  SURVEY_VERSION,
  composeOffer,
  isOfferLive,
  isRandomSurveyEligible,
  isRetiredQuestion,
  isSurveyFallbackDue,
  isSurveyFeature,
  offerPayload,
  offerQuestions,
  parseStoredOffer,
  rollSurvey,
  selfSurveyGate,
  selfSurveyNextAt,
  surveyQuestionText,
  surveySegment,
  validateSurveySubmission,
  type StoredSurveyOffer,
  type SurveyUserState,
} from "./survey.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-12T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const fixed = (v: number) => () => v;

// ── Catalog integrity ─────────────────────────────────────────────────────────────────────

test("catalog: every question key is unique and namespaced by its section", () => {
  const keys = [...GENERAL_QUESTIONS, ...ROTATING_QUESTIONS, ...FEATURE_QUESTIONS, ...RETIRED_QUESTIONS].map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const q of GENERAL_QUESTIONS) assert.match(q.key, /^general\./);
  for (const q of ROTATING_QUESTIONS) assert.match(q.key, /^rotating\./);
  for (const q of FEATURE_QUESTIONS) assert.match(q.key, /^feature\./);
  assert.deepEqual(SURVEY_QUESTION_ORDER, keys);
  assert.equal(GENERAL_QUESTIONS.length, 4);
  assert.equal(FEATURE_QUESTIONS.length, 2);
});

test("catalog: features are unique, labelled, and only feature questions take a label", () => {
  const keys = SURVEY_FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, 10);
  for (const f of SURVEY_FEATURES) assert.ok(f.label.trim().length > 0, `${f.key} has no label`);
  for (const q of FEATURE_QUESTIONS) assert.ok(q.text.includes("{feature}"));
  for (const q of [...GENERAL_QUESTIONS, ...ROTATING_QUESTIONS]) assert.ok(!q.text.includes("{feature}"));
  assert.equal(isSurveyFeature("search"), true);
  assert.equal(isSurveyFeature("nope"), false);
  assert.equal(isSurveyFeature(undefined), false);
});

test("catalog: every key resolves, retired ones included, and unknown keys do not", () => {
  for (const key of SURVEY_QUESTION_ORDER) assert.ok(surveyQuestionText(key));
  for (const q of RETIRED_QUESTIONS) assert.equal(isRetiredQuestion(q.key), true);
  assert.equal(isRetiredQuestion("general.overall"), false);
  assert.equal(surveyQuestionText("feature.useful", "search"), "How useful is search for your work?");
  assert.equal(surveyQuestionText("made.up"), null);
});

// ── Offers ────────────────────────────────────────────────────────────────────────────────

test("composeOffer: picks and stores the rotating question; self never carries a feature", () => {
  const first = composeOffer("feature", "comment", fixed(0));
  assert.deepEqual(first, { surveyVersion: SURVEY_VERSION, trigger: "feature", feature: "comment", rotating: ROTATING_QUESTIONS[0]!.key, closed: false });
  assert.equal(composeOffer("visit", null, fixed(0.999)).rotating, ROTATING_QUESTIONS[ROTATING_QUESTIONS.length - 1]!.key);
  assert.equal(composeOffer("self", "comment", fixed(0)).feature, null);
});

test("offerQuestions: general + rotating, plus the two feature questions only with a feature", () => {
  const withFeature = offerQuestions(composeOffer("feature", "search", fixed(0)));
  assert.deepEqual(
    withFeature.map((q) => [q.key, q.section]),
    [
      ["general.overall", "general"],
      ["general.discovery", "general"],
      ["general.followthrough", "general"],
      ["general.recommend", "general"],
      [ROTATING_QUESTIONS[0]!.key, "general"],
      ["feature.useful", "feature"],
      ["feature.ease", "feature"],
    ],
  );
  assert.equal(withFeature[5]!.text, "How useful is search for your work?");
  // The fallback with no recorded use asks the general questions only.
  assert.equal(offerQuestions(composeOffer("visit", null, fixed(0))).length, 5);
  // A self offer adds them only for the feature the user picked.
  const self = composeOffer("self", null, fixed(0));
  assert.equal(offerQuestions(self).length, 5);
  assert.equal(offerQuestions(self, "like").length, 7);
});

test("offerPayload resolves the feature label and the expiry by trigger", () => {
  const shown = ago(1);
  const p = offerPayload(composeOffer("feature", "like", fixed(0)), shown);
  assert.deepEqual(p.feature, { key: "like", label: "liking" });
  assert.equal(p.shownAt, shown.toISOString());
  assert.equal(Date.parse(p.expiresAt) - shown.getTime(), 30 * DAY);
  const s = offerPayload(composeOffer("self", null, fixed(0)), shown);
  assert.equal(Date.parse(s.expiresAt) - shown.getTime(), 7 * DAY);
});

test("parseStoredOffer rejects anything malformed", () => {
  const ok = composeOffer("feature", "like", fixed(0));
  assert.deepEqual(parseStoredOffer(JSON.parse(JSON.stringify(ok))), ok);
  assert.equal(parseStoredOffer(null), null);
  assert.equal(parseStoredOffer({ ...ok, trigger: "other" }), null);
  assert.equal(parseStoredOffer({ ...ok, feature: "unknown" }), null);
  assert.equal(parseStoredOffer({ ...ok, surveyVersion: "1" }), null);
});

test("isOfferLive: version, expiry, and the opt-out (random offers only)", () => {
  const random = composeOffer("feature", "like", fixed(0));
  const self = composeOffer("self", null, fixed(0));
  assert.equal(isOfferLive(random, ago(29), true, NOW), true);
  assert.equal(isOfferLive(random, ago(30), true, NOW), false, "30 days → expired");
  assert.equal(isOfferLive(random, ago(1), false, NOW), false, "opt-out ends a random offer");
  assert.equal(isOfferLive(self, ago(6), false, NOW), true, "opt-out keeps a self offer");
  assert.equal(isOfferLive(self, ago(7), true, NOW), false, "a self offer lasts 7 days");
  assert.equal(isOfferLive({ ...random, surveyVersion: SURVEY_VERSION + 1 }, ago(1), true, NOW), false, "version change");
  assert.equal(isOfferLive(random, null, true, NOW), false);
});

// ── Eligibility ───────────────────────────────────────────────────────────────────────────

const eligible: SurveyUserState = {
  active: true,
  scrubbed: false,
  quickStartSeenAt: ago(20),
  surveysEnabled: true,
  lastShownAt: null,
  openOffer: null,
};
const on = { switchOn: true, canShow: true };

test("eligibility: the baseline user is eligible", () => {
  assert.equal(isRandomSurveyEligible(eligible, on, NOW), true);
});

test("eligibility: each condition alone makes the user ineligible", () => {
  const cases: [string, SurveyUserState, { switchOn: boolean; canShow: boolean }][] = [
    ["switch off", eligible, { switchOn: false, canShow: true }],
    ["canShow false", eligible, { switchOn: true, canShow: false }],
    ["inactive", { ...eligible, active: false }, on],
    ["scrubbed", { ...eligible, scrubbed: true }, on],
    ["quick start not seen", { ...eligible, quickStartSeenAt: null }, on],
    ["inside the 14-day grace", { ...eligible, quickStartSeenAt: ago(13) }, on],
    ["opted out", { ...eligible, surveysEnabled: false }, on],
    ["inside the 30-day floor", { ...eligible, lastShownAt: ago(29) }, on],
    ["an open self offer", { ...eligible, openOffer: composeOffer("self", null, fixed(0)) }, on],
  ];
  for (const [name, state, ctx] of cases) assert.equal(isRandomSurveyEligible(state, ctx, NOW), false, name);
});

test("eligibility: the grace and floor boundaries are inclusive at exactly 14 and 30 days", () => {
  assert.equal(isRandomSurveyEligible({ ...eligible, quickStartSeenAt: ago(14) }, on, NOW), true);
  assert.equal(isRandomSurveyEligible({ ...eligible, lastShownAt: ago(30) }, on, NOW), true);
});

test("fallback: due 90 days after the last survey, or after Quick start when never shown", () => {
  assert.equal(isSurveyFallbackDue({ lastShownAt: ago(89), quickStartSeenAt: ago(400) }, NOW), false);
  assert.equal(isSurveyFallbackDue({ lastShownAt: ago(90), quickStartSeenAt: ago(400) }, NOW), true);
  assert.equal(isSurveyFallbackDue({ lastShownAt: null, quickStartSeenAt: ago(90) }, NOW), true);
  assert.equal(isSurveyFallbackDue({ lastShownAt: null, quickStartSeenAt: ago(89) }, NOW), false);
  assert.equal(isSurveyFallbackDue({ lastShownAt: null, quickStartSeenAt: null }, NOW), false);
});

test("the roll wins one time in three, driven by the injected rng", () => {
  assert.equal(rollSurvey(fixed(0)), true);
  assert.equal(rollSurvey(fixed(0.33)), true);
  assert.equal(rollSurvey(fixed(0.34)), false);
  assert.equal(rollSurvey(fixed(0.999)), false);
  let wins = 0;
  for (let i = 0; i < 300; i++) if (rollSurvey(fixed(i / 300))) wins++;
  assert.equal(wins, 100);
});

// ── Segment ───────────────────────────────────────────────────────────────────────────────

test("segment: highest role wins", () => {
  const g = (...roles: string[]) => roles.map((role) => ({ role }));
  assert.equal(surveySegment({ isPlatformAdmin: true, grants: g("member") }), "admin");
  assert.equal(surveySegment({ isPlatformAdmin: false, grants: g("member", "namespace_admin", "committee") }), "admin");
  assert.equal(surveySegment({ isPlatformAdmin: false, grants: g("member", "committee") }), "committee");
  assert.equal(surveySegment({ isPlatformAdmin: false, grants: g("member") }), "member");
});

// ── Submission validation ─────────────────────────────────────────────────────────────────

const featureOffer: StoredSurveyOffer = composeOffer("feature", "comment", fixed(0));
const visitOffer: StoredSurveyOffer = composeOffer("visit", null, fixed(0));
const selfOffer: StoredSurveyOffer = composeOffer("self", null, fixed(0));

test("submission: keys are checked against the offer", () => {
  const ok = validateSurveySubmission(featureOffer, {
    answers: { "general.overall": 4, [featureOffer.rotating]: 5, "feature.ease": 3 },
    via: "popup",
  });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.value.feature, "comment");
    assert.equal(ok.value.answers.length, 3);
  }
  // Another rotating question is not part of this offer.
  const otherRotating = ROTATING_QUESTIONS.find((q) => q.key !== featureOffer.rotating)!.key;
  assert.equal(validateSurveySubmission(featureOffer, { answers: { [otherRotating]: 3 }, via: "popup" }).ok, false);
  // Feature questions without a feature.
  assert.equal(validateSurveySubmission(visitOffer, { answers: { "feature.ease": 3 }, via: "popup" }).ok, false);
  assert.equal(validateSurveySubmission(visitOffer, { answers: { "made.up": 3 }, via: "popup" }).ok, false);
});

test("submission: stars are whole numbers 1–5; something must be answered", () => {
  for (const stars of [0, 6, 2.5, "3", null]) {
    assert.equal(validateSurveySubmission(visitOffer, { answers: { "general.overall": stars }, via: "popup" }).ok, false, String(stars));
  }
  assert.equal(validateSurveySubmission(visitOffer, { answers: {}, via: "popup" }).ok, false, "empty");
  assert.equal(validateSurveySubmission(visitOffer, { answers: {}, freeText: "   ", via: "popup" }).ok, false, "whitespace only");
  const textOnly = validateSurveySubmission(visitOffer, { freeText: "  More dark mode  ", via: "menu" });
  assert.ok(textOnly.ok);
  if (textOnly.ok) assert.deepEqual(textOnly.value, { answers: [], freeText: "More dark mode", via: "menu", feature: null });
});

test("submission: the free-text cap is 2 000 characters", () => {
  assert.equal(validateSurveySubmission(visitOffer, { freeText: "x".repeat(SURVEY_FREE_TEXT_MAX), via: "popup" }).ok, true);
  assert.equal(validateSurveySubmission(visitOffer, { freeText: "x".repeat(SURVEY_FREE_TEXT_MAX + 1), via: "popup" }).ok, false);
});

test("submission: via must be popup or menu", () => {
  assert.equal(validateSurveySubmission(visitOffer, { answers: { "general.overall": 3 } }).ok, false);
  assert.equal(validateSurveySubmission(visitOffer, { answers: { "general.overall": 3 }, via: "email" }).ok, false);
});

test("submission: feature is required for a self offer and rejected for any other", () => {
  assert.equal(validateSurveySubmission(featureOffer, { answers: { "general.overall": 3 }, via: "popup", feature: "comment" }).ok, false);
  assert.equal(validateSurveySubmission(visitOffer, { answers: { "general.overall": 3 }, via: "popup", feature: null }).ok, false);
  assert.equal(validateSurveySubmission(selfOffer, { answers: { "general.overall": 3 }, via: "popup" }).ok, false, "missing");
  assert.equal(validateSurveySubmission(selfOffer, { answers: { "general.overall": 3 }, via: "popup", feature: "nope" }).ok, false);
  const general = validateSurveySubmission(selfOffer, { answers: { "general.overall": 3 }, via: "popup", feature: null });
  assert.ok(general.ok);
  // The picked feature unlocks its two questions; without it they are rejected.
  assert.equal(validateSurveySubmission(selfOffer, { answers: { "feature.useful": 3 }, via: "popup", feature: null }).ok, false);
  const picked = validateSurveySubmission(selfOffer, { answers: { "feature.useful": 3 }, via: "popup", feature: "search" });
  assert.ok(picked.ok);
  if (picked.ok) assert.equal(picked.value.feature, "search");
});

// ── On-demand gate ────────────────────────────────────────────────────────────────────────

test("on-demand gate: the switch, active and not erased, and the 7-day cooldown (6 vs 7 days)", () => {
  const base = { active: true, scrubbed: false, selfShownAt: null as Date | null };
  assert.deepEqual(selfSurveyGate(base, true, NOW), { ok: true });
  assert.deepEqual(selfSurveyGate(base, false, NOW), { ok: false, reason: "surveys_off" });
  assert.deepEqual(selfSurveyGate({ ...base, active: false }, true, NOW), { ok: false, reason: "unavailable" });
  assert.deepEqual(selfSurveyGate({ ...base, scrubbed: true }, true, NOW), { ok: false, reason: "unavailable" });
  const six = selfSurveyGate({ ...base, selfShownAt: ago(6) }, true, NOW);
  assert.equal(six.ok, false);
  if (!six.ok && six.reason === "cooldown") assert.equal(six.nextAt.getTime(), ago(6).getTime() + 7 * DAY);
  else assert.fail("6 days in is still the cooldown");
  assert.deepEqual(selfSurveyGate({ ...base, selfShownAt: ago(7) }, true, NOW), { ok: true });
});

test("on-demand gate: bypasses the opt-out, the 14-day grace and the 30-day floor", () => {
  // None of the random-prompt conditions are even inputs — a user who opted out, finished Quick
  // start yesterday and saw a random survey last week can still ask for one.
  const optedOutFreshRecent = { ...eligible, surveysEnabled: false, quickStartSeenAt: ago(1), lastShownAt: ago(7) };
  assert.equal(isRandomSurveyEligible(optedOutFreshRecent, on, NOW), false);
  assert.deepEqual(selfSurveyGate({ active: true, scrubbed: false, selfShownAt: null }, true, NOW), { ok: true });
  assert.equal(selfSurveyNextAt(null, NOW), null);
  assert.equal(selfSurveyNextAt(ago(8), NOW), null);
});
