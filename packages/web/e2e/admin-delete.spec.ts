// Platform-admin permanent delete e2e (INNOBOX_SPEC.md §10.3). The user-facing flow this
// covers, end to end through the real UI:
//   1. The danger zone is platform-admin-only — an ordinary member (even the item's author)
//      never sees it, and the API answers their DELETE with a 404, not a 403, so it cannot be
//      used to prove an item exists (invariant 2).
//   2. The confirm dialog only arms once the admin types the item's own number back AND gives
//      a reason — the deliberate friction that stands in for the undo this action doesn't have.
//   3. Deleting a solution leaves its challenge standing (and un-solves it when the deleted
//      solution was the implemented one, per §8.3); deleting the challenge takes the whole
//      thing away — the detail page is gone and the item has left the browse list.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, proposeSolutionViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";

test("a member never sees the danger zone, and their DELETE is a 404 that changes nothing", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Delete Member ${stamp}` });
  const challenge = await createChallengeViaApi(memberCtx.request, {
    title: `E2E member-cannot-delete ${stamp}`,
    description: "Raised by a member who must not be able to delete it.",
  });

  const page = await memberCtx.newPage();
  await page.goto(`/challenges/${challenge.digits}`);
  await expect(page.getByRole("heading", { name: `E2E member-cannot-delete ${stamp}` })).toBeVisible();
  await expect(page.getByRole("button", { name: `Delete ${challenge.number} permanently` })).toHaveCount(0);

  // 404 (not 403) even though this member is the author — and the challenge survives.
  const refused = await memberCtx.request.delete(`/api/challenges/${challenge.digits}`, {
    data: { reason: "I would rather it went away" },
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  expect(refused.status()).toBe(404);

  await page.reload();
  await expect(page.getByRole("heading", { name: `E2E member-cannot-delete ${stamp}` })).toBeVisible();

  await memberCtx.close();
});

test("the danger zone arms only on the typed number plus a reason, then deletes for good", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Delete Admin", admin: true });
  const challenge = await createChallengeViaApi(adminCtx.request, {
    title: `E2E delete-me challenge ${stamp}`,
    description: "This challenge and its solution are about to be destroyed.",
  });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

  // A member proposes a solution, which the admin then implements — so the delete has to
  // un-solve the challenge on its way out (§8.3 is not replayed in reverse).
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Delete Proposer ${stamp}` });
  const solution = await proposeSolutionViaApi(memberCtx.request, challenge.digits, {
    description: `A solution destined for deletion ${stamp}.`,
  });
  await setSolutionStatusViaApi(adminCtx.request, solution.digits, "implemented");

  const page = await adminCtx.newPage();
  await page.goto(`/challenges/${challenge.digits}`);
  await expect(page.locator(".pill", { hasText: "Solved" })).toBeVisible();

  // ── Delete the solution ───────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: `Delete ${solution.number} permanently` }).click();
  const solutionDialog = page.getByRole("dialog", { name: `Delete ${solution.number} permanently` });
  const solutionConfirm = solutionDialog.getByRole("button", { name: "Delete permanently" });

  // Unarmed: no number, no reason.
  await expect(solutionConfirm).toBeDisabled();
  // The right number but still no reason — still unarmed.
  await solutionDialog.getByLabel(`Type ${solution.number} to confirm`).fill(solution.number);
  await expect(solutionConfirm).toBeDisabled();
  // The wrong number with a reason — still unarmed.
  await solutionDialog.getByLabel("Reason (required — kept in the audit trail)").fill("posted by mistake");
  await solutionDialog.getByLabel(`Type ${solution.number} to confirm`).fill("SOL-000000");
  await expect(solutionConfirm).toBeDisabled();
  // Both correct — armed.
  await solutionDialog.getByLabel(`Type ${solution.number} to confirm`).fill(solution.number);
  await expect(solutionConfirm).toBeEnabled();
  await solutionConfirm.click();

  // The solution row is gone, the challenge stands, and it is no longer solved.
  await expect(page.locator(`#${solution.number}`)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: `E2E delete-me challenge ${stamp}` })).toBeVisible();
  await expect(page.locator(".pill", { hasText: "Solved" })).toHaveCount(0);
  await expect(page.locator(".pill", { hasText: "Valid — open for solutions" })).toBeVisible();

  // ── Delete the challenge ──────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: `Delete ${challenge.number} permanently` }).click();
  const challengeDialog = page.getByRole("dialog", { name: `Delete ${challenge.number} permanently` });
  await challengeDialog.getByLabel(`Type ${challenge.number} to confirm`).fill(challenge.number);
  await challengeDialog.getByLabel("Reason (required — kept in the audit trail)").fill("contained confidential material");
  await challengeDialog.getByRole("button", { name: "Delete permanently" }).click();

  // The admin lands back on the browse list, and the challenge has left it.
  await expect(page).toHaveURL(/\/challenges\/?$/);
  await expect(page.getByText(`E2E delete-me challenge ${stamp}`)).toHaveCount(0);

  // Its detail page is gone for everyone, the deleting admin included — and a second delete
  // of either the challenge or its already-cascaded solution finds nothing left.
  const gone = await adminCtx.request.get(`/api/challenges/${challenge.digits}`, { headers: { accept: "application/json" } });
  expect(gone.status()).toBe(404);
  const solutionGone = await adminCtx.request.delete(`/api/solutions/${solution.digits}`, {
    data: { reason: "already gone" },
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  expect(solutionGone.status()).toBe(404);

  await adminCtx.close();
  await memberCtx.close();
});

test("a blank reason is refused by the API", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Delete Admin", admin: true });
  const challenge = await createChallengeViaApi(adminCtx.request, {
    title: `E2E delete-needs-reason ${stamp}`,
    description: "A delete without a reason must not go through.",
  });

  const refused = await adminCtx.request.delete(`/api/challenges/${challenge.digits}`, {
    data: { reason: "   " },
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  expect(refused.status()).toBe(422);

  // Still there — and now delete it properly, with a reason, to clean up after the test.
  const stillThere = await adminCtx.request.get(`/api/challenges/${challenge.digits}`, { headers: { accept: "application/json" } });
  expect(stillThere.status()).toBe(200);
  const accepted = await adminCtx.request.delete(`/api/challenges/${challenge.digits}`, {
    data: { reason: "e2e cleanup" },
    headers: { "content-type": "application/json", accept: "application/json" },
  });
  expect(accepted.status()).toBe(200);

  await adminCtx.close();
});
