// The standalone frame of the §24.3 public pages (INNOBOX_SPEC.md §24.3): the InnoBox logo on top,
// the page's card, and a small "Work here? Sign in" link to the Home landing. No sidebar, account
// menu, search, colophon or version number. The link is a plain anchor — a full page load — since
// the root layout renders these pages outside the app shell and its session provider.
import type { ReactNode } from "react";

export function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <main className="public-page">
      <header className="public-head">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand logo, not an optimizable photo */}
        <img className="brand-logo brand-logo--light" src="/brand/innobox-light.png" alt="InnoBox" width={1041} height={200} />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand logo, not an optimizable photo */}
        <img className="brand-logo brand-logo--dark" src="/brand/innobox-dark.png" alt="InnoBox" width={1041} height={200} />
      </header>
      <div className="card card-pad public-card">{children}</div>
      <p className="public-foot">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full page load into the app shell */}
        Work here? <a href="/">Sign in</a>
      </p>
    </main>
  );
}
