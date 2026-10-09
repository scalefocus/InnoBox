// Auth.js page routing + the sign-in error copy (ENTRA_AUTH_SPEC.md §5 "Sign-in UI";
// INNOBOX_SPEC.md §13.2). There is NO default Auth.js page: the Home landing `/` is both the
// sign-in surface and the error surface. A refused `signIn` callback (a deactivated account, or
// the §3 UPN-collision refusal) makes Auth.js redirect to `/api/auth/error?error=AccessDenied`,
// which — with `pages.error` set — redirects on to `/?error=AccessDenied` instead of rendering
// the built-in error page. Codes Auth.js routes through its sign-in action (OAuthCallback,
// Callback, …) land on `pages.signIn`, also `/`, with the same `?error=` parameter.
// Client-safe: imported by the landing page as well as by authOptions.

export const AUTH_PAGES = { signIn: "/", error: "/" } as const;

/** The short message the signed-out landing shows for an Auth.js `?error=` code. */
export function authErrorMessage(code: string): string {
  switch (code) {
    case "AccessDenied":
      // Deactivated accounts and refused identity collisions both arrive as AccessDenied.
      return "Sign-in was refused — your account may have been deactivated. Contact an administrator if you believe this is a mistake.";
    case "Configuration":
      return "Sign-in is unavailable right now. Please try again later or contact an administrator.";
    default:
      return "Sign-in failed. Please try again.";
  }
}
