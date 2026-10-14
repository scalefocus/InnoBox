// Drop and paste e2e (INNOBOX_SPEC.md §11 "Drop and paste"). The e2e stack has no object store,
// so the attachment endpoints are stubbed at the network layer: these tests cover the browser
// side — the overlay and its targets, the pre-checks, the sequential queue, the Submit gate,
// paste routing and renaming — while the store's own suites cover the server.
import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, proposeSolutionViaApi, setChallengeStatusViaApi } from "./helpers/api";

interface Posted {
  name: string;
  draftKey: string | null;
  parentId: string | null;
}

/** Stub the upload endpoints. Each POST takes `delayMs`, so the queue is observable. */
async function stubAttachments(page: Page, delayMs = 0): Promise<Posted[]> {
  const posted: Posted[] = [];
  const stored: { id: string; filename: string; sizeBytes: number; status: "clean"; isUploader: true }[] = [];
  await page.route(
    (url) => url.pathname === "/api/attachments/config",
    (route) => route.fulfill({ json: { maxPerItem: 5, maxUploadSizeMb: 10, chunkSizeMb: 5, scanEnforced: false } }),
  );
  await page.route(
    (url) => url.pathname === "/api/attachments",
    async (route) => {
      const req = route.request();
      if (req.method() === "GET") return route.fulfill({ json: { attachments: stored } });
      const body = req.postDataBuffer()?.toString("latin1") ?? "";
      const field = (name: string) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1] ?? null;
      const filename = body.match(/name="file"; filename="([^"]*)"/)?.[1] ?? "?";
      posted.push({ name: filename, draftKey: field("draftKey"), parentId: field("parentId") });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const attachment = { id: crypto.randomUUID(), filename, sizeBytes: 1, status: "clean" as const, isUploader: true as const };
      stored.push(attachment);
      return route.fulfill({ status: 201, json: { attachment } });
    },
  );
  return posted;
}

/** Start a file drag over the window (dragenter on <body>) carrying `names`, and wait for the
 *  overlay. The listeners attach on hydration while the page's hint is server-rendered, so a
 *  dragenter can land first and be lost: re-dispatch until the overlay shows, closing any
 *  half-open drag (a dragleave) so each attempt recomputes the targets. */
async function dragFilesOver(page: Page, names: string[]): Promise<void> {
  await expect(async () => {
    await page.evaluate((files) => {
      const dt = new DataTransfer();
      for (const n of files) dt.items.add(new File(["x"], n));
      (window as unknown as { __dt: DataTransfer }).__dt = dt;
      document.body.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: dt }));
      document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, names);
    await expect(page.getByTestId("drop-overlay")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** Drop the dragged files on the overlay target labelled `label`. */
async function dropOn(page: Page, label: string): Promise<void> {
  await page.evaluate((text) => {
    const target = [...document.querySelectorAll<HTMLElement>("[data-drop-target]")].find((t) => t.textContent?.trim() === text);
    if (!target) throw new Error(`no drop target "${text}"`);
    const dt = (window as unknown as { __dt: DataTransfer }).__dt;
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, label);
}

/** Paste into the focused element (or <body>); returns whether the app took the paste. */
async function paste(page: Page, opts: { files: { name: string; type: string }[]; text?: string }): Promise<boolean> {
  return page.evaluate(({ files, text }) => {
    const dt = new DataTransfer();
    if (text) {
      dt.setData("text/plain", text);
      dt.setData("text/html", `<p>${text}</p>`);
    }
    for (const f of files) dt.items.add(new File(["png"], f.name, { type: f.type }));
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    (document.activeElement ?? document.body).dispatchEvent(ev);
    return ev.defaultPrevented;
  }, opts);
}

test("challenge form: the whole page takes a drop — pre-checks, a sequential queue, Submit gated", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Drop Author ${stamp}` });
  const page = await ctx.newPage();
  const posted = await stubAttachments(page, 700);
  await page.goto("/challenges/new");
  await expect(page.getByText("You can also drop files anywhere on the page, or paste them.")).toBeVisible();

  // One target on this page: the whole overlay is it.
  await dragFilesOver(page, ["a.pdf", "b.png", "setup.exe", "c.txt", "d.csv", "e.md", "f.docx"]);
  const overlay = page.getByTestId("drop-overlay");
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("drop-target")).toHaveCount(1);
  await expect(page.getByTestId("drop-target")).toHaveText("Drop files to attach");
  await dropOn(page, "Drop files to attach");
  await expect(overlay).toHaveCount(0);

  // The exe and the file past the 5-file cap are skipped, named in one message.
  await expect(page.getByTestId("attachment-skipped")).toHaveText(
    "Skipped: setup.exe (file type not allowed), f.docx (only 5 files can be attached)",
  );
  // The rest queue and upload one at a time; Submit waits for the queue.
  await expect(page.getByText("Queued", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Waiting for attachments…" })).toBeDisabled();
  await expect(page.getByText("Queued", { exact: true })).toHaveCount(0, { timeout: 15_000 });
  expect(posted.map((p) => p.name)).toEqual(["a.pdf", "b.png", "c.txt", "d.csv", "e.md"]);
  expect(posted.every((p) => p.draftKey !== null && p.parentId === null)).toBe(true);
  await expect(page.getByText("Ready", { exact: true })).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Submit challenge" })).toBeEnabled();

  await ctx.close();
});

test("challenge form: a file-only paste attaches (renamed); a paste with text stays text", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Paste Author ${stamp}` });
  const page = await ctx.newPage();
  const posted = await stubAttachments(page);
  await page.goto("/challenges/new");
  await page.locator("#description").focus();

  // A screenshot: attaches, with the generic clipboard name replaced. Polled because the paste
  // listener attaches on hydration — an earlier paste goes unhandled and attaches nothing.
  await expect.poll(() => paste(page, { files: [{ name: "image.png", type: "image/png" }] })).toBe(true);
  await expect(page.getByText(/^pasted-image-\d{4}-\d{2}-\d{2}-\d{6}\.png$/)).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]!.name).toMatch(/^pasted-image-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);

  // Copied from Word/Excel: text plus a rendered image — an ordinary text paste.
  await page.locator("#description").focus();
  expect(await paste(page, { text: "copied cells", files: [{ name: "image.png", type: "image/png" }] })).toBe(false);
  expect(posted).toHaveLength(1);

  await ctx.close();
});

test("detail page: one overlay target per control; drops and pastes go where they're aimed", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Drop Admin ${stamp}`, admin: true });
  const challenge = await createChallengeViaApi(ctx.request, { title: `Drop targets ${stamp}`, description: "Where do dropped files go?" });
  await setChallengeStatusViaApi(ctx.request, challenge.digits, "valid");
  const solution = await proposeSolutionViaApi(ctx.request, challenge.digits, { description: "My editable solution." });

  const page = await ctx.newPage();
  const posted = await stubAttachments(page);
  await page.goto(`/challenges/${challenge.digits}`);
  await page.getByRole("button", { name: "Propose a solution" }).click();
  await expect(page.getByRole("heading", { name: "Propose a solution" })).toBeVisible();

  await dragFilesOver(page, ["plan.pdf"]);
  await expect(page.getByTestId("drop-target")).toHaveText(["Your new solution", `Your solution ${solution.number}`]);
  await dropOn(page, `Your solution ${solution.number}`);
  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toMatchObject({ name: "plan.pdf", draftKey: null });
  expect(posted[0]!.parentId).not.toBeNull();

  // Several targets and no focus inside one: nothing attaches, and the page says why.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await paste(page, { files: [{ name: "image.png", type: "image/png" }] })).toBe(true);
  await expect(page.getByText("Click into the form you want to attach to, then paste")).toBeVisible();
  expect(posted).toHaveLength(1);

  // Focus inside the proposal form routes the paste to its staged control.
  await page.getByLabel("Solution description").focus();
  expect(await paste(page, { files: [{ name: "diagram.png", type: "image/png" }] })).toBe(true);
  await expect.poll(() => posted.length).toBe(2);
  expect(posted[1]).toMatchObject({ name: "diagram.png", parentId: null });
  expect(posted[1]!.draftKey).not.toBeNull();

  await ctx.close();
});

test("a file drag with no available control raises no overlay but never lets the browser open the file", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const ctx = await browser.newContext();
  await signIn(ctx, { name: `E2E Drop Viewer ${stamp}`, admin: true });
  const challenge = await createChallengeViaApi(ctx.request, { title: `No targets ${stamp}`, description: "Nothing editable here." });
  await setChallengeStatusViaApi(ctx.request, challenge.digits, "valid"); // the author's edit window has closed

  const page = await ctx.newPage();
  await page.goto(`/challenges/${challenge.digits}`);
  await expect(page.getByRole("heading", { name: `No targets ${stamp}` })).toBeVisible();
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["x"], "stray.pdf"));
    document.body.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }));
    const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
    document.body.dispatchEvent(over);
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    document.body.dispatchEvent(drop);
    return over.defaultPrevented && drop.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await expect(page.getByTestId("drop-overlay")).toHaveCount(0);

  await ctx.close();
});
