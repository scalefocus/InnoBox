// Featured challenges e2e (INNOBOX_SPEC.md §13.2 *Featured challenges*, §13.1 control). The
// user-facing flow, end to end through the real UI:
//   1. A platform admin opens a valid challenge and clicks "Feature on Home"; the control flips to
//      "Unfeature" with its "Featured by … on …" provenance.
//   2. The challenge appears in the "Featured" section at the top of Home — for the admin and for
//      an ordinary member, whose detail page shows no featured indicator or control at all.
//   3. The member's API call to feature is refused (403), and Unfeature removes the card.
// The cap is global and the e2e database is shared across runs, so the test first clears any
// pin a previous failed run of THIS spec left behind (matched on its title prefix), and always
// unfeatures its own challenge at the end.
import { test, expect, type APIRequestContext } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";

const TITLE_PREFIX = "E2E featured pin";

async function clearLeftoverPins(request: APIRequestContext): Promise<void> {
  const res = await request.get("/api/dashboard", { headers: { accept: "application/json" } });
  if (!res.ok()) return;
  const body = (await res.json()) as { featured?: { number: string; title: string }[] };
  for (const card of body.featured ?? []) {
    if (!card.title.startsWith(TITLE_PREFIX)) continue;
    await request.delete(`/api/challenges/${card.number.replace(/\D/g, "")}/featured`, { headers: { accept: "application/json" } });
  }
}

test("a platform admin features a challenge and it appears on Home for everyone who can see it", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const title = `${TITLE_PREFIX} ${stamp}`;

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Featured Admin", admin: true });
  await clearLeftoverPins(adminCtx.request);

  const challenge = await createChallengeViaApi(adminCtx.request, { title, description: "Pinned to the top of Home by an admin." });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

  try {
    const adminPage = await adminCtx.newPage();
    await adminPage.goto(`/challenges/${challenge.digits}`);
    await expect(adminPage.getByRole("heading", { name: title })).toBeVisible();
    await adminPage.getByRole("button", { name: "Feature on Home" }).click();
    await expect(adminPage.getByRole("button", { name: "Unfeature" })).toBeVisible();
    await expect(adminPage.getByText(/^Featured by E2E Featured Admin on /)).toBeVisible();

    await adminPage.goto("/");
    await expect(adminPage.getByRole("heading", { name: "Featured", exact: true })).toBeVisible();
    await expect(adminPage.getByTestId("featured-card").filter({ hasText: title })).toBeVisible();

    // An ordinary member sees the card on Home but no indicator or control on the detail page.
    const memberCtx = await browser.newContext();
    await signIn(memberCtx, { name: `E2E Featured Member ${stamp}` });
    const memberPage = await memberCtx.newPage();
    await memberPage.goto("/");
    const card = memberPage.getByTestId("featured-card").filter({ hasText: title });
    await expect(card).toBeVisible();
    await card.click();
    await expect(memberPage.getByRole("heading", { name: title })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "Feature on Home" })).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Unfeature" })).toHaveCount(0);
    await expect(memberPage.getByText(/^Featured by /)).toHaveCount(0);

    const refused = await memberCtx.request.put(`/api/challenges/${challenge.digits}/featured`, { headers: { accept: "application/json" } });
    expect(refused.status()).toBe(403);
    await memberCtx.close();

    // Unfeature removes it from Home.
    await adminPage.goto(`/challenges/${challenge.digits}`);
    await adminPage.getByRole("button", { name: "Unfeature" }).click();
    await expect(adminPage.getByRole("button", { name: "Feature on Home" })).toBeVisible();
    await adminPage.goto("/");
    await expect(adminPage.getByTestId("featured-card").filter({ hasText: title })).toHaveCount(0);
  } finally {
    await adminCtx.request.delete(`/api/challenges/${challenge.digits}/featured`, { headers: { accept: "application/json" } });
    await adminCtx.close();
  }
});
