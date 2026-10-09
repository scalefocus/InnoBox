// Root layout (INNOBOX_SPEC.md §2.2): the InnoBox brand via self-hosted variable fonts
// (@fontsource — no font CDNs), the token sheet in globals.css, light + dark themes on
// [data-theme], and the shared date formatter provider at the tree root.
import "@fontsource-variable/montserrat/index.css";
import "@fontsource-variable/open-sans/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./globals.css";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { Providers } from "@/components/Providers";
import { DateFormatProvider } from "@/components/DateFormat";
import { AppShell } from "@/components/AppShell";
import { NONCE_HEADER } from "@/lib/security-headers";
import { enforceQuickStart } from "@/lib/quick-start-gate";

const DESCRIPTION =
  "Challenge & solution management — raise challenges, propose solutions, drive them to implementation.";
// Absolute base for resolving the Open Graph / Twitter image + URL (INNOBOX_SPEC.md §2.2). Derives
// from the one canonical URL (§2.3 PUBLIC_BASE_URL). No deployment-specific default lives in the
// repository (§2.3), so an unset value falls back to the local dev origin, never to a real host.
const BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

// Social-share (Open Graph) card, §2.2: a single static app-level card served from the already-public
// /brand tree. There are deliberately no per-challenge/per-solution cards — every route but "/" 302s an
// unauthenticated scraper to sign-in (invariant 2), and per-resource cards would leak titles/authors.
export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: "InnoBox",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "InnoBox",
    title: "InnoBox",
    description: DESCRIPTION,
    url: "/",
    images: [{ url: "/brand/og-card.png", width: 1200, height: 630, alt: "InnoBox — Ideas worth building start here" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "InnoBox",
    description: DESCRIPTION,
    images: ["/brand/og-card.png"],
  },
};

// Runs before paint (blocking, first thing in <body>) so the page never flashes the wrong
// theme: an explicit user choice from localStorage wins, otherwise follow the OS. It carries the
// per-request CSP nonce the middleware minted (§2.4 — the CSP has no 'unsafe-inline' script
// source); reading the request header also keeps every page dynamically rendered, which a
// per-request nonce requires (a statically prerendered page could not carry one).
const THEME_INIT = `(function(){try{var s=localStorage.getItem("innobox.theme");var t=s==="light"||s==="dark"?s:window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // §13.7: a signed-in user who has never completed /quick-start is redirected there before the
  // requested page renders (priority over a deep-link callbackUrl).
  await enforceQuickStart();
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <Providers>
          <DateFormatProvider>
            <AppShell>{children}</AppShell>
          </DateFormatProvider>
        </Providers>
      </body>
    </html>
  );
}
