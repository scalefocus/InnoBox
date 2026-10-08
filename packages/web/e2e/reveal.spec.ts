// Anonymity reveal e2e (INNOBOX_SPEC.md §9; invariant 3). Masking itself is covered by
// anonymity.spec.ts; this covers the two audited ways an anonymous author is un-masked:
//   1. Admin "Reveal author" — transient, shown to that admin only in the reveal dialog
//      ("Revealed to you only", large avatar bubble), on the challenge and on each solution.
//   2. Author "Reveal myself (permanent)" — a one-way flip that persists for everyone, on the
//      challenge and on each solution.
// Personas are named to avoid any control-label substring (the account-menu trigger is named
// after the persona, so a substring match would collide with a button — see lifecycle.spec.ts).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, proposeSolutionViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";

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

  // …then the audited reveal opens the reveal dialog: the real identity with the large avatar
  // bubble, flagged as visible to this admin only.
  await admin.getByRole("button", { name: "Reveal author", exact: true }).click();
  const dialog = admin.getByRole("dialog", { name: realName });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Revealed to you only")).toBeVisible();
  await expect(dialog.locator(".avatar-lg")).toBeVisible();

  // Transient: closing the dialog leaves the byline masked — nothing was persisted.
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(admin.locator(".ttl", { hasText: "Anonymous" })).toBeVisible();
  await expect(admin.getByText(realName)).toHaveCount(0);

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

test("a solution's anonymous author: admin reveal in the dialog, and one-way self-reveal", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const proposerName = `E2E Quiet Proposer ${stamp}`;

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Solution Unmask Admin ${stamp}`, admin: true });
  const challenge = await createChallengeViaApi(adminCtx.request, {
    title: `E2E solution reveal ${stamp}`,
    description: "Open for an anonymous proposal.",
  });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

  const proposerCtx = await browser.newContext();
  await signIn(proposerCtx, { name: proposerName });
  const solution = await proposeSolutionViaApi(proposerCtx.request, challenge.digits, {
    description: `Anonymous fix ${stamp}`,
    isAnonymous: true,
  });
  await setSolutionStatusViaApi(adminCtx.request, solution.digits, "in_review");

  // Admin: the solution row carries its own "Reveal author"; the dialog names the proposer.
  const admin = await adminCtx.newPage();
  await admin.goto(`/challenges/${challenge.digits}`);
  const adminRow = admin.locator(`[id="${solution.number}"]`);
  await expect(adminRow.getByText("Anonymous")).toBeVisible();
  await adminRow.getByRole("button", { name: "Reveal author", exact: true }).click();
  const dialog = admin.getByRole("dialog", { name: proposerName });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(solution.number)).toBeVisible();
  await expect(dialog.getByText("Revealed to you only")).toBeVisible();
  await admin.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(adminRow.getByText("Anonymous")).toBeVisible();

  // Proposer: no admin reveal, but a one-way self-reveal on their own solution.
  const proposer = await proposerCtx.newPage();
  await proposer.goto(`/challenges/${challenge.digits}`);
  const ownRow = proposer.locator(`[id="${solution.number}"]`);
  await expect(ownRow.getByRole("button", { name: "Reveal author", exact: true })).toHaveCount(0);
  proposer.on("dialog", (d) => d.accept());
  await ownRow.getByRole("button", { name: "Reveal myself (permanent)" }).click();
  await expect(ownRow.getByText(proposerName)).toBeVisible();
  await proposer.reload();
  await expect(proposer.locator(`[id="${solution.number}"]`).getByText(proposerName)).toBeVisible();

  await adminCtx.close();
  await proposerCtx.close();
});
