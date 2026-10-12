// The feedback survey — catalog and rules (INNOBOX_SPEC.md §13.10). Pure and CLIENT-SAFE (also
// exposed at the `@innobox/shared/survey` subpath for the survey card, the profile and the admin
// results card). Holds no database or node imports: the web store applies these rules in SQL and
// the unit tests exercise them directly.
//
// The catalog is hard-coded and versioned. ANY change to it bumps SURVEY_VERSION (which drops
// every open offer on read). A question's key is permanent: a change of meaning needs a new key,
// and the old one moves to RETIRED_QUESTIONS so its stored answers stay resolvable in the results.

export const SURVEY_VERSION = 1;

// ── Timing (days) ─────────────────────────────────────────────────────────────────────────

/** Quick start must be at least this old before a random survey can appear. */
export const SURVEY_GRACE_DAYS = 14;
/** At most one random survey per this many days, counted from `survey_last_shown_at`. */
export const SURVEY_FLOOR_DAYS = 30;
/** A random offer stays open (answerable from the menu) this long after it was shown. */
export const SURVEY_RANDOM_OFFER_DAYS = 30;
/** After this long without a survey, every full page load also rolls (the fallback). */
export const SURVEY_FALLBACK_DAYS = 90;
/** An on-demand ("self") offer stays open this long, and is the on-demand cooldown. */
export const SURVEY_SELF_OFFER_DAYS = 7;
/** One in this many eligible triggers wins. */
export const SURVEY_ROLL_ODDS = 3;

export const SURVEY_FREE_TEXT_MAX = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Vocabulary ────────────────────────────────────────────────────────────────────────────

export const SURVEY_TRIGGERS = ["feature", "visit", "self"] as const;
export type SurveyTrigger = (typeof SURVEY_TRIGGERS)[number];

export const SURVEY_SEGMENTS = ["admin", "committee", "member"] as const;
export type SurveySegment = (typeof SURVEY_SEGMENTS)[number];

export const SURVEY_SEGMENT_LABEL: Record<SurveySegment, string> = {
  admin: "Admin",
  committee: "Committee",
  member: "Member",
};

export const SURVEY_VIAS = ["popup", "menu"] as const;
export type SurveyVia = (typeof SURVEY_VIAS)[number];

// ── The feature catalog ───────────────────────────────────────────────────────────────────

/** The features whose first use can trigger a survey, in catalog (display) order. */
export const SURVEY_FEATURES = [
  { key: "submit_challenge", label: "submitting a challenge" },
  { key: "propose_solution", label: "proposing a solution" },
  { key: "comment", label: "commenting" },
  { key: "like", label: "liking" },
  { key: "follow", label: "following items" },
  { key: "attachments", label: "attaching files" },
  { key: "search", label: "search" },
  { key: "leaderboard", label: "the leaderboard" },
  { key: "review", label: "moving items through review" },
  { key: "triage", label: "the triage queue" },
] as const;

export type SurveyFeature = (typeof SURVEY_FEATURES)[number]["key"];

const FEATURE_LABEL: ReadonlyMap<string, string> = new Map(SURVEY_FEATURES.map((f) => [f.key, f.label]));

export function isSurveyFeature(v: unknown): v is SurveyFeature {
  return typeof v === "string" && FEATURE_LABEL.has(v);
}

export function surveyFeatureLabel(key: SurveyFeature): string {
  return FEATURE_LABEL.get(key) ?? key;
}

// ── The questions ─────────────────────────────────────────────────────────────────────────

export interface SurveyCatalogQuestion {
  key: string;
  /** Feature questions carry `{feature}`, substituted with the feature's label. */
  text: string;
}

/** Asked in every survey. */
export const GENERAL_QUESTIONS: readonly SurveyCatalogQuestion[] = [
  { key: "general.overall", text: "Overall, how satisfied are you with InnoBox?" },
  { key: "general.discovery", text: "How easy is it to find challenges that interest you?" },
  { key: "general.followthrough", text: "How confident are you that ideas raised here get reviewed and acted on?" },
  { key: "general.recommend", text: "How likely are you to recommend InnoBox to a colleague?" },
];

/** One of these is picked at random when an offer is created, and stored in it. */
export const ROTATING_QUESTIONS: readonly SurveyCatalogQuestion[] = [
  { key: "rotating.performance", text: "How happy are you with how fast InnoBox feels?" },
  { key: "rotating.look", text: "How much do you like the way InnoBox looks and feels?" },
  { key: "rotating.docs", text: "How helpful are Quick start and the in-app guidance?" },
  { key: "rotating.informed", text: "How well does InnoBox keep you informed about what happens to your challenges and solutions?" },
];

/** About the offer's feature. */
export const FEATURE_QUESTIONS: readonly SurveyCatalogQuestion[] = [
  { key: "feature.useful", text: "How useful is {feature} for your work?" },
  { key: "feature.ease", text: "How easy was {feature} to use?" },
];

/** Keys no longer asked, kept so their stored answers still resolve in the results (tagged
 *  *retired*). Empty while SURVEY_VERSION is 1. */
export const RETIRED_QUESTIONS: readonly SurveyCatalogQuestion[] = [];

/** Every key the results can show, in catalog order: general, rotating, feature, retired. */
export const SURVEY_QUESTION_ORDER: readonly string[] = [
  ...GENERAL_QUESTIONS,
  ...ROTATING_QUESTIONS,
  ...FEATURE_QUESTIONS,
  ...RETIRED_QUESTIONS,
].map((q) => q.key);

const QUESTION_TEXT: ReadonlyMap<string, string> = new Map(
  [...GENERAL_QUESTIONS, ...ROTATING_QUESTIONS, ...FEATURE_QUESTIONS, ...RETIRED_QUESTIONS].map((q) => [q.key, q.text]),
);
const RETIRED_KEYS: ReadonlySet<string> = new Set(RETIRED_QUESTIONS.map((q) => q.key));
const FEATURE_QUESTION_KEYS: readonly string[] = FEATURE_QUESTIONS.map((q) => q.key);

export function isRetiredQuestion(key: string): boolean {
  return RETIRED_KEYS.has(key);
}

/** A question's text with `{feature}` substituted; with no label, the generic "this feature".
 *  Null for a key the catalog has never known. */
export function surveyQuestionText(key: string, featureLabel?: string | null): string | null {
  const text = QUESTION_TEXT.get(key);
  if (text === undefined) return null;
  return text.replace("{feature}", featureLabel ?? "this feature");
}

// ── Offers ────────────────────────────────────────────────────────────────────────────────

/** The open offer as stored in `users.survey_offer`. */
export interface StoredSurveyOffer {
  surveyVersion: number;
  trigger: SurveyTrigger;
  feature: SurveyFeature | null;
  rotating: string;
  /** True once a random offer's card has been closed (counted once in the funnel). */
  closed: boolean;
}

export interface SurveyQuestion {
  key: string;
  text: string;
  section: "general" | "feature";
}

/** The offer as the API hands it to the browser — questions resolved from the catalog. */
export interface SurveyOfferPayload {
  surveyVersion: number;
  trigger: SurveyTrigger;
  feature: { key: SurveyFeature; label: string } | null;
  questions: SurveyQuestion[];
  shownAt: string;
  expiresAt: string;
}

/** A random index in [0, n) from an injectable `rng` returning [0, 1). */
function pick(n: number, rng: () => number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** A new offer: the rotating question is picked now and stored, so reopening it later asks the
 *  same questions. A `self` offer never carries a feature (the user picks one in the card). */
export function composeOffer(trigger: SurveyTrigger, feature: SurveyFeature | null, rng: () => number): StoredSurveyOffer {
  return {
    surveyVersion: SURVEY_VERSION,
    trigger,
    feature: trigger === "self" ? null : feature,
    rotating: ROTATING_QUESTIONS[pick(ROTATING_QUESTIONS.length, rng)]!.key,
    closed: false,
  };
}

/** Reads `users.survey_offer` defensively; anything malformed is treated as no offer. */
export function parseStoredOffer(raw: unknown): StoredSurveyOffer | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.surveyVersion !== "number") return null;
  if (typeof r.trigger !== "string" || !(SURVEY_TRIGGERS as readonly string[]).includes(r.trigger)) return null;
  if (r.feature !== null && !isSurveyFeature(r.feature)) return null;
  if (typeof r.rotating !== "string") return null;
  return {
    surveyVersion: r.surveyVersion,
    trigger: r.trigger as SurveyTrigger,
    feature: (r.feature as SurveyFeature | null) ?? null,
    rotating: r.rotating,
    closed: r.closed === true,
  };
}

/** How long an offer of this trigger stays open. */
export function offerLifetimeDays(trigger: SurveyTrigger): number {
  return trigger === "self" ? SURVEY_SELF_OFFER_DAYS : SURVEY_RANDOM_OFFER_DAYS;
}

export function offerExpiresAt(trigger: SurveyTrigger, shownAt: Date): Date {
  return new Date(shownAt.getTime() + offerLifetimeDays(trigger) * DAY_MS);
}

/** Whether a stored offer is still open. It ends on a SURVEY_VERSION change, on expiry, and — a
 *  random offer only — when the user has opted out. (Submission and the platform switch clear
 *  the column outright.) `shownAt` is `survey_last_shown_at` for a random offer and
 *  `survey_self_shown_at` for a `self` one. */
export function isOfferLive(
  offer: StoredSurveyOffer,
  shownAt: Date | null,
  surveysEnabled: boolean,
  now: Date,
): boolean {
  if (offer.surveyVersion !== SURVEY_VERSION) return false;
  if (!shownAt) return false;
  if (now.getTime() >= offerExpiresAt(offer.trigger, shownAt).getTime()) return false;
  if (offer.trigger !== "self" && !surveysEnabled) return false;
  return true;
}

/** The questions an offer asks. A `self` offer adds the feature questions only once the user
 *  has picked a feature (`pickedFeature`). */
export function offerQuestions(offer: StoredSurveyOffer, pickedFeature: SurveyFeature | null = null): SurveyQuestion[] {
  const feature = offer.trigger === "self" ? pickedFeature : offer.feature;
  const general: SurveyQuestion[] = [...GENERAL_QUESTIONS.map((q) => q.key), offer.rotating].map((key) => ({
    key,
    text: surveyQuestionText(key) ?? key,
    section: "general" as const,
  }));
  if (!feature) return general;
  const label = surveyFeatureLabel(feature);
  return [
    ...general,
    ...FEATURE_QUESTION_KEYS.map((key) => ({ key, text: surveyQuestionText(key, label) ?? key, section: "feature" as const })),
  ];
}

export function offerPayload(offer: StoredSurveyOffer, shownAt: Date): SurveyOfferPayload {
  return {
    surveyVersion: offer.surveyVersion,
    trigger: offer.trigger,
    feature: offer.feature ? { key: offer.feature, label: surveyFeatureLabel(offer.feature) } : null,
    questions: offerQuestions(offer),
    shownAt: shownAt.toISOString(),
    expiresAt: offerExpiresAt(offer.trigger, shownAt).toISOString(),
  };
}

// ── Eligibility & the roll ────────────────────────────────────────────────────────────────

/** What the eligibility predicate reads off the user row (plus the platform switch). */
export interface SurveyUserState {
  active: boolean;
  scrubbed: boolean;
  quickStartSeenAt: Date | null;
  surveysEnabled: boolean;
  lastShownAt: Date | null;
  /** The open offer, ALREADY filtered for liveness (null when none or expired). */
  openOffer: StoredSurveyOffer | null;
}

function daysAgo(now: Date, days: number): number {
  return now.getTime() - days * DAY_MS;
}

/**
 * The random-prompt eligibility predicate (§13.10): all of the switch, active and not erased,
 * Quick start finished at least 14 days ago, not opted out, the 30-day floor, no open offer
 * (a random one implies the floor anyway; an on-demand one blocks explicitly) and `canShow`.
 * The web store re-checks the same conditions in its guarded UPDATE.
 */
export function isRandomSurveyEligible(
  state: SurveyUserState,
  ctx: { switchOn: boolean; canShow: boolean },
  now: Date,
): boolean {
  if (!ctx.switchOn || !ctx.canShow) return false;
  if (!state.active || state.scrubbed) return false;
  if (!state.quickStartSeenAt || state.quickStartSeenAt.getTime() > daysAgo(now, SURVEY_GRACE_DAYS)) return false;
  if (!state.surveysEnabled) return false;
  if (state.lastShownAt && state.lastShownAt.getTime() > daysAgo(now, SURVEY_FLOOR_DAYS)) return false;
  if (state.openOffer) return false;
  return true;
}

/** The long-time-user fallback: 90 days since the last survey (or, never shown, since Quick
 *  start). Applies on top of `isRandomSurveyEligible`. */
export function isSurveyFallbackDue(state: Pick<SurveyUserState, "lastShownAt" | "quickStartSeenAt">, now: Date): boolean {
  const since = state.lastShownAt ?? state.quickStartSeenAt;
  return since !== null && since.getTime() <= daysAgo(now, SURVEY_FALLBACK_DAYS);
}

/** One in SURVEY_ROLL_ODDS. Server-side only; `rng` is injectable for tests. */
export function rollSurvey(rng: () => number): boolean {
  return pick(SURVEY_ROLL_ODDS, rng) === 0;
}

// ── Segment ───────────────────────────────────────────────────────────────────────────────

/** Highest wins: a platform admin or any namespace admin → `admin`; any committee grant →
 *  `committee`; everyone else (assignee included) → `member`. Reads the SCIM-resolved roles. */
export function surveySegment(roles: { isPlatformAdmin: boolean; grants: readonly { role: string }[] }): SurveySegment {
  if (roles.isPlatformAdmin || roles.grants.some((g) => g.role === "namespace_admin")) return "admin";
  if (roles.grants.some((g) => g.role === "committee")) return "committee";
  return "member";
}

// ── Submission ────────────────────────────────────────────────────────────────────────────

export interface SurveySubmission {
  answers: { key: string; stars: number }[];
  freeText: string | null;
  via: SurveyVia;
  /** The feature the response is about — the offer's, or the one picked in a `self` card. */
  feature: SurveyFeature | null;
}

/**
 * Validates `{ answers, freeText?, via, feature? }` against the open offer (§13.10): every key
 * must be one the offer asks (its general keys, its rotating key, and the feature keys only when
 * it has — or, for `self`, the user picked — a feature), every star an integer 1–5, free text at
 * most 2 000 characters, and something must be answered. `feature` is required for a `self`
 * offer and rejected for any other.
 */
export function validateSurveySubmission(
  offer: StoredSurveyOffer,
  body: unknown,
): { ok: true; value: SurveySubmission } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be a JSON object" };
  const rec = body as Record<string, unknown>;

  if (typeof rec.via !== "string" || !(SURVEY_VIAS as readonly string[]).includes(rec.via)) {
    return { ok: false, error: "via must be 'popup' or 'menu'" };
  }

  let feature: SurveyFeature | null;
  if (offer.trigger === "self") {
    if (!("feature" in rec)) return { ok: false, error: "feature is required for this survey" };
    if (rec.feature !== null && !isSurveyFeature(rec.feature)) return { ok: false, error: "feature must be a known feature or null" };
    feature = rec.feature as SurveyFeature | null;
  } else {
    if (rec.feature !== undefined) return { ok: false, error: "feature is not accepted for this survey" };
    feature = offer.feature;
  }

  const allowed = new Set(offerQuestions(offer, feature).map((q) => q.key));
  const rawAnswers = rec.answers ?? {};
  if (typeof rawAnswers !== "object" || rawAnswers === null || Array.isArray(rawAnswers)) {
    return { ok: false, error: "answers must be an object of question keys to stars" };
  }
  const answers: { key: string; stars: number }[] = [];
  for (const [key, stars] of Object.entries(rawAnswers as Record<string, unknown>)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown question: ${key}` };
    if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) {
      return { ok: false, error: "every answer must be a whole number of stars from 1 to 5" };
    }
    answers.push({ key, stars });
  }

  let freeText: string | null = null;
  if (rec.freeText !== undefined && rec.freeText !== null) {
    if (typeof rec.freeText !== "string") return { ok: false, error: "freeText must be a string" };
    const trimmed = rec.freeText.trim();
    if (trimmed.length > SURVEY_FREE_TEXT_MAX) return { ok: false, error: `freeText must be at most ${SURVEY_FREE_TEXT_MAX} characters` };
    freeText = trimmed === "" ? null : trimmed;
  }

  if (answers.length === 0 && freeText === null) return { ok: false, error: "answer at least one question" };

  return { ok: true, value: { answers, freeText, via: rec.via as SurveyVia, feature } };
}

// ── On-demand ("Give feedback", "Have your say") ──────────────────────────────────────────

/** When the user may start another on-demand survey: 7 days after the last one OPENED (the
 *  cooldown is stamped on open, never on submit). Null = now. */
export function selfSurveyNextAt(selfShownAt: Date | null, now: Date): Date | null {
  if (!selfShownAt) return null;
  const next = new Date(selfShownAt.getTime() + SURVEY_SELF_OFFER_DAYS * DAY_MS);
  return next.getTime() > now.getTime() ? next : null;
}

export type SelfSurveyGate = { ok: true } | { ok: false; reason: "surveys_off" | "unavailable" } | { ok: false; reason: "cooldown"; nextAt: Date };

/**
 * The on-demand gate (§13.10). It BYPASSES the roll, the 30-day floor, the 14-day grace and the
 * random opt-out, and RESPECTS only the platform switch, active and not erased, and its own 7-day
 * cooldown — an independent clock from the random floor. (An already open offer is returned as is
 * before this gate is consulted.)
 */
export function selfSurveyGate(
  state: { active: boolean; scrubbed: boolean; selfShownAt: Date | null },
  switchOn: boolean,
  now: Date,
): SelfSurveyGate {
  if (!switchOn) return { ok: false, reason: "surveys_off" };
  if (!state.active || state.scrubbed) return { ok: false, reason: "unavailable" };
  const nextAt = selfSurveyNextAt(state.selfShownAt, now);
  if (nextAt) return { ok: false, reason: "cooldown", nextAt };
  return { ok: true };
}
