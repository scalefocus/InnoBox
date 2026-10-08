// Cards / List view preference for the /challenges gallery (INNOBOX_SPEC.md §13.1).
//
// A pure presentation choice, persisted per browser in localStorage under
// `innobox:challenges-view` — no server preference, no URL parameter, no audit. Storage can be
// missing, blocked (private mode, disabled site data) or throw on the bare `window.localStorage`
// accessor, so every read and write is wrapped: an unreadable or invalid value falls back to
// Cards and a failed write is silently ignored (the in-page choice still applies for the visit).
//
// Kept free of React and DOM types so it is unit-testable under node:test; the page passes the
// real storage getter, tests pass fakes (including ones that throw).

export type ChallengesView = "cards" | "list";

export const CHALLENGES_VIEW_KEY = "innobox:challenges-view";
export const DEFAULT_CHALLENGES_VIEW: ChallengesView = "cards";

/** The minimal Storage surface used here — `window.localStorage` satisfies it. */
export interface ViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Resolves the storage lazily: on some browsers merely touching `window.localStorage` throws. */
export type StorageGetter = () => ViewStorage | null | undefined;

function browserStorage(): ViewStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/** Any stored value other than exactly "cards" / "list" is treated as absent. */
export function parseChallengesView(raw: unknown): ChallengesView {
  return raw === "list" || raw === "cards" ? raw : DEFAULT_CHALLENGES_VIEW;
}

/** Reads the persisted view; never throws. */
export function readChallengesView(getStorage: StorageGetter = browserStorage): ChallengesView {
  try {
    const storage = getStorage();
    return parseChallengesView(storage ? storage.getItem(CHALLENGES_VIEW_KEY) : null);
  } catch {
    return DEFAULT_CHALLENGES_VIEW;
  }
}

/** Persists the view; returns whether it was stored. Never throws. */
export function writeChallengesView(view: ChallengesView, getStorage: StorageGetter = browserStorage): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(CHALLENGES_VIEW_KEY, parseChallengesView(view));
    return true;
  } catch {
    return false;
  }
}

// ── List rows (§13.1, the §14.1 whole-row pattern) ─────────────────────────────────────────

/** "CH-412" → "/challenges/412" — the same href the card and the title link use. */
export function challengeHref(displayNumber: string): string {
  return `/challenges/${displayNumber.replace(/\D/g, "")}`;
}

/**
 * Whether a click on a list row should open the challenge. It must not when:
 * - it landed on (or inside) an interactive element — the title link navigates by itself, and an
 *   author bubble's portaled directory card (§13.8) has links of its own;
 * - it is the tail of a text selection (so a title can still be selected and copied);
 * - it is not a plain primary click (modifier / middle clicks are left to the browser and the
 *   title link, which is the real anchor).
 */
export function shouldRowNavigate(click: {
  onInteractive: boolean;
  selectionText: string;
  button: number;
  modifier: boolean;
}): boolean {
  if (click.onInteractive) return false;
  if (click.button !== 0 || click.modifier) return false;
  return click.selectionText.trim().length === 0;
}

/** The solutions cell / meta label: "1 solution", "3 solutions". */
export function solutionCountLabel(n: number): string {
  return `${n} solution${n === 1 ? "" : "s"}`;
}
