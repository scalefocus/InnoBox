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
