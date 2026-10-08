// "New since your last visit" e2e (INNOBOX_SPEC.md §13.1). A member who has been to the
// Challenges page and left sees a bubble on the Challenges nav item once a new challenge becomes
// visible to them, the new card carries a "new" tag, and leaving the page again clears both.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";

test("new challenges light up the nav bubble and the card tag until the visitor leaves", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  const viewerCtx = await browser.newContext();
  await signIn(viewerCtx, { name: `E2E NewMarker Viewer ${stamp}` });
  const viewer = await viewerCtx.newPage();
  // Visit the gallery, then leave it: the marker advances on LEAVING, so from here on only
  // genuinely newer challenges count for this person.
  await viewer.goto("/challenges");
  await expect(viewer.getByRole("heading", { name: "Ideas worth building" })).toBeVisible();
  await viewer.getByRole("link", { name: "Leaderboard" }).click();
  await expect(viewer).toHaveURL(/\/leaderboard/);
  const challengesNav = viewer.getByRole("link", { name: /^Challenges/ });
  await expect(challengesNav.locator(".nav-badge")).toHaveCount(0, { timeout: 45_000 });

  // An admin submits a challenge and triages it to `valid`, which is what makes it visible to
  // everyone (an awaiting_triage item is hidden from other members, so it would not count).
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E NewMarker Admin ${stamp}`, admin: true });
  const title = `E2E brand new challenge ${stamp}`;
  const created = await createChallengeViaApi(adminCtx.request, { title, description: "Fresh off the press." });
  await setChallengeStatusViaApi(adminCtx.request, created.digits, "valid");

  // The bubble appears within one poll.
  await expect(challengesNav.locator(".nav-badge")).toHaveText(/^[1-9]/, { timeout: 45_000 });

  // The card carries the tag.
  await viewer.goto("/challenges");
  const card = viewer.locator(".skill-card", { hasText: title });
  await expect(card).toBeVisible();
  await expect(card.locator(".chip-new")).toBeVisible();

  // Leaving the surface clears the bubble.
  await viewer.getByRole("link", { name: "Home" }).click();
  await expect(viewer).toHaveURL(/\/$/);
  await expect(challengesNav.locator(".nav-badge")).toHaveCount(0, { timeout: 45_000 });
  // …and the tag is gone on the next visit.
  await viewer.goto("/challenges");
  await expect(viewer.locator(".skill-card", { hasText: title })).toBeVisible();
  await expect(viewer.locator(".skill-card", { hasText: title }).locator(".chip-new")).toHaveCount(0);

  await viewerCtx.close();
  await adminCtx.close();
});
