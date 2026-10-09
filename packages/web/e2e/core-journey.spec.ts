// Core end-to-end journey (INNOBOX_SPEC.md §17, §6–§8): a regular member submits a challenge, a
// platform admin triages it open (`valid`), and the member proposes a solution — the primary
// user-facing flow, across two browser contexts so the member/admin RBAC boundary is real.
//
// Scope note: the journey stops at "proposed". Driving a solution all the way to `implemented`
// (§8.3 single-winner + auto-close) is exercised deterministically by the
// challenges/solutions/likes dbtest — it's a data-layer state-machine assertion, not a UI flow,
// and driving it here through the admin status <select> is flaky under Next dev's first-hit route
// compilation (the controlled <select>'s change event can race the recompile). Keeping the e2e to
// the reliable, high-value UI path is the better trade than a flaky full-chain click-through.
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { submitNewChallenge } from "./helpers/forms";

// The challenge admin-override <select> carries every CHALLENGE status; `solved` is challenge-only,
// so it uniquely identifies it (and is unaffected by the solution status <select>, if present).
function challengeStatusSelect(page: Page) {
  return page.locator("select.field").filter({ has: page.locator('option[value="solved"]') });
}

test("core journey: submit → triage → propose", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const title = `E2E journey challenge ${stamp}`;

  // ── 1. A regular member submits an org-visible challenge (starts at awaiting_triage). ──
  const authorCtx = await browser.newContext();
  await signIn(authorCtx, { name: `E2E Author ${stamp}` });
  const author = await authorCtx.newPage();
  await author.goto("/challenges/new");
  await author.locator("#title").fill(title);
  await author.locator("#description").fill("A problem worth solving, raised by the e2e suite.");
  await author.locator("#impactArea").selectOption({ label: "Internal" });
  // namespace defaults to global, visibility defaults to org — both fine for this journey.
  await submitNewChallenge(author);
  const number = author.url().match(/\/challenges\/(\d+)$/)![1];
  await expect(author.locator(".pill", { hasText: "Awaiting triage" })).toBeVisible();
  // §13.1: "Propose a solution" is visible to everyone but enabled only once the challenge is valid.
  await expect(author.getByRole("button", { name: "Propose a solution" })).toBeDisabled();

  // ── 2. A platform admin triages the challenge to `valid` via the override control. ──
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Admin", admin: true });
  const admin = await adminCtx.newPage();
  await admin.goto(`/challenges/${number}`);
  await expect(admin.getByRole("heading", { name: title })).toBeVisible();
  await challengeStatusSelect(admin).selectOption("valid");
  await expect(admin.locator(".pill", { hasText: "Valid — open for solutions" })).toBeVisible();

  // ── 3. The member (reloading to pick up `valid`) proposes a solution. ──
  await author.goto(`/challenges/${number}`);
  await author.getByRole("button", { name: "Propose a solution" }).click();
  await author.locator('textarea[placeholder="Describe your solution"]').fill(`An e2e solution for ${stamp}.`);
  await author.getByRole("button", { name: "Submit solution" }).click();
  await expect(author.locator(".pill", { hasText: "Proposed" })).toBeVisible();

  await authorCtx.close();
  await adminCtx.close();
});
