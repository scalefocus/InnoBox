"use client";
// Client provider boundary for the whole app tree. Wraps next-auth's SessionProvider so the
// shell and pages can read the session via useSession() as a three-state signal
// (loading / authenticated / unauthenticated) — the basis for the in-shell sign-in UX:
// nav + account menu when signed in, the "Sign in with Entra ID" control when not
// (ENTRA_AUTH_SPEC.md §5, INNOBOX_SPEC.md §2.2).
import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
