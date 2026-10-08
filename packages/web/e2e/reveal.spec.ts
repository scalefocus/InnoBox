// Anonymity reveal e2e (INNOBOX_SPEC.md §9; invariant 3). Masking itself is covered by
// anonymity.spec.ts; this covers the two audited ways an anonymous author is un-masked:
//   1. Admin "Reveal author" — transient, shown to that admin only ("Revealed to you only").
//   2. Author "Reveal myself (permanent)" — a one-way flip that persists for everyone.
// Personas are named to avoid any control-label substring (the account-menu trigger is named
// after the persona, so a substring match would collide with a button — see lifecycle.spec.ts).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi } from "./helpers/api";

test("an admin can reveal an anonymous author transiently (to themselves only)", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const realName = `E2E Hidden Person ${stamp}`;

  const authorCtx = await browser.newContext();
  await signIn(authorCtx, { name: realName });
  const challenge = await createChallengeViaApi(authorCtx.request, {
    title: `E2E reveal challenge ${stamp}`,
    description: "Raised anonymously.",
    isAnonymous: true,
  });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Unmask Admin ${stamp}`, admin: true });
  const admin = await adminCtx.newPage();
  await admin.goto(`/challenges/${challenge.digits}`);

  // Masked to the admin at first…
  await expect(admin.locator(".ttl", { hasText: "Anonymous" })).toBeVisible();
  await expect(admin.locator(".ttl", { hasText: realName })).toHaveCount(0);

  // …then the audited reveal surfaces the real identity, flagged as visible to this admin only.
  await admin.getByRole("button", { name: "Reveal author", exact: true }).click();
  await expect(admin.locator(".ttl", { hasText: realName })).toBeVisible();
  await expect(admin.getByText("Revealed to you only")).toBeVisible();

  await authorCtx.close();
  await adminCtx.close();
});

test("an anonymous author can permanently reveal themselves", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const realName = `E2E Owning Person ${stamp}`;

  const authorCtx = await browser.newContext();
  await signIn(authorCtx, { name: realName });
  const challenge = await createChallengeViaApi(authorCtx.request, {
    title: `E2E self-reveal challenge ${stamp}`,
    description: "Raised anonymously, then owned.",
    isAnonymous: true,
  });

  const author = await authorCtx.newPage();
  await author.goto(`/challenges/${challenge.digits}`);
  // Anonymity is total even in the author's own view until they choose to reveal.
  await expect(author.locator(".ttl", { hasText: "Anonymous" })).toBeVisible();

  // Self-reveal is confirm-guarded and permanent.
  author.on("dialog", (d) => d.accept());
  await author.getByRole("button", { name: "Reveal myself (permanent)" }).click();
  await expect(author.locator(".ttl", { hasText: realName })).toBeVisible();

  // The flip persists: after a reload the byline is still the real name, no longer "Anonymous".
  await author.reload();
  await expect(author.locator(".ttl", { hasText: realName })).toBeVisible();
  await expect(author.locator(".ttl", { hasText: "Anonymous" })).toHaveCount(0);

  await authorCtx.close();
});
