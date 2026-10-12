// Presentation rules for the §13.1 challenge detail page that are worth pinning in a unit test.
// Client-safe: no imports. The server stays authoritative (it refuses a proposal off `valid` and
// a like on a closed challenge); these only explain a disabled control to the viewer, or decide
// where an item is listed.

/** §6.2/§13.1: "Propose a solution" is visible to every viewer of the challenge and enabled only
 *  while it is `valid`. Returns the short reason shown beside the disabled button, or null when
 *  proposing is open. */
export function proposeDisabledReason(status: string): string | null {
  switch (status) {
    case "valid":
      return null;
    case "solved":
      return "This challenge is solved, so it no longer accepts solutions.";
    case "rejected":
    case "withdrawn":
      return "This challenge is closed, so it does not accept solutions.";
    default:
      return "Solutions can be proposed once the challenge has been validated.";
  }
}

/** §8.3: the hint on a frozen like button (the count stays displayed). Names no status: the
 *  freeze covers every closed challenge (solved, rejected, withdrawn). */
export const LIKES_FROZEN_HINT = "Likes are closed for this challenge";

const CLOSED_SOLUTION_STATUSES: ReadonlySet<string> = new Set(["rejected", "not_selected", "withdrawn"]);

/** §4.3: the detail page lists `rejected` / `not_selected` / `withdrawn` solutions in a collapsed
 *  "Closed solutions" section below the open list; its `Solutions (n)` heading counts only the
 *  open list. Order is preserved within each half. */
export function splitSolutions<T extends { status: string }>(solutions: readonly T[]): { open: T[]; closed: T[] } {
  const open: T[] = [];
  const closed: T[] = [];
  for (const s of solutions) (CLOSED_SOLUTION_STATUSES.has(s.status) ? closed : open).push(s);
  return { open, closed };
}
