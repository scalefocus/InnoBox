// GDPR erasure with hand-over of open assignments e2e (INNOBOX_SPEC.md §3, §12.1 event 12, §16).
// Through the real UI: the platform admin opens the INLINE confirmation on the "Delete user info
// (GDPR)" card (no browser confirm dialog), picks a successor in the "Reassign open assignments
// to" picker, and erases. The org-visible open assignment moves to the successor; the
// namespace-restricted one the successor cannot see stays with "Deleted User" and is listed on
// the card (as a link) until dismissed. The successor receives exactly one summary item, which
// never names the erased person.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, createNamespaceViaApi, setChallengeStatusViaApi } from "./helpers/api";

test("erasing a user hands visible open assignments to the chosen successor and lists the rest", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";
  const json = { "content-type": "application/json", accept: "application/json" };

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Erasure Admin ${stamp}`, admin: true });
  const victimName = `E2E Erasure Leaver ${stamp}`;
  const victimCtx = await browser.newContext();
  const { userId: victimId } = await signIn(victimCtx, { name: victimName });
  const successorName = `E2E Erasure Successor ${stamp}`;
  const successorCtx = await browser.newContext();
  const { userId: successorId } = await signIn(successorCtx, { name: successorName });

  // One org-visible open challenge (moves) and one restricted to a namespace the successor is
  // not a member of (skipped), both assigned to the leaver.
  const ns = await createNamespaceViaApi(adminCtx.request, { slug: `e2e-erasure-${stamp}`, displayName: `E2E Erasure ${stamp}` });
  const open = await createChallengeViaApi(adminCtx.request, { title: `E2E handed over ${stamp}`, description: "Moves to the successor." });
  const hidden = await createChallengeViaApi(adminCtx.request, {
    title: `E2E stays behind ${stamp}`,
    description: "The successor cannot see this one.",
    namespaceId: ns.id,
    visibility: "namespace",
  });
  for (const c of [open, hidden]) {
    await setChallengeStatusViaApi(adminCtx.request, c.digits, "in_review");
    const assigned = await adminCtx.request.post(`${base}/api/challenges/${c.digits}/assign`, { data: { userId: victimId }, headers: json });
    expect(assigned.status()).toBe(200);
  }

  // The API refuses the leaver as their own successor before anything changes.
  const self = await adminCtx.request.post(`${base}/api/admin/users/${victimId}/scrub`, { data: { reassignTo: victimId }, headers: json });
  expect(self.status()).toBe(400);

  const page = await adminCtx.newPage();
  await page.goto("/admin");
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "Delete user info (GDPR)" }) });
  await card.getByPlaceholder("Search users by name or email…").fill(victimName);
  await card.locator(".row", { hasText: victimName }).getByRole("button", { name: "Delete info" }).click();

  const dialog = card.getByRole("dialog", { name: `Delete personal info for ${victimName}` });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Reassign open assignments to (optional)").fill(successorName);
  await dialog.locator(".user-result-item", { hasText: successorName }).click();
  await expect(dialog).toContainText(successorName);
  await dialog.getByRole("button", { name: "Delete info permanently" }).click();

  await expect(page.locator(".toast")).toContainText(`Deleted personal info for ${victimName}. Moved 1 open assignment to ${successorName}.`);
  const notice = card.getByRole("status");
  await expect(notice).toContainText(`Left with Deleted User — ${successorName} can’t see these:`);
  await expect(notice.getByRole("link", { name: hidden.number })).toHaveAttribute("href", `/challenges/${hidden.digits}`);
  await expect(notice.getByRole("link", { name: open.number })).toHaveCount(0);

  // The moved challenge now has the successor as assignee; the restricted one stays with Deleted User.
  const assigneeOf = async (digits: string) => {
    const res = await adminCtx.request.get(`${base}/api/challenges/${digits}`, { headers: { accept: "application/json" } });
    return ((await res.json()) as { challenge: { assigneeId: string | null; assigneeDisplayName: string | null } }).challenge;
  };
  expect((await assigneeOf(open.digits)).assigneeId).toBe(successorId);
  const stayed = await assigneeOf(hidden.digits);
  expect(stayed.assigneeId).toBe(victimId);
  expect(stayed.assigneeDisplayName).toBe("Deleted User");

  // Exactly one summary notification for the successor, without the leaver's name.
  const inbox = await successorCtx.request.get(`${base}/api/notifications`, { headers: { accept: "application/json" } });
  const items = ((await inbox.json()) as { notifications: { type: string; message: string; link: string }[] }).notifications.filter(
    (n) => n.type === "assignments_transferred",
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.message).toBe(`1 challenge was reassigned to you from a removed account: ${open.number}.`);
  expect(items[0]!.link).toBe(`/challenges/${open.digits}`);
  expect(items[0]!.message).not.toContain(victimName);

  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);

  for (const ctx of [adminCtx, victimCtx, successorCtx]) await ctx.close();
});
