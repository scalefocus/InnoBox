// UI form helpers for e2e. The new-challenge form runs the §6.1 duplicate check on its first
// Submit click: with similar visible challenges it shows an advisory banner and flips the button
// to "Submit anyway". The suite shares one database and every spec titles its fixtures "E2E …
// challenge …", so whether a given run warns depends on what ran before it. Specs that are not
// about the warning submit through this helper, which clicks through the advisory when it
// appears; duplicate-warning.spec.ts covers the warning itself.
import { expect, type Page } from "@playwright/test";

const DETAIL_URL = /\/challenges\/\d+$/;

/** Open the new-challenge form and wait until it can be submitted. The impact-area and namespace
 *  lists load in separate client fetches: a spec that picks its impact area the moment that list
 *  arrives can click Submit while the `required` namespace select is still empty — the browser then
 *  blocks the submit silently, with no request to wait on. A namespace value also means the page
 *  has hydrated, so nothing typed afterwards is lost. */
export async function openNewChallengeForm(page: Page): Promise<void> {
  await page.goto("/challenges/new");
  await expect(page.locator("#namespace")).not.toHaveValue("");
}

/** Submit the filled-in new-challenge form and wait until the new challenge's page loads. */
export async function submitNewChallenge(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Submit challenge" }).click();
  const anyway = page.getByRole("button", { name: "Submit anyway" });
  // Whichever comes first: the create went straight through, or the advisory appeared.
  const outcome = await Promise.race([
    page.waitForURL(DETAIL_URL).then(() => "created" as const, () => null),
    anyway.waitFor({ state: "visible" }).then(() => "warned" as const, () => null),
  ]);
  if (outcome === "created") return;
  if (outcome !== "warned") throw new Error("new-challenge submit neither navigated nor showed the duplicate warning");
  await anyway.click();
  await page.waitForURL(DETAIL_URL);
}
