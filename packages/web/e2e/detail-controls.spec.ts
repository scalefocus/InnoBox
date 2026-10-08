// Challenge-detail controls e2e (INNOBOX_SPEC.md §6.2/§13.1 propose button, §8.3 like freeze,
// §7.3 unassign). Status changes are driven through the API (see helpers/api.ts for why); the
// assertions are on the rendered page.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, proposeSolutionViaApi, setChallengeStatusViaApi, setSolutionStatusViaApi } from "./helpers/api";

test("Propose a solution is visible but disabled off `valid`; likes freeze once the challenge is solved", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Freeze Admin ${stamp}`, admin: true });
  const challenge = await createChallengeViaApi(adminCtx.request, {
    title: `E2E like freeze ${stamp}`,
    description: "Solved soon.",
  });

  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Freeze Member ${stamp}` });
  const member = await memberCtx.newPage();

  // In review: the button is there for everyone, disabled, with its reason.
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "in_review");
  await member.goto(`/challenges/${challenge.digits}`);
  const propose = member.getByRole("button", { name: "Propose a solution" });
  await expect(propose).toBeVisible();
  await expect(propose).toBeDisabled();
  await expect(member.locator("#propose-disabled-reason")).toBeVisible();

  // Valid: enabled. Like the challenge while it is open.
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");
  await member.reload();
  await expect(member.getByRole("button", { name: "Propose a solution" })).toBeEnabled();
  const likeBtn = member.locator("button").filter({ hasText: /[♡♥]/ }).first();
  await likeBtn.click();
  await expect(likeBtn).toContainText("♥ 1");

  // Implement a solution → the challenge is solved: counts stay, like buttons are frozen, and
  // proposing is disabled with its reason.
  const solution = await proposeSolutionViaApi(adminCtx.request, challenge.digits, { description: `Winner ${stamp}` });
  for (const st of ["in_review", "valid", "accepted_internally", "waiting_for_resources", "in_implementation", "implemented"]) {
    await setSolutionStatusViaApi(adminCtx.request, solution.digits, st);
  }
  await member.reload();
  await expect(member.locator(".pill", { hasText: "Solved" }).first()).toBeVisible();
  const frozen = member.locator("button").filter({ hasText: /[♡♥]/ });
  await expect(frozen.first()).toContainText("♥ 1");
  for (const btn of await frozen.all()) await expect(btn).toBeDisabled();
  await expect(member.getByRole("button", { name: "Propose a solution" })).toBeDisabled();

  // The API refuses a like on the solved challenge too.
  const res = await memberCtx.request.post("/api/likes", {
    data: { parentType: "challenge", parentId: challenge.id },
    headers: { "content-type": "application/json" },
  });
  expect(res.status()).toBe(409);

  await adminCtx.close();
  await memberCtx.close();
});

test("an admin can unassign a challenge from the detail page", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const assigneeName = `E2E Unassign Target ${stamp}`;
  const assigneeCtx = await browser.newContext();
  const { userId: assigneeId } = await signIn(assigneeCtx, { name: assigneeName });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Unassign Admin ${stamp}`, admin: true });
  const challenge = await createChallengeViaApi(adminCtx.request, { title: `E2E unassign ${stamp}`, description: "d" });
  const assigned = await adminCtx.request.post(`/api/challenges/${challenge.digits}/assign`, {
    data: { userId: assigneeId },
    headers: { "content-type": "application/json" },
  });
  expect(assigned.status()).toBe(200);

  const admin = await adminCtx.newPage();
  await admin.goto(`/challenges/${challenge.digits}`);
  await expect(admin.getByText(`assignee:`)).toBeVisible();
  await admin.getByRole("button", { name: "Unassign", exact: true }).click();
  await expect(admin.getByText("Unassigned", { exact: true })).toBeVisible();
  await expect(admin.getByText(`assignee:`)).toHaveCount(0);

  await adminCtx.close();
  await assigneeCtx.close();
});
