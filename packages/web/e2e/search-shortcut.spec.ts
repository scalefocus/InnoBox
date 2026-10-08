// Global search shortcut (INNOBOX_SPEC.md §13.4): Ctrl+K/Cmd+K focuses the topbar search from
// anywhere while signed in, without stealing focus from an in-progress edit elsewhere.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

const searchInput = (page: import("@playwright/test").Page) => page.getByPlaceholder("Search challenges & solutions…");

test("Ctrl+K focuses the topbar search from any page", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Shortcut ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/challenges");
  await expect(searchInput(page)).not.toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(searchInput(page)).toBeFocused();

  await ctx.close();
});

test("Ctrl+K does not steal focus from an in-progress edit in another field", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E ShortcutGuard ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/challenges/new");
  await page.locator("#title").fill("Draft title before shortcut");
  await page.locator("#title").focus();
  await page.keyboard.press("Control+k");
  await expect(page.locator("#title")).toBeFocused();
  await expect(searchInput(page)).not.toBeFocused();

  await ctx.close();
});

test("a grey shortcut-hint pill advertises the combo and hides once the field is focused", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E ShortcutHint ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/challenges");
  const hint = page.locator(".search kbd");
  await expect(hint).toBeVisible();
  // OS-aware: Ctrl+K off a Mac, ⌘K on one — accept either so the test isn't runner-OS-bound.
  await expect(hint).toHaveText(/^(Ctrl\+K|⌘K)$/);

  // Focusing the search hides the hint (it's served its purpose); blurring brings it back.
  await searchInput(page).focus();
  await expect(hint).toBeHidden();
  await searchInput(page).blur();
  await expect(hint).toBeVisible();

  await ctx.close();
});

// Clear button + progressive Escape (INNOBOX_SPEC.md §13.4).
const clearButton = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Clear search" });

test("a clear button appears from the first character and clears the field, keeping focus", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E SearchClear ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/challenges");
  // Empty field: no clear button.
  await expect(clearButton(page)).toBeHidden();

  // A single character is enough to reveal it (before the ≥2-char autocomplete threshold).
  await searchInput(page).fill("a");
  await expect(clearButton(page)).toBeVisible();

  await searchInput(page).fill("anything");
  await clearButton(page).click();
  await expect(searchInput(page)).toHaveValue("");
  await expect(searchInput(page)).toBeFocused();
  // Once cleared, the button is gone again.
  await expect(clearButton(page)).toBeHidden();

  await ctx.close();
});

test("Escape progressively clears the field, then exits it when already empty", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E SearchEscape ${stamp}` });
  const page = await ctx.newPage();

  await page.goto("/challenges");
  await searchInput(page).fill("clear me");

  // First Escape clears the text but keeps focus so the user can retype.
  await page.keyboard.press("Escape");
  await expect(searchInput(page)).toHaveValue("");
  await expect(searchInput(page)).toBeFocused();

  // Second Escape, on the now-empty field, blurs it (exits the field).
  await page.keyboard.press("Escape");
  await expect(searchInput(page)).not.toBeFocused();

  await ctx.close();
});

test("the clear button is suppressed on the mobile layout", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E SearchClearMobile ${stamp}` });
  const page = await ctx.newPage();

  // Below the 880px shell breakpoint the clear button is hidden (like the shortcut pill).
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto("/challenges");
  await searchInput(page).fill("text with no clear button here");
  await expect(clearButton(page)).toBeHidden();

  await ctx.close();
});
