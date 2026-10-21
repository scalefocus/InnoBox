// Public submissions e2e (INNOBOX_SPEC.md §24.9): while the switch is off the form and its routes
// are 404, the settings card lists every unmet precondition, and /challenges/new shows no §6.1 share
// link; switched on, the share link copies the public address with a toast, an outsider (no
// session) submits on /submit, confirms through the link, a platform admin accepts it in the
// queue, and the challenge sits in the triage queue labelled "External submission"; and the §24.3
// visibility request — Specific people with its tag field, pre-filled into the Accept dialog,
// shared once the challenge leaves triage (§4.3, §12.1 event 15). The switch is platform-wide
// (this spec is in the one-at-a-time platform-state project) and is put back as it was whatever
// happens. Needs a server with
// PUBLIC_INTAKE_KEY and an e-mail transport (Jenkins sets both) — it self-skips otherwise — and
// reads the confirmation token from the dev seam, which is on wherever dev sign-in is.
import { test, expect, type BrowserContext } from "@playwright/test";
import { devSlug, signIn } from "./helpers/auth";
import { setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

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
  const stamp = uniqueStamp();
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
    // §24.4 edge protection: the reminder under the public address.
    await expect(newPage.getByTestId("public-submissions-card").getByTestId("public-edge-hint")).toHaveText(
      "Before sharing this address, make sure your reverse proxy forwards the real client address and protects this page against floods.",
    );
  } finally {
    await patchCard(admin, { enabled: before.enabled, privacyNotice: before.privacyNotice });
    await admin.close();
    await outsider.close();
  }
});

test("submit on /submit, confirm through the link, accept in the queue → External submission in triage", async ({ browser }) => {
  const stamp = uniqueStamp();
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

test("Specific people: the tag field, the pre-filled Accept, and sharing once the challenge leaves triage", async ({ browser }) => {
  const stamp = uniqueStamp();
  const admin = await browser.newContext();
  const listed = await browser.newContext();
  const unlisted = await browser.newContext();
  const outsider = await browser.newContext(); // never signed in
  await signIn(admin, { name: `E2E Share Admin ${stamp}`, admin: true });
  const listedName = `E2E Share Listed ${stamp}`;
  await signIn(listed, { name: listedName });
  await signIn(unlisted, { name: `E2E Share Unlisted ${stamp}` });
  const listedEmail = `${devSlug(listedName)}@dev.test`;
  const pendingEmail = `not-yet-here.${stamp}@example.org`;
  const before = await readCard(admin);
  const title = `Shared outside idea ${stamp}`;

  try {
    expect((await patchCard(admin, { privacyNotice: `We use your details only to answer you. ${stamp}` })).status()).toBe(200);
    const on = await patchCard(admin, { enabled: true });
    test.skip(on.status() === 409, `the server cannot switch the form on: ${(await on.json().catch(() => ({}))).error ?? "precondition missing"}`);
    expect(on.status()).toBe(200);

    // ── The outsider: Who should see this? ───────────────────────────────────────────────────
    const page = await outsider.newPage();
    let powIssuedAt = Date.now();
    page.on("response", (r) => {
      if (r.url().endsWith("/api/public/pow")) powIssuedAt = Date.now();
    });
    const submitted: { status?: number; devConfirmToken?: string } = {};
    await page.route("**/api/public/submissions", async (route) => {
      const res = await route.fetch();
      Object.assign(submitted, { status: res.status() }, (await res.json().catch(() => ({}))) as { devConfirmToken?: string });
      await route.fulfill({ response: res });
    });
    await page.goto("/submit");
    await page.locator("#ps-title").fill(title);
    await page.locator("#ps-description").fill(`Our loading dock ${stamp} needs a better schedule.`);
    await page.locator("#ps-name").fill("Outside Person");
    await page.locator("#ps-email").fill(`outside.share.${stamp}@example.org`);
    await expect(page.getByLabel("Everyone in the organization")).toBeChecked();

    // Teams: a name needs 3 characters.
    await page.getByLabel("Specific teams").check();
    await page.locator("#ps-teams").fill("QA");
    await page.locator("#ps-teams").press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Team names need at least 3 characters." })).toBeVisible();

    // People: an invalid address stays in the field; a valid one locks in on Enter.
    await page.getByLabel("Specific people").check();
    const emails = page.locator("#ps-emails");
    await emails.fill("not-an-address");
    await emails.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Enter a valid e-mail address." })).toBeVisible();
    await emails.fill(listedEmail);
    await emails.press("Enter");
    await expect(page.getByRole("list", { name: "E-mail addresses added" }).getByText(listedEmail)).toBeVisible();
    // Text left in the field is locked in on Submit when it is valid.
    await emails.fill(pendingEmail);

    await page.getByLabel("I have read the privacy notice").check();
    const submit = page.getByRole("button", { name: "Submit" });
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    const wait = 3_500 - (Date.now() - powIssuedAt);
    if (wait > 0) await page.waitForTimeout(wait);
    await submit.click();
    await expect.poll(() => submitted.status).toBe(202);
    expect(submitted.devConfirmToken, "no confirmation token — the submission was dropped").toBeTruthy();
    await page.goto(`/submit/confirm#${submitted.devConfirmToken}`);
    await page.getByRole("button", { name: "Confirm my submission" }).click();
    await expect(page.getByTestId("public-confirm-done")).toContainText("with our team");

    // ── The platform admin: the request, then a pre-filled Accept ──────────────────────────────
    const adminPage = await admin.newPage();
    await adminPage.goto("/admin/public-submissions");
    await adminPage.getByTestId("public-submission-rows").getByRole("button", { name: new RegExp(title) }).click();
    const requested = adminPage.getByTestId("requested-visibility");
    await expect(requested).toContainText("Requested: Specific people");
    await expect(requested).toContainText(listedEmail);
    await expect(requested).toContainText(pendingEmail);
    await adminPage.getByTestId("public-submission-review").getByRole("button", { name: "Accept…" }).click();
    const dialog = adminPage.locator("dialog[open]");
    await expect(dialog.getByLabel("Visibility")).toHaveValue("people");
    const people = dialog.getByRole("list", { name: "People with access" });
    await expect(people.getByText(listedName)).toBeVisible();
    await expect(people.getByText(pendingEmail)).toBeVisible();
    await expect(people.getByText("No InnoBox user yet")).toBeVisible();
    await dialog.getByLabel("Impact area").selectOption({ label: "Internal" });
    await dialog.getByRole("button", { name: "Accept", exact: true }).click();
    const toast = adminPage.locator(".toast");
    await expect(toast).toContainText("Accepted as CH-");
    const digits = /CH-(\d+)/.exec((await toast.textContent()) ?? "")?.[1];
    expect(digits).toBeTruthy();

    // ── In triage the listed person sees nothing; out of it, they are told and can open it ────
    expect((await listed.request.get(`${base()}/api/challenges/${digits}`)).status()).toBe(404);
    await setChallengeStatusViaApi(admin.request, digits!, "in_review");
    const inbox = await listed.request.get(`${base()}/api/notifications`, { headers: { accept: "application/json" } });
    const shared = ((await inbox.json()) as { notifications: { type: string; message: string; link: string }[] }).notifications.filter(
      (n) => n.type === "challenge_shared" && n.link === `/challenges/${digits}`,
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]!.message).toContain("has been shared with you");
    const listedPage = await listed.newPage();
    await listedPage.goto(`/challenges/${digits}`);
    await expect(listedPage.getByRole("heading", { name: title })).toBeVisible();
    await expect(listedPage.getByText("Shared with specific people")).toBeVisible();
    expect((await unlisted.request.get(`${base()}/api/challenges/${digits}`)).status(), "someone not on the list").toBe(404);
  } finally {
    await patchCard(admin, { enabled: false });
    await patchCard(admin, { enabled: before.enabled, privacyNotice: before.privacyNotice });
    await admin.close();
    await listed.close();
    await unlisted.close();
    await outsider.close();
  }
});
