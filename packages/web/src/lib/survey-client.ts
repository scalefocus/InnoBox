// Browser-side plumbing for the feedback survey (INNOBOX_SPEC.md §13.10). Pages never call the
// survey API themselves: after a catalog feature's defining action SUCCEEDS they call
// `reportFeatureUse(key)`, and AppShell — which owns the card and knows `canShow` — queues the
// report until it has made its What's new decision, then sends it. The report carries ONLY the
// feature key, never an item id.
//
// The pure parts (`surveyCanShow`, the session dedupe key) are unit-tested; the rest touches
// `window` only when called.
import type { SurveyFeature } from "@innobox/shared/survey";

/** The profile asks the shell to reopen the open offer ("Take the survey"). */
export const SURVEY_OPEN_EVENT = "innobox:survey-open";
/** The shell tells listeners (the profile) that the open offer or the opt-out changed. */
export const SURVEY_CHANGED_EVENT = "innobox:survey-changed";

// A module-level hand-off rather than a window event: on a full page load React runs the page's
// effects BEFORE the shell's (children first), and the shell subscribes only once the session is
// known — an event fired in between would be lost. Reports made before the shell subscribes wait
// here (one per feature) and are handed over when it does.
const pending: SurveyFeature[] = [];
let consumer: ((feature: SurveyFeature) => void) | null = null;

export function reportFeatureUse(feature: SurveyFeature): void {
  if (consumer) consumer(feature);
  else if (!pending.includes(feature)) pending.push(feature);
}

/** The shell's subscription: receives every report, starting with those made before it existed. */
export function subscribeFeatureUse(fn: (feature: SurveyFeature) => void): () => void {
  consumer = fn;
  for (const feature of pending.splice(0)) fn(feature);
  return () => {
    if (consumer === fn) consumer = null;
  };
}

export function requestSurveyOpen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SURVEY_OPEN_EVENT));
}

export function announceSurveyChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SURVEY_CHANGED_EVENT));
}

/** Each tab reports a feature at most once per browser session; the server records it once anyway. */
export function reportedKey(feature: SurveyFeature): string {
  return `innobox:survey-reported:${feature}`;
}

/** True the first time this session sees `feature` (and marks it). A storage failure (private
 *  mode, quota) just means the server's own dedupe is the only one. */
export function claimFeatureReport(feature: SurveyFeature): boolean {
  try {
    if (window.sessionStorage.getItem(reportedKey(feature))) return false;
    window.sessionStorage.setItem(reportedKey(feature), "1");
  } catch {
    /* fall through — report it */
  }
  return true;
}

export interface CanShowState {
  /** The shell has its `me` and has made its What's new decision. */
  shellReady: boolean;
  /** The What's new update notice is on screen or due on this load. */
  whatsNewDue: boolean;
  /** The Quick start gate is rendering (or the user is on /quick-start). */
  quickStartGate: boolean;
  /** A survey card is already open in this tab. */
  cardOpen: boolean;
  /** The mobile nav drawer or the mobile notification sheet is open. */
  mobileOverlayOpen: boolean;
}

/** Whether this tab could display a survey this instant. What's new always wins. */
export function surveyCanShow(s: CanShowState): boolean {
  return s.shellReady && !s.whatsNewDue && !s.quickStartGate && !s.cardOpen && !s.mobileOverlayOpen;
}
