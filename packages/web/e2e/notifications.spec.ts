// In-app notifications e2e (INNOBOX_SPEC.md §12). Notifications are written synchronously in the
// API request (lib/notify.ts) and surfaced by the topbar bell (which fetches on mount), so the
// fan-out is fully exercisable without the e-mail worker. Two events are checked: an author being
// notified when their challenge is triaged (event 3), and namespace admins being notified when a
// challenge is submitted for triage (event 1).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";

test("bell: a challenge author is notified when an admin triages their challenge", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const title = `E2E notify challenge ${stamp}`;

  // A member raises a challenge (auto-follows themselves → becomes a recipient of its events).
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Notify Member ${stamp}` });
  const challenge = await createChallengeViaApi(memberCtx.request, { title, description: "Please triage me." });

  // An admin opens it for solutions — a real transition, so event 3 fires to the author.
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Notify Admin ${stamp}`, admin: true });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

  // The member reloads to force the bell to fetch, then opens it.
  const member = await memberCtx.newPage();
  await member.goto("/");
  await expect(member.locator(".bell-dot")).toBeVisible(); // unread badge
  await member.getByRole("button", { name: "Notifications" }).click();
  await expect(member.getByText(`${challenge.number} "${title}" moved to valid.`)).toBeVisible();

  // Marking all read clears the unread badge (this fresh persona has only this one notification).
  await member.getByRole("button", { name: "Mark all read" }).click();
  await expect(member.locator(".bell-dot")).toHaveCount(0);

  await memberCtx.close();
  await adminCtx.close();
});

test("bell: a namespace admin is notified when a challenge is submitted for triage", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const title = `E2E triage-notify challenge ${stamp}`;

  // The admin exists first, so it's a recipient when the submission event fans out to ns admins.
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Submit Admin ${stamp}`, admin: true });

  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Submit Member ${stamp}` });
  const challenge = await createChallengeViaApi(memberCtx.request, { title, description: "Fresh from a member." });

  const admin = await adminCtx.newPage();
  await admin.goto("/");
  await admin.getByRole("button", { name: "Notifications" }).click();
  // The message is unique to this challenge, so it survives any unrelated noise in the admin's inbox.
  await expect(admin.getByText(`New challenge ${challenge.number} "${title}" needs triage.`)).toBeVisible();

  await memberCtx.close();
  await adminCtx.close();
});
