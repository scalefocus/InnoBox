// Anonymity e2e (INNOBOX_SPEC.md §9, invariant 3): an anonymously-submitted challenge is masked
// as "Anonymous" everywhere at the API layer — including in the author's OWN detail view. Real
// identity is only ever exposed through the audited admin reveal (not exercised here).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("anonymity: an anonymous challenge is masked as 'Anonymous', even to its author", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const authorName = `E2E Anon Author ${stamp}`;
  const title = `E2E anonymous challenge ${stamp}`;

  const ctx = await browser.newContext();
  await signIn(ctx, { name: authorName });
  const page = await ctx.newPage();

  await page.goto("/challenges/new");
  await page.locator("#title").fill(title);
  await page.locator("#description").fill("Raised anonymously by the e2e suite.");
  await page.locator("#impactArea").selectOption({ label: "Internal" });
  await page.getByRole("checkbox", { name: "Submit anonymously" }).check();
  await page.getByRole("button", { name: "Submit challenge" }).click();

  await page.waitForURL(/\/challenges\/\d+$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  // The author byline (a `.ttl`) must read "Anonymous" — masking is total, even in the author's
  // own view (invariant 3). We scope to `.ttl` because the signed-in user's real name legitimately
  // appears elsewhere in the app chrome (account menu / colophon); it must never appear in a byline.
  await expect(page.locator(".ttl", { hasText: "Anonymous" })).toBeVisible();
  await expect(page.locator(".ttl", { hasText: authorName })).toHaveCount(0);

  // §13.6 avatar bubble: the author byline shows the generic ANONYMOUS bubble (.avatar-anon) —
  // never a photo or per-user color that could fingerprint the author (invariant 3). The header
  // author bubble is the md one; assert at least one anonymous bubble is present.
  await expect(page.locator(".avatar-anon").first()).toBeVisible();
  // And there must be no photo <img> for the author (anonymous → userId null → no gateway request).
  await expect(page.locator(".avatar-anon img")).toHaveCount(0);

  // §9: the anonymous author is warned that commenting shows their real name (comments are never
  // anonymous) without revealing them as the author.
  await expect(page.getByText(/Commenting won.t reveal you as the author/i)).toBeVisible();

  await ctx.close();
});
