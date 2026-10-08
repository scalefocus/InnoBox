// Directory hover card e2e (INNOBOX_SPEC.md §13.8): hovering an avatar bubble opens a floating
// card with the person's directory profile and a link to their full profile; keyboard focus opens
// it and Escape closes it; and — the invariant-3 case — an ANONYMOUS author's bubble opens no card
// and issues no request at all, so nothing distinguishes two anonymous authors.
//
// Dev-auth personas carry no department/job title/office (those are Entra attributes written by
// reconciliation, §3), so the card's directory block legitimately renders its degraded
// "No directory information." state here — which is exactly the graceful-degradation contract the
// spec requires, and is asserted as such.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";

test("directory card: hover opens it, keyboard reaches it, and an anonymous author never gets one", async ({ browser }) => {
  test.slow(); // Next dev-mode first-hit route compilation

  const stamp = Date.now().toString(36);
  const authorName = `E2E Card Author ${stamp}`;

  const ctx = await browser.newContext();
  await signIn(ctx, { name: authorName });

  const named = await createChallengeViaApi(ctx.request, {
    title: `E2E card named challenge ${stamp}`,
    description: "Raised by the directory-card e2e suite.",
  });
  const anon = await createChallengeViaApi(ctx.request, {
    title: `E2E card anonymous challenge ${stamp}`,
    description: "Raised anonymously by the directory-card e2e suite.",
    isAnonymous: true,
  });

  const page = await ctx.newPage();

  // Every /api/users/:id/card request this page makes, in order — the lazy-fetch and
  // anonymity assertions below are both about *whether one happens at all*.
  const cardRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/users\/[^/]+\/card(\?|$)/.test(req.url())) cardRequests.push(req.url());
  });

  // ── a named author's bubble ──────────────────────────────────────────────────────────────
  await page.goto(`/challenges/${named.digits}`);
  await expect(page.getByRole("heading", { name: named.title })).toBeVisible();

  const authorBubble = page.locator(".avatar.avatar-md[role='button']").first();
  await expect(authorBubble).toBeVisible();
  // Lazy: nothing is fetched on render, only on hover intent.
  expect(cardRequests, "no card request before any hover").toHaveLength(0);

  const cardResponse = page.waitForResponse((res) => /\/api\/users\/[^/]+\/card(\?|$)/.test(res.url()));
  await authorBubble.hover();
  const card = page.getByRole("dialog", { name: authorName });
  await expect(card).toBeVisible();
  expect(cardRequests.length, "hovering fetches the card exactly once").toBe(1);
  // §13.8: the body is the flat card — no wrapper key.
  const body = await (await cardResponse).json();
  expect(Object.keys(body).sort()).toEqual(
    ["deactivated", "department", "displayName", "jobTitle", "officeLocation", "scrubbed", "userId"],
  );
  expect(body.displayName).toBe(authorName);

  await expect(card.getByText(authorName)).toBeVisible();
  // A dev persona has no Entra directory attributes → the degraded state, never an error.
  await expect(card.getByText("No directory information.")).toBeVisible();
  // The card is a dead end without this link (§13.8) — InnoBox has a real profile page.
  await expect(card.getByRole("link", { name: "View profile" })).toBeVisible();

  // ── keyboard: focus opens with no delay, Escape closes and returns focus ─────────────────
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  // Escape leaves focus on the bubble — and handing it back must not reopen the card.
  await expect(authorBubble).toBeFocused();
  await expect(card).toBeHidden();

  // Focus arriving afresh opens the card with no delay.
  await authorBubble.blur();
  await authorBubble.focus();
  await expect(page.getByRole("dialog", { name: authorName })).toBeVisible();
  // Re-hovering/re-opening is served from the per-page-session cache — no second request.
  expect(cardRequests.length, "the card is cached per user id for the page session").toBe(1);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: authorName })).toBeHidden();
  await expect(authorBubble).toBeFocused();

  // ── the anonymous author: no card, no request, no tab stop (invariant 3) ─────────────────
  const before = cardRequests.length;
  await page.goto(`/challenges/${anon.digits}`);
  await expect(page.getByRole("heading", { name: anon.title })).toBeVisible();

  const anonBubble = page.locator(".avatar-anon").first();
  await expect(anonBubble).toBeVisible();
  // Not a trigger at all: no button role, so no tab stop and no handlers.
  await expect(page.locator(".avatar-anon[role='button']")).toHaveCount(0);

  await anonBubble.hover();
  // Well past the 300 ms hover-intent threshold — nothing must open, ever.
  await page.waitForTimeout(700);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(cardRequests.length, "an anonymous author's bubble issues NO card request").toBe(before);

  await ctx.close();
});
