// Comment replies e2e (INNOBOX_SPEC.md §10.2 "Replies"): reply to a comment, reply to a reply
// (filed under the same thread, with "↪ replying to <name>" that jumps to the comment it answers),
// and the "Show N more replies" expansion once a thread holds more than 3 replies. Single persona,
// all button/form driven.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { submitNewChallenge } from "./helpers/forms";
import { uniqueStamp } from "./helpers/stamp";

test("comment replies: reply, reply to a reply, show more replies", async ({ browser }) => {
  const stamp = uniqueStamp();
  const name = `E2E Replier ${stamp}`;
  const ctx = await browser.newContext();
  await signIn(ctx, { name });
  const page = await ctx.newPage();

  await page.goto("/challenges/new");
  await page.locator("#title").fill(`E2E replies challenge ${stamp}`);
  await page.locator("#description").fill("A thread with replies.");
  await page.locator("#impactArea").selectOption({ label: "Internal" });
  await submitNewChallenge(page);

  const list = page.locator(".rows");
  const row = (text: string) => list.locator(".row").filter({ hasText: text });
  const composer = page.locator("form.comment-reply");
  const reply = async (target: string, body: string) => {
    await row(target).getByRole("button", { name: "Reply", exact: true }).click();
    const input = composer.getByPlaceholder("Write a reply…");
    await expect(input).toBeFocused(); // the composer opens under the thread with focus in it
    await input.fill(body);
    await composer.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(composer).toHaveCount(0);
    await expect(row(body)).toBeVisible();
  };

  // A top-level comment.
  const root = `Root ${stamp}`;
  await page.getByPlaceholder("Add a comment…").fill(root);
  await page.getByRole("button", { name: "Post" }).click();
  await expect(row(root)).toBeVisible();

  // Reply to it: indented under it, no "replying to" line (answering the root is implied).
  const first = `First reply ${stamp}`;
  await reply(root, first);
  await expect(row(first)).toHaveClass(/comment-reply/);
  await expect(row(first)).not.toContainText("replying to");

  // Reply to the reply: same thread, and it names the comment it answers.
  const second = `Second reply ${stamp}`;
  await reply(first, second);
  await expect(row(second)).toHaveClass(/comment-reply/);
  await expect(row(second)).toContainText(`↪ replying to ${name}`);

  // The "replying to" line jumps to the reply it answers and flashes it.
  await row(second).getByRole("button", { name: /replying to/ }).click();
  await expect(row(first)).toHaveClass(/comment-flash/);

  // Two more replies → four in the thread.
  const third = `Third reply ${stamp}`;
  const fourth = `Fourth reply ${stamp}`;
  await reply(root, third);
  await reply(root, fourth);

  // A fresh load shows the first 3 replies and a "Show 1 more reply" button for the rest.
  await page.reload();
  await expect(row(third)).toBeVisible();
  await expect(row(fourth)).toHaveCount(0);
  await list.getByRole("button", { name: "Show 1 more reply" }).click();
  await expect(row(fourth)).toBeVisible();
  await expect(list.getByRole("button", { name: /Show \d+ more/ })).toHaveCount(0);

  // Thread order: the root, then its replies oldest first.
  await expect(list.locator(".row p")).toHaveText([root, first, second, third, fourth]);

  await ctx.close();
});
