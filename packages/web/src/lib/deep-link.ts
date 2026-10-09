// The §12.1 deep-link convention (INNOBOX_SPEC.md §12.1, §13.1): a challenge resolves to
// `/challenges/<n>`, and a solution — which has no standalone page — to its parent challenge's
// page scrolled to it, `/challenges/<n>#SOL-<m>`. Every notification link, autocomplete row, and
// audit-browser target uses this one helper, so a solution link can never silently drop its
// anchor. Pure and client-safe. Accepts `CH-12` / `12` / 12 alike.

const digits = (n: string | number): string => String(n).replace(/\D/g, "");

export function itemHref(challengeNumber: string | number, solutionNumber?: string | number | null): string {
  const base = `/challenges/${digits(challengeNumber)}`;
  return solutionNumber === undefined || solutionNumber === null || solutionNumber === "" ? base : `${base}#SOL-${digits(solutionNumber)}`;
}
