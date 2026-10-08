// Presentation-only status labels/colors for the Challenges page (INNOBOX_SPEC.md §7.1,
// §8.1, §2.2 "status colors map to the semantic tokens"). Not shared with the API layer —
// this is purely how a status renders in a pill.

export const CHALLENGE_STATUS_LABEL: Record<string, string> = {
  awaiting_triage: "Awaiting triage",
  in_review: "In review",
  needs_improvement: "Needs improvement",
  meeting_scheduled: "Meeting with author",
  valid: "Valid — open for solutions",
  solved: "Solved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export const SOLUTION_STATUS_LABEL: Record<string, string> = {
  proposed: "Proposed",
  in_review: "In review",
  needs_improvement: "Needs improvement",
  valid: "Valid",
  accepted_internally: "Accepted internally",
  waiting_for_resources: "Waiting for resources",
  in_implementation: "In implementation",
  external_acceptance: "External acceptance",
  implemented: "Implemented",
  rejected: "Rejected",
  not_selected: "Not selected",
  withdrawn: "Withdrawn",
};

const OK = new Set(["valid", "solved", "implemented"]);
const WARN = new Set(["in_review", "needs_improvement", "meeting_scheduled", "waiting_for_resources"]);
const DANGER = new Set(["rejected"]);
const MUTED = new Set(["withdrawn", "not_selected"]);

/** §2.2: --ok for valid/implemented, --warn for in-review/needs-improvement, --danger for
 *  rejected, --accent for informational states (everything else). */
export function statusPillClass(status: string): string {
  if (OK.has(status)) return "pill pill-ok";
  if (WARN.has(status)) return "pill pill-warn";
  if (DANGER.has(status)) return "pill pill-danger";
  if (MUTED.has(status)) return "pill pill-muted";
  return "pill pill-accent";
}
