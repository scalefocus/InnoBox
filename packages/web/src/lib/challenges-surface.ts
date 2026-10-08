// The "Challenges surface" for the §13.1 new-since-your-last-visit marker (INNOBOX_SPEC.md):
// the gallery (/challenges) and its detail pages (/challenges/:number) share one marker, which
// the app shell advances when the user LEAVES the surface — never on entry — so the count and
// the card tags stay stable for the whole visit. The submission form (/challenges/new) is not
// part of it: writing a challenge is not browsing them. Pure, dependency-free, unit-tested.

export function isChallengesSurface(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === "/challenges") return true;
  return /^\/challenges\/(?:CH-)?\d+\/?$/i.test(pathname);
}

/** True when a navigation from `previous` to `next` leaves the surface — the moment the marker
 *  advances. Moving between the gallery and a detail page is not a leave. */
export function leavesChallengesSurface(previous: string | null | undefined, next: string | null | undefined): boolean {
  return isChallengesSurface(previous) && !isChallengesSurface(next);
}
