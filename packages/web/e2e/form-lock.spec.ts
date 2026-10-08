// Submission lock e2e (INNOBOX_SPEC.md §6.4). A double click, a double Enter, or two submit
// events in the same tick on the challenge form create exactly ONE challenge, and while the
// request is in flight the form is covered by the scrim and its primary button reads "Working…".
//
// The create call is held back by a route so the in-flight state is observable; the request is
// otherwise passed through untouched to the real API.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";

const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";

interface Counts {
  similar: number;
  create: number;
}

/** Sign in a fresh persona and open the challenge form with every required field filled. The
 *  title uses made-up words so the duplicate check (§6.1) finds nothing and the first submit goes
 *  straight through to the create. */
async function openFilledForm(browserCtx: BrowserContext, title: string): Promise<{ page: Page; counts: Counts }> {
  const page = await browserCtx.newPage();
  const counts: Counts = { similar: 0, create: 0 };
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const path = new URL(req.url()).pathname;
    if (path === "/api/challenges/similar") counts.similar += 1;
    if (path === "/api/challenges") counts.create += 1;
  });
  // Hold the create for a moment so "Working…" and the scrim can be asserted mid-flight.
  await page.route(
    (url) => url.pathname === "/api/challenges",
    async (route) => {
      if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    },
  );
  await page.goto("/challenges/new");
  await page.locator("#title").fill(title);
  await page.locator("#description").fill("Submitted once, no matter how eagerly.");
  await page.locator("#impactArea").selectOption({ label: "Internal" });
  return { page, counts };
}

/** The persona's own challenges with this exact title, read back from the real API. */
async function countMine(ctx: BrowserContext, title: string): Promise<number> {
  const res = await ctx.request.get(`${BASE}/api/challenges?tab=mine`, { headers: { accept: "application/json" } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { challenges: { title: string }[] };
  return body.challenges.filter((c) => c.title === title).length;
}

function uniqueTitle(tag: string): string {
  const stamp = Date.now().toString(36).replace(/[^a-z]/g, "q");
  return `Zorbleq ${tag} vantrix ${stamp}`;
}

test("form lock: a double click creates exactly one challenge and shows Working…", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Lock Click ${Date.now().toString(36)}` });
  const title = uniqueTitle("click");
  const { page, counts } = await openFilledForm(ctx, title);

  await page.getByRole("button", { name: "Submit challenge" }).dblclick();

  // In flight: the button stays visible, disabled, reading "Working…"; the scrim covers the form.
  const working = page.getByRole("button", { name: "Working…" });
  await expect(working).toBeVisible();
  await expect(working).toBeDisabled();
  await expect(page.getByTestId("form-lock-scrim")).toBeVisible();
  await expect(page.locator("form[aria-busy='true']")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Checking…" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submitting…" })).toHaveCount(0);

  await expect(page).toHaveURL(/\/challenges\/\d+$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  expect(counts.similar).toBe(1);
  expect(counts.create).toBe(1);
  expect(await countMine(ctx, title)).toBe(1);

  await ctx.close();
});

test("form lock: a double Enter creates exactly one challenge", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Lock Enter ${Date.now().toString(36)}` });
  const title = uniqueTitle("enter");
  const { page, counts } = await openFilledForm(ctx, title);

  await page.locator("#title").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Working…" })).toBeVisible();
  await expect(page).toHaveURL(/\/challenges\/\d+$/);
  expect(counts.create).toBe(1);
  expect(await countMine(ctx, title)).toBe(1);

  await ctx.close();
});

test("form lock: two submit events in the same tick are guarded by the handler itself", async ({ browser }) => {
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Lock Tick ${Date.now().toString(36)}` });
  const title = uniqueTitle("tick");
  const { page, counts } = await openFilledForm(ctx, title);

  // Both events land before React re-renders, so the disabled button cannot be what stops the
  // second one — only the handler's own guard can.
  await page.locator("form").filter({ has: page.locator("#title") }).evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });

  await expect(page).toHaveURL(/\/challenges\/\d+$/);
  expect(counts.similar).toBe(1);
  expect(counts.create).toBe(1);
  expect(await countMine(ctx, title)).toBe(1);

  await ctx.close();
});
