// Public submissions e2e (INNOBOX_SPEC.md §24.9): while the switch is off the form and its routes
// are 404, the settings card lists every unmet precondition, and /challenges/new shows no §6.1 share
// link; switched on, the share link copies the public address with a toast, an outsider (no
// session) submits on /submit, confirms through the link, a platform admin accepts it in the
// queue, and the challenge sits in the triage queue labelled "External submission". The switch is
// platform-wide (this spec is pinned to shard 1) and is put back as it was whatever happens. Needs
// a server with PUBLIC_INTAKE_KEY and an e-mail transport (Jenkins sets both) — it self-skips
// otherwise — and reads the confirmation token from the dev seam, which is on wherever dev sign-in is.
import { test, expect, type BrowserContext } from "@playwright/test";
import { signIn } from "./helpers/auth";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";
const JSON_HEADERS = { "content-type": "application/json" };

interface CardState {
  enabled: boolean;
  privacyNotice: string;
}

type Card = CardState & { missing: string | null; unmet: Array<{ precondition: string; hint: string }> };

async function readCard(admin: BrowserContext): Promise<Card> {
  const res = await admin.request.get(`${base()}/api/admin/settings`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { publicSubmissions: Card }).publicSubmissions;
}

const patchCard = (admin: BrowserContext, patch: Partial<CardState>) =>
  admin.request.patch(`${base()}/api/admin/settings`, { data: { publicSubmissions: patch }, headers: JSON_HEADERS });

test.describe.configure({ mode: "serial" });

test("while the switch is off, /submit and every public route answer 404", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const admin = await browser.newContext();
  const outsider = await browser.newContext();
  await signIn(admin, { name: `E2E Public Off Admin ${stamp}`, admin: true });
  const before = await readCard(admin);
  try {
    expect((await patchCard(admin, { enabled: false })).status()).toBe(200);
    for (const path of ["/submit", "/submit/confirm", "/api/public/settings", "/api/public/pow"]) {
      expect((await outsider.request.get(`${base()}${path}`)).status(), path).toBe(404);
    }
    const post = await outsider.request.post(`${base()}/api/public/submissions`, { data: {}, headers: { ...JSON_HEADERS, origin: base() } });
    expect(post.status()).toBe(404);

    // §6.1: a signed-in user gets no share link while the form is off.
    const link = await admin.request.get(`${base()}/api/public-submissions/link`);
    expect(link.status()).toBe(200);
    expect(await link.json()).toEqual({ url: null });
    const newPage = await admin.newPage();
    await newPage.goto("/challenges/new");
    await expect(newPage.getByRole("heading", { name: "Raise a challenge" })).toBeVisible();
    await expect(newPage.locator("#title")).toBeVisible();
    await expect(newPage.getByTestId("copy-public-url")).toHaveCount(0);

    // §24.2: with the switch off and no saved notice, the card lists every unmet precondition
    // (here at least the notice; the key and the sender depend on the server) under its heading.
    expect((await patchCard(admin, { privacyNotice: "" })).status()).toBe(200);
    const card = await readCard(admin);
    const unmet = card.unmet.map((u) => u.precondition);
    expect(unmet).toContain("notice");
    expect(unmet).toEqual(["key", "notice", "transport"].filter((p) => unmet.includes(p)));
    await newPage.goto("/admin/settings");
    const list = newPage.getByTestId("public-submissions-card").getByTestId("public-submissions-hint");
    await expect(list).toContainText("Before you can switch this on:");
    await expect(list.locator("li")).toHaveCount(unmet.length);
    await expect(list.locator('li[data-precondition="notice"]')).toHaveText("Enter a privacy notice first.");
  } finally {
    await patchCard(admin, { enabled: before.enabled, privacyNotice: before.privacyNotice });
    await admin.close();
    await outsider.close();
  }
});

test("submit on /submit, confirm through the link, accept in the queue → External submission in triage", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const admin = await browser.newContext();
  const outsider = await browser.newContext(); // never signed in
  await signIn(admin, { name: `E2E Public Admin ${stamp}`, admin: true });
  const before = await readCard(admin);
  const title = `Outside idea ${stamp}`;
  const company = `Acme ${stamp}`;

  try {
    expect((await patchCard(admin, { privacyNotice: `We use your details only to answer you. https://example.org/privacy-${stamp}` })).status()).toBe(200);
    const on = await patchCard(admin, { enabled: true });
    test.skip(on.status() === 409, `the server cannot switch the form on: ${(await on.json().catch(() => ({}))).error ?? "precondition missing"}`);
    expect(on.status()).toBe(200);

    // ── §6.1: the share link on /challenges/new copies the live address ───────────────────
    const shared = (await (await admin.request.get(`${base()}/api/public-submissions/link`)).json()) as { url: string | null };
    expect(shared.url).toMatch(/\/submit$/);
    await admin.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base() });
    const newPage = await admin.newPage();
    await newPage.goto("/challenges/new");
    await newPage.getByRole("button", { name: "or ask a customer to challenge us" }).click();
    await expect(newPage.locator(".toast")).toHaveText("Public challenge URL copied");
    expect(await newPage.evaluate(() => navigator.clipboard.readText())).toBe(shared.url);
    await newPage.close();

    // ── The outsider: no session, no app shell ─────────────────────────────────────────────
    const page = await outsider.newPage();
    // The server's "too fast" clock starts when it ISSUES the proof-of-work challenge, which the
    // form fetches only after hydrating (twice under dev StrictMode) — not at navigation. Timing
    // from the latest challenge response bounds the issuance from above, so the wait below is safe.
    let powIssuedAt = Date.now();
    page.on("response", (r) => {
      if (r.url().endsWith("/api/public/pow")) powIssuedAt = Date.now();
    });
    // Read the 202 through a route: the form never consumes that body, so waiting on the page's
    // own response body can stall. route.fetch() reads it on the test side and passes it on as is.
    const submitted: { status?: number; devConfirmToken?: string } = {};
    await page.route("**/api/public/submissions", async (route) => {
      const res = await route.fetch();
      Object.assign(submitted, { status: res.status() }, (await res.json().catch(() => ({}))) as { devConfirmToken?: string });
      await route.fulfill({ response: res });
    });
    await page.goto("/submit");
    await expect(page.getByRole("heading", { name: "Submit a challenge" })).toBeVisible();
    await expect(page.locator(".sidebar-head")).toHaveCount(0);
    await expect(page.getByTestId("privacy-notice")).toContainText("only to answer you");
    await expect(page.getByTestId("privacy-notice").getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");

    await page.locator("#ps-title").fill(title);
    await page.locator("#ps-description").fill(`Our warehouse queue ${stamp} keeps growing every Monday.`);
    await page.locator("#ps-name").fill("Outside Person");
    await page.locator("#ps-email").fill(`outside.${stamp}@example.org`);
    await page.locator("#ps-company").fill(company);
    await page.getByLabel("I have read the privacy notice").check();
    const submit = page.getByRole("button", { name: "Submit" });
    await expect(submit).toBeEnabled({ timeout: 30_000 }); // the proof-of-work is solved
    // A person takes more than 3 seconds to fill the form; a faster answer is dropped silently.
    const wait = 3_500 - (Date.now() - powIssuedAt);
    if (wait > 0) await page.waitForTimeout(wait);

    await submit.click();
    await expect.poll(() => submitted.status).toBe(202);
    // The seam is on wherever the e2e can sign in (dev auth, non-production build), so a missing
    // token means the server silently dropped the submission — fail rather than skip it away.
    const token = submitted.devConfirmToken;
    expect(token, "no confirmation token — the submission was dropped as too fast or as a bot").toBeTruthy();
    await expect(page.getByTestId("public-submit-done")).toContainText("Check your inbox");

    await page.goto(`/submit/confirm#${token}`);
    await page.getByRole("button", { name: "Confirm my submission" }).click();
    await expect(page.getByTestId("public-confirm-done")).toContainText("with our team");

    // ── The platform admin: the queue, then accept ─────────────────────────────────────────
    const adminPage = await admin.newPage();
    await adminPage.goto("/admin/public-submissions");
    const row = adminPage.getByTestId("public-submission-rows").getByRole("button", { name: new RegExp(title) });
    await expect(row).toBeVisible();
    await row.click();
    const review = adminPage.getByTestId("public-submission-review");
    await expect(review).toContainText("Outside Person");
    await review.getByRole("button", { name: "Accept…" }).click();
    const dialog = adminPage.locator("dialog[open]");
    await expect(dialog.getByRole("heading", { name: "Accept as a challenge" })).toBeVisible();
    await dialog.getByLabel("Impact area").selectOption({ label: "Internal" });
    await dialog.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(adminPage.locator(".toast")).toContainText("Accepted as CH-");

    // ── In the triage queue, labelled as an external submission ─────────────────────────────
    await adminPage.goto("/admin/triage");
    await expect(adminPage.getByText(title)).toBeVisible();
    await expect(adminPage.getByText(`External submission · ${company}`).first()).toBeVisible();
  } finally {
    await patchCard(admin, { enabled: false });
    await patchCard(admin, { enabled: before.enabled, privacyNotice: before.privacyNotice });
    await admin.close();
    await outsider.close();
  }
});
