// Comment Markdown e2e (INNOBOX_SPEC.md §44.10): user A writes a comment of two paragraphs with
// **bold**, a list, an address and `@` plus the start of user B's name, picks B from the list and sees
// B's chip in the Mentioned row; the Preview tab shows it formatted; Ctrl+Enter posts it; the thread
// shows the bold text, the list, a link that opens in a new tab and B's name as a link; B's bell shows
// "… mentioned you in a comment on CH-…", and the link opens the challenge at that comment.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("comment markdown: formatting, a link and a mention, the preview, Ctrl+Enter, the notice that opens the comment", async ({ browser }) => {
  test.slow(); // three personas and a cold-compiled detail page
  const stamp = uniqueStamp();
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";
  const adminCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  const mentionedCtx = await browser.newContext();
  try {
    await signIn(adminCtx, { name: `E2E Comment Admin ${stamp}`, admin: true });
    const authorName = `E2E Comment Ana ${stamp}`;
    await signIn(authorCtx, { name: authorName });
    const mentionedName = `E2E Comment Bob ${stamp}`;
    await signIn(mentionedCtx, { name: mentionedName });

    const challenge = await createChallengeViaApi(adminCtx.request, { title: `Comment markdown challenge ${stamp}`, description: "Does the thread take Markdown?" });
    await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");
    // Earlier comments push the one under test below the fold, so "opens at that comment" is a scroll.
    for (let i = 1; i <= 8; i++) {
      const res = await adminCtx.request.post(`${base}/api/comments`, {
        data: { parentType: "challenge", parentId: challenge.id, body: `Earlier remark ${i} ${stamp}` },
        headers: { "content-type": "application/json" },
      });
      expect(res.status()).toBe(201);
    }

    // ── A writes two paragraphs, a list and an address, types @ and picks B from the list. ──
    const address = `https://example.com/notes/${stamp}`;
    const typed = [`Markdown comment ${stamp} with **bold words**.`, "", "- first point", "- second point", "", `See ${address} and ask @Bob ${stamp}`].join("\n");
    const written = typed.replace(`@Bob ${stamp}`, `@${mentionedName} `);

    const page = await authorCtx.newPage();
    await page.goto(`/challenges/${challenge.digits}`);
    const box = page.getByPlaceholder("Add a comment…");
    const composer = page.locator("form.comment-box", { has: box });
    await box.fill(typed); // the box is multi-line: the text keeps its line breaks
    await expect(page.getByRole("option", { name: new RegExp(mentionedName) })).toBeVisible();
    await box.press("Enter"); // while the list is open, Enter picks the highlighted person
    await expect(box).toHaveValue(written);
    const mentioned = composer.getByTestId("mentioned-row");
    await expect(mentioned).toContainText(mentionedName);
    await expect(mentioned).toContainText("They'll be told when you post.");

    // ── Preview shows the comment as the thread will: formatted, linked, the mention bound. ──
    await composer.getByRole("tab", { name: "Preview" }).click();
    await expect(box).toBeHidden();
    const preview = composer.getByRole("tabpanel", { name: "Preview" });
    await expect(preview.locator("strong")).toHaveText("bold words");
    await expect(preview.locator("li")).toHaveText(["first point", "second point"]);
    await expect(preview.getByRole("link", { name: address })).toHaveAttribute("target", "_blank");
    await expect(preview.locator("a.mention")).toHaveText(`@${mentionedName}`);

    // ── Switching back changes nothing in the text; Ctrl+Enter posts it and empties the box. ──
    await composer.getByRole("tab", { name: "Markdown" }).click();
    await expect(box).toHaveValue(written);
    await box.press("Control+Enter");
    await expect(box).toHaveValue("");
    await expect(composer.getByRole("tab", { name: "Markdown" })).toHaveAttribute("aria-selected", "true");

    // ── The thread: bold, the list, a link that opens in a new tab, and B's name as a link. ──
    const comment = page.locator(".rows .row", { hasText: `Markdown comment ${stamp}` });
    await expect(comment.locator("strong")).toHaveText("bold words");
    await expect(comment.locator("li")).toHaveText(["first point", "second point"]);
    await expect(comment).not.toContainText("**");
    const link = comment.getByRole("link", { name: address });
    await expect(link).toHaveAttribute("href", address);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(comment.locator("a.mention")).toHaveText(`@${mentionedName}`);
    const anchor = await comment.getAttribute("id"); // comment-<id>
    expect(anchor).toMatch(/^comment-[0-9a-f-]{36}$/);

    // ── B is told at once, and the notice opens the challenge at that comment. ──
    const mentionedPage = await mentionedCtx.newPage();
    await mentionedPage.goto("/");
    await mentionedPage.getByRole("button", { name: "Notifications" }).click();
    const notice = mentionedPage.locator(".msg-panel").getByText(`${authorName} mentioned you in a comment on ${challenge.number}`);
    await expect(notice).toBeVisible();
    await notice.click();
    await expect(mentionedPage).toHaveURL(new RegExp(`/challenges/${challenge.digits}#${anchor}$`));
    const target = mentionedPage.locator(`[id="${anchor}"]`);
    await expect(target).toBeInViewport();
    await expect(target.locator("a.mention")).toHaveText(`@${mentionedName}`);
  } finally {
    await adminCtx.close();
    await authorCtx.close();
    await mentionedCtx.close();
  }
});
