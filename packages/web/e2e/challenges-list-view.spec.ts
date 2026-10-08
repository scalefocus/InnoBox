// Cards / List view toggle on the Challenges gallery (INNOBOX_SPEC.md §13.1). The choice is a
// per-browser presentation preference (localStorage `innobox:challenges-view`): it survives a
// reload, the list row opens the challenge when clicked anywhere (not just on the title), and a
// challenge that is new to the viewer carries the same "new" tag in the list as on its card.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";

test("the list view persists across reloads, rows navigate, and new items keep their tag", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  const viewerCtx = await browser.newContext();
  await signIn(viewerCtx, { name: `E2E ListView Viewer ${stamp}` });
  const viewer = await viewerCtx.newPage();

  // Visit the gallery and leave it, so the new-since-last-visit marker is set before the fixture
  // exists (the marker advances on LEAVING the Challenges surface).
  await viewer.goto("/challenges");
  await expect(viewer.getByRole("heading", { name: "Ideas worth building" })).toBeVisible();
  const seen = viewer.waitForResponse((r) => r.url().includes("/api/me/challenges-seen") && r.request().method() === "POST");
  await viewer.getByRole("link", { name: "Leaderboard" }).click();
  await expect(viewer).toHaveURL(/\/leaderboard/);
  await seen;

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E ListView Admin ${stamp}`, admin: true });
  const title = `E2E list view challenge ${stamp}`;
  const created = await createChallengeViaApi(adminCtx.request, { title, description: "Shown as a row." });
  await setChallengeStatusViaApi(adminCtx.request, created.digits, "valid");

  // Default is Cards.
  await viewer.goto("/challenges");
  const cardsBtn = viewer.getByRole("button", { name: "Cards", exact: true });
  const listBtn = viewer.getByRole("button", { name: "List", exact: true });
  await expect(cardsBtn).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.locator(".skill-card", { hasText: title })).toBeVisible();

  // Switch to List — the same item renders as a row, with its "new" tab.
  await listBtn.click();
  await expect(listBtn).toHaveAttribute("aria-pressed", "true");
  const row = viewer.locator(".ch-row", { hasText: title });
  await expect(row).toBeVisible();
  await expect(viewer.locator(".skill-card")).toHaveCount(0);
  await expect(row.locator(".chip-new")).toBeVisible();
  await expect(row.getByRole("link", { name: title })).toHaveAttribute("href", `/challenges/${created.digits}`);

  // The preference survives a reload.
  await viewer.reload();
  await expect(viewer.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.locator(".ch-row", { hasText: title })).toBeVisible();

  // Clicking the row away from the title opens the challenge.
  await viewer.locator(".ch-row", { hasText: title }).locator(".ch-c-date").click();
  await expect(viewer).toHaveURL(new RegExp(`/challenges/${created.digits}$`));

  // Back to Cards, persisted the other way too.
  await viewer.goto("/challenges");
  await viewer.getByRole("button", { name: "Cards", exact: true }).click();
  await viewer.reload();
  await expect(viewer.getByRole("button", { name: "Cards", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(viewer.locator(".skill-card", { hasText: title })).toBeVisible();

  await viewerCtx.close();
  await adminCtx.close();
});
