// Audit log e2e (INNOBOX_SPEC.md §15; invariant 5 — append-only). A status change is an audited
// action; this confirms it surfaces in the platform-admin audit viewer, that the action filter
// narrows the list, and that Details expands the before/after payload. The viewer is read-only
// (no edit/delete controls) — the append-only guarantee itself is enforced by the DB trigger and
// covered by the audit dbtest.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";

test("audit log: an audited status change is filterable and its before/after is inspectable", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  // A member raises a challenge; the admin makes a distinctive transition (the audited action).
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Audit Member ${stamp}` });
  const challenge = await createChallengeViaApi(memberCtx.request, {
    title: `E2E audit challenge ${stamp}`,
    description: "Its status change is what we audit.",
  });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Audit Admin ${stamp}`, admin: true });
  // `meeting_scheduled` is distinctive enough to spot in the newest entry's payload.
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "meeting_scheduled");

  const admin = await adminCtx.newPage();
  await admin.goto("/admin/audit");
  await expect(admin.getByRole("heading", { name: "Audit log" })).toBeVisible();

  // Filter to challenge status changes for THIS challenge (by target id) — isolating the single
  // transition we made, regardless of unrelated audit noise from other tests.
  await admin.getByPlaceholder("Action (e.g. challenge.status_changed)").fill("challenge.status_changed");
  await admin.getByPlaceholder("Target id").fill(challenge.id);

  const row = admin.locator(".rows .row").first();
  await expect(row.locator(".chip.chip-accent.mono", { hasText: "challenge.status_changed" })).toBeVisible();

  // Expand it and read the before/after payload — the status we set is in it.
  await row.getByRole("button", { name: "Details" }).click();
  await expect(row.locator("pre.mono")).toContainText("meeting_scheduled");

  await memberCtx.close();
  await adminCtx.close();
});
