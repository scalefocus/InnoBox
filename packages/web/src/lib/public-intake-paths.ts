// The §24 public submission surface's paths (INNOBOX_SPEC.md §24, §2.1 invariant 2): the second
// and only other unauthenticated surface after the signed-out Home. Pure and dependency-free, so
// the edge middleware (routeAccess), the quick-start gate and the root layout share one list.
// Whether the feature is ON is not decided here — the pages and routes answer 404 themselves
// while the switch is off (§24.2), which the edge layer (no database) cannot know.

/** The form and its confirmation page — rendered outside AppShell. */
export const PUBLIC_FORM_PATH = "/submit";
export const PUBLIC_CONFIRM_PATH = "/submit/confirm";

/** The four public API routes (§24.9). */
export const PUBLIC_API_PATHS: readonly string[] = [
  "/api/public/settings",
  "/api/public/pow",
  "/api/public/submissions",
  "/api/public/confirm",
];

/** True for /submit and /submit/confirm (exact paths only). */
export function isPublicFormPath(pathname: string): boolean {
  return pathname === PUBLIC_FORM_PATH || pathname === PUBLIC_CONFIRM_PATH;
}

/** True for one of the four public API routes (exact paths only). */
export function isPublicIntakeApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.includes(pathname);
}
