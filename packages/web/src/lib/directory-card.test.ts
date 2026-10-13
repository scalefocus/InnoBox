// Directory hover card helpers (INNOBOX_SPEC.md §13.8): the self-link decision and the Tab
// routing around the portalled card, and the touch/pen press-and-hold gesture.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHoldGesture,
  focusNeighbor,
  HOLD_FOCUS_GUARD_MS,
  HOLD_MS,
  isHoldPointer,
  profileHref,
  swallowNextClick,
} from "./directory-card";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

test("profileHref: your own bubble links to /profile, decided by id comparison", () => {
  assert.equal(profileHref(ME, ME), "/profile");
});

test("profileHref: anyone else's bubble links to /profile/<id>", () => {
  assert.equal(profileHref(OTHER, ME), `/profile/${OTHER}`);
});

test("profileHref: an unknown signed-in id falls back to the public path", () => {
  assert.equal(profileHref(ME, null), `/profile/${ME}`);
});

// Page order: a link before the bubble, the bubble, a button after it — then the portalled card's
// link at the very end of <body>, which is exactly why the browser's own Tab order is wrong.
const page = ["before", "bubble", "after", "later", "card-link"];
const inCard = (el: string) => el.startsWith("card-");

test("focusNeighbor: Tab out of the card continues to the element after the bubble", () => {
  assert.equal(focusNeighbor(page, "bubble", inCard, "next"), "after");
});

test("focusNeighbor: Shift+Tab out of the card goes to the element before the bubble", () => {
  assert.equal(focusNeighbor(page, "bubble", inCard, "prev"), "before");
});

test("focusNeighbor: never lands back inside the card", () => {
  assert.equal(focusNeighbor(["bubble", "card-link"], "bubble", inCard, "next"), null);
  assert.equal(focusNeighbor(["card-a", "bubble", "card-b", "after"], "bubble", inCard, "next"), "after");
  assert.equal(focusNeighbor(["before", "card-a", "bubble"], "bubble", inCard, "prev"), "before");
});

test("focusNeighbor: null at either end of the page, or for a detached bubble", () => {
  assert.equal(focusNeighbor(["bubble", "after"], "bubble", inCard, "prev"), null);
  assert.equal(focusNeighbor(["before", "bubble"], "bubble", inCard, "next"), null);
  assert.equal(focusNeighbor(["before", "after"], "bubble", inCard, "next"), null);
});

// ── Press and hold (touch and pen) ──────────────────────────────────────────────────────────

/** A hold gesture on a manual clock: `tick(ms)` advances time and fires due timers. */
function harness() {
  let t = 0;
  let pending: { fn: () => void; at: number } | null = null;
  let holds = 0;
  const g = createHoldGesture({
    onHold: () => holds++,
    now: () => t,
    setTimer: (fn, ms) => (pending = { fn, at: t + ms }),
    clearTimer: () => (pending = null),
  });
  const tick = (ms: number) => {
    t += ms;
    if (pending && pending.at <= t) {
      const { fn } = pending;
      pending = null;
      fn();
    }
  };
  return { g, tick, holds: () => holds, now: () => t };
}

test("isHoldPointer: touch and pen hold, the mouse hovers", () => {
  assert.equal(isHoldPointer("touch"), true);
  assert.equal(isHoldPointer("pen"), true);
  assert.equal(isHoldPointer("mouse"), false);
});

test("hold: a touch held for the threshold opens the card once, and its release swallows the click", () => {
  const h = harness();
  h.g.down("touch", 50, 50);
  h.tick(HOLD_MS - 1);
  assert.equal(h.holds(), 0);
  h.tick(1);
  assert.equal(h.holds(), 1);
  assert.equal(h.g.up(), true);
});

test("hold: a pen behaves exactly like touch", () => {
  const h = harness();
  h.g.down("pen", 0, 0);
  h.tick(HOLD_MS);
  assert.equal(h.holds(), 1);
});

test("hold: a short tap opens nothing and its click goes through unchanged", () => {
  const h = harness();
  h.g.down("touch", 50, 50);
  h.tick(120);
  assert.equal(h.g.up(), false);
  h.tick(HOLD_MS);
  assert.equal(h.holds(), 0);
});

test("hold: a mouse press never starts a hold", () => {
  const h = harness();
  h.g.down("mouse", 50, 50);
  h.tick(HOLD_MS * 2);
  assert.equal(h.holds(), 0);
  assert.equal(h.g.up(), false);
});

test("hold: drifting past ~10 px aborts — scrolling a list of avatars never pops a card", () => {
  const h = harness();
  h.g.down("touch", 50, 50);
  h.g.move(56, 56); // ~8.5 px: still a hold
  h.tick(100);
  h.g.move(50, 62); // 12 px: a scroll
  h.tick(HOLD_MS);
  assert.equal(h.holds(), 0);
  assert.equal(h.g.up(), false);
});

test("hold: small jitter inside the slop still opens", () => {
  const h = harness();
  h.g.down("touch", 50, 50);
  h.g.move(53, 47);
  h.tick(HOLD_MS);
  assert.equal(h.holds(), 1);
});

test("hold: pointercancel (the browser taking over for a scroll) aborts silently", () => {
  const h = harness();
  h.g.down("touch", 50, 50);
  h.tick(200);
  h.g.cancel();
  h.tick(HOLD_MS);
  assert.equal(h.holds(), 0);
  assert.equal(h.g.up(), false);
});

test("hold: the next press starts fresh — a completed hold does not swallow a later tap", () => {
  const h = harness();
  h.g.down("touch", 50, 50);
  h.tick(HOLD_MS);
  assert.equal(h.g.up(), true);
  h.g.down("touch", 50, 50);
  h.tick(100);
  assert.equal(h.g.up(), false);
});

test("hold: contextmenu is cancelled only after a touch/pen press, never after a mouse press", () => {
  const h = harness();
  h.g.down("touch", 0, 0);
  assert.equal(h.g.lastPressWasHold(), true);
  h.g.up();
  h.g.down("mouse", 0, 0); // a desktop right-click keeps the browser's menu
  assert.equal(h.g.lastPressWasHold(), false);
  h.g.down("pen", 0, 0);
  assert.equal(h.g.lastPressWasHold(), true);
});

test("hold: focus caused by a touch press does not open the card, keyboard focus later does", () => {
  const h = harness();
  assert.equal(h.g.suppressFocus(h.now()), false);
  h.g.down("touch", 0, 0);
  assert.equal(h.g.suppressFocus(h.now()), true);
  h.tick(80);
  h.g.up(); // a short tap — mobile browsers focus the tapped tabindex element now
  assert.equal(h.g.suppressFocus(h.now()), true);
  h.tick(HOLD_FOCUS_GUARD_MS);
  assert.equal(h.g.suppressFocus(h.now()), false);
});

test("hold: a mouse press never suppresses focus", () => {
  const h = harness();
  h.g.down("mouse", 0, 0);
  h.g.up();
  assert.equal(h.g.suppressFocus(h.now()), false);
});

test("swallowNextClick: cancels the release's click before anyone else sees it, then disarms", () => {
  const target = new EventTarget();
  let disarm: (() => void) | null = null;
  swallowNextClick(target, 400, (fn) => (disarm = fn));

  const first = new Event("click", { cancelable: true });
  target.dispatchEvent(first);
  assert.equal(first.defaultPrevented, true);

  const second = new Event("click", { cancelable: true });
  target.dispatchEvent(second);
  assert.equal(second.defaultPrevented, false, "only one click is swallowed");
  assert.ok(disarm, "a timeout disarms it even when no click ever comes");
});

test("swallowNextClick: once the timeout passes, a later click goes through", () => {
  const target = new EventTarget();
  let disarm: (() => void) | null = null;
  swallowNextClick(target, 400, (fn) => (disarm = fn));
  disarm!();
  const click = new Event("click", { cancelable: true });
  target.dispatchEvent(click);
  assert.equal(click.defaultPrevented, false);
});
