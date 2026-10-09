// Dev-auth sign-in helper for e2e (INNOBOX_SPEC.md §17). Real Entra OIDC can't run headless, so
// tests use the INNOBOX_DEV_AUTH Credentials provider (authOptions.ts). There is no default
// Auth.js page anymore (ENTRA_AUTH_SPEC.md §5) — the dev credentials form lives on the Home
// landing as a dev-only panel — so we drive that panel. next-auth's client signIn() handles CSRF
// natively; the session cookie lands on the BrowserContext's jar, so every page opened in that
// context is authenticated as this persona.
//
// Personas: dev users are keyed by a slug of the display name (external_id = dev-<slug>), so a
// distinct name is a distinct user. `admin: true` grants platform_admin (dev group + mapping).
import type { BrowserContext } from "@playwright/test";

export function devSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Sign a persona in on `context`. Idempotent (upserts the dev user). Throws on failure.
 *  `freshOnboarding: true` leaves a newly created persona unseen for /quick-start
 *  (INNOBOX_SPEC.md §13.7) — only the dedicated onboarding spec needs this; every other
 *  caller gets the default (already seen), so the auto-redirect never interferes with
 *  their test's own navigation. */
export async function signIn(
  context: BrowserContext,
  opts: { name: string; admin?: boolean; freshOnboarding?: boolean },
): Promise<{ userId: string }> {
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`);
    await page.locator("#dev-name").fill(opts.name);
    await page.locator("#dev-email").fill(`${devSlug(opts.name)}@dev.local`);
    await page.locator("#dev-admin").fill(opts.admin ? "1" : "0");
    await page.locator("#dev-fresh-onboarding").fill(opts.freshOnboarding ? "1" : "0");
    await page.getByRole("button", { name: "Dev sign-in" }).click();
    // On success the app returns to "/" authenticated and the account menu (.user-trigger, rendered
    // only when signed in) appears; on failure it stays on the signed-out landing with the dev
    // panel — so waiting for the account menu both confirms success and fails fast otherwise.
    // 30 s like the suite's expect timeout: a fresh-onboarding persona is redirected to
    // /quick-start server-side, and that route's first hit compiles cold in dev mode.
    await page.locator(".user-trigger").waitFor({ state: "visible", timeout: 30_000 });

    const meRes = await context.request.get(`${base}/api/me`, { headers: { accept: "application/json" } });
    const me = (await meRes.json()) as { user?: { id?: string }; roles?: { platformAdmin?: boolean } };
    if (!me?.user?.id) throw new Error(`dev sign-in did not establish a session for "${opts.name}" (status ${meRes.status()})`);
    if (opts.admin && !me.roles?.platformAdmin) throw new Error(`"${opts.name}" signed in but is not a platform admin`);
    return { userId: me.user.id };
  } finally {
    await page.close();
  }
}
