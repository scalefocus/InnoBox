// Public submissions e2e (INNOBOX_SPEC.md §24.9): while the switch is off the form and its routes
// are 404; switched on, an outsider (no session) submits on /submit, confirms through the link,
// a platform admin accepts it in the queue, and the challenge sits in the triage queue labelled
// "External submission". The switch is platform-wide (this spec is pinned to shard 1) and is put
// back as it was whatever happens. Needs a server with PUBLIC_INTAKE_KEY and an e-mail transport
// (Jenkins sets both), and the dev seam for the confirmation token — it self-skips otherwise.
import { test, expect, type BrowserContext } from "@playwright/test";
import { signIn } from "./helpers/auth";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";
const JSON_HEADERS = { "content-type": "application/json" };

interface CardState {
  enabled: boolean;
  privacyNotice: string;
}

async function readCard(admin: BrowserContext): Promise<CardState & { missing: string | null }> {
  const res = await admin.request.get(`${base()}/api/admin/settings`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { publicSubmissions: CardState & { missing: string | null } }).publicSubmissions;
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

    // ── The outsider: no session, no app shell ─────────────────────────────────────────────
    const page = await outsider.newPage();
    const loadedAt = Date.now();
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
    const wait = 3_500 - (Date.now() - loadedAt);
    if (wait > 0) await page.waitForTimeout(wait);

    const [response] = await Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/public/submissions")), submit.click()]);
    expect(response.status()).toBe(202);
    const token = ((await response.json()) as { devConfirmToken?: string }).devConfirmToken;
    test.skip(!token, "the dev seam is off — the confirmation token is only in the e-mail");
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
