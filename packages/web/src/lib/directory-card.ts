// Directory hover card (INNOBOX_SPEC.md §13.8): the pure, DOM-free pieces of the card's behavior,
// split out of components/DirectoryCard.tsx so they can be unit-tested without a browser.

/** The card's "View profile" target: `/profile` for the signed-in user's own bubble, decided by
 *  comparing ids — no caller marks a bubble as "self" — and `/profile/<id>` for anyone else. A
 *  not-yet-known signed-in id (`null`) falls back to the public path, which renders the same
 *  person. */
export function profileHref(userId: string, signedInUserId: string | null): string {
  return signedInUserId !== null && userId === signedInUserId ? "/profile" : `/profile/${userId}`;
}

/** Elements that take part in sequential (Tab) focus navigation, before the visibility and
 *  negative-tabindex filtering the component applies against the live DOM. */
export const TABBABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "iframe",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]",
].join(",");

/**
 * The card is portalled to the end of `document.body`, so the browser's Tab order never reaches
 * it from the bubble and leaving it lands at the end of the page. Focus is routed explicitly
 * (§13.8): Tab out of the card continues to the element **after** the bubble in page order, and
 * Shift+Tab to the element **before** it. Given the page's tabbable elements in document order,
 * this returns that neighbor — skipping the bubble itself and anything inside the card — or null
 * when there is none in that direction.
 */
export function focusNeighbor<T>(
  order: readonly T[],
  trigger: T,
  isInCard: (el: T) => boolean,
  direction: "next" | "prev",
): T | null {
  const at = order.indexOf(trigger);
  if (at === -1) return null;
  const step = direction === "next" ? 1 : -1;
  for (let i = at + step; i >= 0 && i < order.length; i += step) {
    const el = order[i]!;
    if (el !== trigger && !isInCard(el)) return el;
  }
  return null;
}

// ── Press and hold (touch and pen, §13.8) ────────────────────────────────────────────────────

/** How long a touch/pen press must be held before the card opens. */
export const HOLD_MS = 500;
/** How far a press may drift before it is a scroll, not a hold. */
export const HOLD_SLOP_PX = 10;
/** After a touch/pen press ends, focus it caused (mobile browsers focus a tapped `tabindex`
 *  element) must not open the card — a short tap is unchanged. */
export const HOLD_FOCUS_GUARD_MS = 800;
/** How long after a completed hold the release's click is swallowed. */
export const HOLD_CLICK_SWALLOW_MS = 400;

/** Touch and pen open the card by press-and-hold; the mouse keeps hover-intent. */
export function isHoldPointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

export interface HoldGesture {
  /** A pointer went down on the bubble. Only touch/pen starts the hold timer. */
  down(pointerType: string, x: number, y: number): void;
  /** The pressing pointer moved; drifting past the slop aborts the hold (it is a scroll). */
  move(x: number, y: number): void;
  /** The pointer lifted. True when the hold had fired — the caller swallows the click. */
  up(): boolean;
  /** The browser took the pointer (`pointercancel`, e.g. for a scroll) — abort silently. */
  cancel(): void;
  /** True when the most recent press on the bubble came from touch or pen — the gate for
   *  cancelling `contextmenu` (Android raises one at its own long-press threshold), so a desktop
   *  right-click keeps the browser's menu. */
  lastPressWasHold(): boolean;
  /** True while a touch/pen press is in progress, or within the focus guard after it ended. */
  suppressFocus(now: number): boolean;
}

/**
 * The press-and-hold state machine (§13.8), DOM-free so it can be unit-tested with fake timers.
 * `onHold` fires once the press has been held for `holdMs` without drifting more than `slopPx`.
 */
export function createHoldGesture(opts: {
  onHold: () => void;
  holdMs?: number;
  slopPx?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): HoldGesture {
  const holdMs = opts.holdMs ?? HOLD_MS;
  const slop = opts.slopPx ?? HOLD_SLOP_PX;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let start: { x: number; y: number } | null = null;
  let held = false;
  let lastType = "";
  let pressing = false;
  let endedAt = -Infinity;

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    start = null;
  };
  const end = () => {
    stop();
    if (pressing) endedAt = now();
    pressing = false;
  };

  return {
    down(pointerType, x, y) {
      stop();
      held = false;
      lastType = pointerType;
      pressing = isHoldPointer(pointerType);
      if (!pressing) return;
      start = { x, y };
      timer = setTimer(() => {
        timer = null;
        held = true;
        opts.onHold();
      }, holdMs);
    },
    move(x, y) {
      if (!start || held) return;
      if (Math.hypot(x - start.x, y - start.y) > slop) stop();
    },
    up() {
      const fired = held;
      held = false;
      end();
      return fired;
    },
    cancel() {
      held = false;
      end();
    },
    lastPressWasHold: () => isHoldPointer(lastType),
    suppressFocus: (t) => pressing || t - endedAt < HOLD_FOCUS_GUARD_MS,
  };
}

/**
 * Swallow the click a completed hold's release would fire (§13.8): many bubbles sit inside a link,
 * card or clickable row, and opening the card must never also navigate or open the row. Listens in
 * the capture phase on `target` (the window), so it runs before React's root listener; disarms
 * itself after the first click or `ms`, whichever comes first.
 */
export function swallowNextClick(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  ms = HOLD_CLICK_SWALLOW_MS,
  setTimer: (fn: () => void, ms: number) => unknown = (fn, t) => setTimeout(fn, t),
): void {
  const onClick = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    disarm();
  };
  const disarm = () => target.removeEventListener("click", onClick, { capture: true });
  target.addEventListener("click", onClick, { capture: true });
  setTimer(disarm, ms);
}
