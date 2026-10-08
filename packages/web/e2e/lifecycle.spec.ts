// Challenge + solution lifecycle e2e (INNOBOX_SPEC.md §7, §8, §10.1; invariant 7). Covers the
// high-value state-machine outcomes that the browse/detail UI renders:
//   1. §8.3 single-winner — implementing one solution auto-solves the challenge and closes its
//      siblings as `not_selected`.
//   2. §10.1 needs-improvement — moving a challenge to `needs_improvement` unlocks the author's
//      Edit + Resubmit controls; resubmitting returns it to review.
//   3. §10.1 withdrawal — the author withdraws their challenge; it becomes terminal + read-only.
//
// Status transitions are driven through the authenticated API (context.request) — a genuine
// end-to-end path (real server/DB/RBAC), and far more reliable than the admin-override <select>,
// which races Next dev-mode's first-hit route compilation (see core-journey.spec.ts). The
// ASSERTIONS are all on the rendered browser UI.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import {
  createChallengeViaApi,
  proposeSolutionViaApi,
  setChallengeStatusViaApi,
  setSolutionStatusViaApi,
} from "./helpers/api";

test("single-winner: implementing a solution solves the challenge and closes its siblings", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  // An admin raises a challenge and opens it for solutions.
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Lifecycle Admin", admin: true });
  const challenge = await createChallengeViaApi(adminCtx.request, {
    title: `E2E single-winner challenge ${stamp}`,
    description: "A challenge with two competing solutions.",
  });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

  // Two different members each propose a solution (distinct personas → distinct authors).
  const winnerCtx = await browser.newContext();
  await signIn(winnerCtx, { name: `E2E Winner ${stamp}` });
  const winner = await proposeSolutionViaApi(winnerCtx.request, challenge.digits, {
    description: `The winning solution ${stamp}.`,
  });

  const runnerUpCtx = await browser.newContext();
  await signIn(runnerUpCtx, { name: `E2E RunnerUp ${stamp}` });
  const runnerUp = await proposeSolutionViaApi(runnerUpCtx.request, challenge.digits, {
    description: `The runner-up solution ${stamp}.`,
  });

  // The admin implements the winner. As an override this jumps straight to `implemented`, which
  // triggers the §8.3 cascade: challenge → solved, every other non-terminal sibling → not_selected.
  await setSolutionStatusViaApi(adminCtx.request, winner.digits, "implemented");

  // Assert the cascade as rendered on the detail page.
  const admin = await adminCtx.newPage();
  await admin.goto(`/challenges/${challenge.digits}`);
  await expect(admin.getByRole("heading", { name: `E2E single-winner challenge ${stamp}` })).toBeVisible();

  // Challenge header pill → "Solved" (a challenge-only status label, so unambiguous page-wide).
  await expect(admin.locator(".pill", { hasText: "Solved" })).toBeVisible();
  // Winner row → "Implemented"; runner-up row → "Not selected" (scoped to each solution's row anchor).
  await expect(admin.locator(`#SOL-${winner.digits}`).locator(".pill", { hasText: "Implemented" })).toBeVisible();
  await expect(admin.locator(`#SOL-${runnerUp.digits}`).locator(".pill", { hasText: "Not selected" })).toBeVisible();

  await adminCtx.close();
  await winnerCtx.close();
  await runnerUpCtx.close();
});

test("needs-improvement unlocks the author's Edit + Resubmit and resubmitting returns to review", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  // A member raises a challenge (born awaiting_triage).
  const authorCtx = await browser.newContext();
  await signIn(authorCtx, { name: `E2E NI Author ${stamp}` });
  const challenge = await createChallengeViaApi(authorCtx.request, {
    title: `E2E needs-improvement challenge ${stamp}`,
    description: "Raised, then sent back for improvement.",
  });

  const author = await authorCtx.newPage();
  await author.goto(`/challenges/${challenge.digits}`);
  // At awaiting_triage the author can Edit + Withdraw, but Resubmit is NOT yet offered.
  await expect(author.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(author.getByRole("button", { name: "Resubmit for review" })).toHaveCount(0);

  // An admin sends it back for improvement.
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Lifecycle Admin", admin: true });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "needs_improvement");

  // The author reloads: the status flips and "Resubmit for review" is now unlocked.
  await author.reload();
  await expect(author.locator(".pill", { hasText: "Needs improvement" })).toBeVisible();
  await expect(author.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  const resubmit = author.getByRole("button", { name: "Resubmit for review" });
  await expect(resubmit).toBeVisible();

  // Resubmitting returns the challenge to review.
  await resubmit.click();
  await expect(author.locator(".pill", { hasText: "In review" })).toBeVisible();

  await authorCtx.close();
  await adminCtx.close();
});

test("withdraw: the author withdraws their challenge, making it terminal and read-only", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  // NB: the persona name must not contain a control label ("Withdraw", "Edit", …) — the account
  // menu trigger is named after the persona, so a substring match would collide with the button.
  const authorCtx = await browser.newContext();
  await signIn(authorCtx, { name: `E2E Retiring Author ${stamp}` });
  const challenge = await createChallengeViaApi(authorCtx.request, {
    title: `E2E withdraw challenge ${stamp}`,
    description: "Raised, then withdrawn by its author.",
  });

  const author = await authorCtx.newPage();
  await author.goto(`/challenges/${challenge.digits}`);

  // Withdraw is confirm-guarded; accept the native dialog before clicking. `exact` keeps the
  // button distinct from any substring match elsewhere in the chrome.
  author.on("dialog", (d) => d.accept());
  await author.getByRole("button", { name: "Withdraw", exact: true }).click();

  // The challenge is now Withdrawn (a terminal status the author can still see for their own item)…
  await expect(author.locator(".pill", { hasText: "Withdrawn" })).toBeVisible();
  // …and the withdraw control is gone (canWithdraw requires a non-terminal status).
  await expect(author.getByRole("button", { name: "Withdraw", exact: true })).toHaveCount(0);

  await authorCtx.close();
});
