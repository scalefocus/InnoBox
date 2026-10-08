// Presentation rules for the §13.1 challenge detail page that are worth pinning in a unit test.
// Client-safe: no imports. The server stays authoritative (it refuses a proposal off `valid` and
// a like on a solved challenge); these only explain a disabled control to the viewer.

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

/** §8.3: the hint on a frozen like button (the count stays displayed). */
export const LIKES_FROZEN_HINT = "Likes are closed because this challenge is solved.";
