// Access-control e2e (INNOBOX_SPEC.md §2.1 invariant 2, §4): every page except the Home landing
// requires a session, and the Administration console is restricted to admins. Two checks: an
// unauthenticated visitor is redirected to the sign-in landing, and a signed-in non-admin member
// is refused the /admin console in-page.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("access control: an unauthenticated visitor is redirected to the sign-in landing", async ({ browser }) => {
  const ctx = await browser.newContext(); // no sign-in
  const page = await ctx.newPage();
  await page.goto("/challenges");
  // The middleware redirects protected routes to the Home landing (the sign-in surface),
  // preserving the intended path as callbackUrl (ENTRA_AUTH_SPEC.md §5).
  await expect(page).toHaveURL(/\/\?callbackUrl=%2Fchallenges/);
  // The landing offers the in-shell Entra sign-in in place of the account menu.
  await expect(page.getByRole("button", { name: "Sign in with Entra ID" })).toBeVisible();
  await ctx.close();
});

test("sign-in landing: signed-out Home shows the Entra button, no nav links, and no dashboard data", async ({ browser }) => {
  const ctx = await browser.newContext(); // no sign-in
  const page = await ctx.newPage();
  await page.goto("/");
  // The Home landing is public and renders for unauthenticated visitors (INNOBOX_SPEC.md §13.2)…
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Ideas worth building start here" })).toBeVisible();
  // …with the Entra sign-in in the account-menu slot and NO nav links (§2.2)…
  await expect(page.getByRole("button", { name: "Sign in with Entra ID" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Leaderboard" })).toHaveCount(0);
  // …and no protected dashboard data is fetched or shown while signed out (§13.2, invariant 2).
  await expect(page.getByRole("link", { name: "Browse challenges" })).toHaveCount(0);
  await ctx.close();
});

test("access control: a non-admin member is refused the Administration console", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Member ${stamp}` }); // admin flag off → plain member
  const page = await ctx.newPage();

  // A signed-in member reaches the app…
  await page.goto("/challenges");
  await expect(page).toHaveURL(/\/challenges$/);

  // …but /admin gates them in-page (the API routes are the authoritative gate; this is the UI).
  await page.goto("/admin");
  await expect(page.getByText("Administration is restricted")).toBeVisible();
  await expect(page.getByText(/namespace admin or platform admin rights/i)).toBeVisible();

  await ctx.close();
});
