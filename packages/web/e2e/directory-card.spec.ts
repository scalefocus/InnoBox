// Directory hover card e2e (INNOBOX_SPEC.md §13.8): hovering an avatar bubble opens a floating
// card with the person's directory profile and a link to their full profile; keyboard focus opens
// it and Escape closes it; and — the invariant-3 case — an ANONYMOUS author's bubble opens no card
// and issues no request at all, so nothing distinguishes two anonymous authors.
// Keyboard users reach "View profile" through explicit Tab routing around the portalled card;
// your own bubble links to /profile; a scrubbed author renders the "Deleted User" bubble from the
// payload's flag with no profile behind it; and the read-only assignee on a terminal triage row
// opens the card without opening the row. On touch and pen, press and hold opens the same card,
// while a short tap, a drag and an anonymous bubble never do.
//
// Dev-auth personas carry no department/job title/office (those are Entra attributes written by
// reconciliation, §3), so the card's directory block legitimately renders its degraded
// "No directory information." state here — which is exactly the graceful-degradation contract the
// spec requires, and is asserted as such.
import { test, expect, type Locator } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

test("directory card: hover opens it, keyboard reaches it, and an anonymous author never gets one", async ({ browser }) => {
  test.slow(); // Next dev-mode first-hit route compilation

  const stamp = uniqueStamp();
  const authorName = `E2E Card Author ${stamp}`;

  const ctx = await browser.newContext();
  await signIn(ctx, { name: authorName });

  const named = await createChallengeViaApi(ctx.request, {
    title: `E2E card named challenge ${stamp}`,
    description: "Raised by the directory-card e2e suite.",
  });
  const anon = await createChallengeViaApi(ctx.request, {
    title: `E2E card anonymous challenge ${stamp}`,
    description: "Raised anonymously by the directory-card e2e suite.",
    isAnonymous: true,
  });

  const page = await ctx.newPage();

  // Every /api/users/:id/card request this page makes, in order — the lazy-fetch and
  // anonymity assertions below are both about *whether one happens at all*.
  const cardRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/users\/[^/]+\/card(\?|$)/.test(req.url())) cardRequests.push(req.url());
  });

  // ── a named author's bubble ──────────────────────────────────────────────────────────────
  await page.goto(`/challenges/${named.digits}`);
  await expect(page.getByRole("heading", { name: named.title })).toBeVisible();

  const authorBubble = page.locator(".avatar.avatar-md[role='button']").first();
  await expect(authorBubble).toBeVisible();
  // Lazy: nothing is fetched on render, only on hover intent.
  expect(cardRequests, "no card request before any hover").toHaveLength(0);

  const cardResponse = page.waitForResponse((res) => /\/api\/users\/[^/]+\/card(\?|$)/.test(res.url()));
  await authorBubble.hover();
  const card = page.getByRole("dialog", { name: authorName });
  await expect(card).toBeVisible();
  expect(cardRequests.length, "hovering fetches the card exactly once").toBe(1);
  // §13.8: the body is the flat card — no wrapper key. `gamification` is the §23.12 card block.
  const body = await (await cardResponse).json();
  expect(Object.keys(body).sort()).toEqual(
    ["deactivated", "department", "displayName", "gamification", "jobTitle", "officeLocation", "scrubbed", "userId"],
  );
  expect(body.displayName).toBe(authorName);

  await expect(card.getByText(authorName)).toBeVisible();
  // A dev persona has no Entra directory attributes → the degraded state, never an error.
  await expect(card.getByText("No directory information.")).toBeVisible();
  // The card is a dead end without this link (§13.8) — InnoBox has a real profile page.
  await expect(card.getByRole("link", { name: "View profile" })).toBeVisible();

  // ── keyboard: focus opens with no delay, Escape closes and returns focus ─────────────────
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  // Escape leaves focus on the bubble — and handing it back must not reopen the card.
  await expect(authorBubble).toBeFocused();
  await expect(card).toBeHidden();

  // Focus arriving afresh opens the card with no delay.
  await authorBubble.blur();
  await authorBubble.focus();
  await expect(page.getByRole("dialog", { name: authorName })).toBeVisible();
  // Re-hovering/re-opening is served from the per-page-session cache — no second request.
  expect(cardRequests.length, "the card is cached per user id for the page session").toBe(1);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: authorName })).toBeHidden();
  await expect(authorBubble).toBeFocused();

  // ── the anonymous author: no card, no request, no tab stop (invariant 3) ─────────────────
  const before = cardRequests.length;
  await page.goto(`/challenges/${anon.digits}`);
  await expect(page.getByRole("heading", { name: anon.title })).toBeVisible();

  const anonBubble = page.locator(".avatar-anon").first();
  await expect(anonBubble).toBeVisible();
  // Not a trigger at all: no button role, so no tab stop and no handlers.
  await expect(page.locator(".avatar-anon[role='button']")).toHaveCount(0);

  await anonBubble.hover();
  // Well past the 300 ms hover-intent threshold — nothing must open, ever.
  await page.waitForTimeout(700);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(cardRequests.length, "an anonymous author's bubble issues NO card request").toBe(before);

  await ctx.close();
});

test("directory card: Tab routes into and out of the portalled card; your own bubble links to /profile", async ({ browser }) => {
  test.slow();

  const stamp = uniqueStamp();
  const authorName = `E2E Card Keys ${stamp}`;
  const ctx = await browser.newContext();
  const { userId: authorId } = await signIn(ctx, { name: authorName });
  const named = await createChallengeViaApi(ctx.request, {
    title: `E2E card keyboard challenge ${stamp}`,
    description: "Raised by the directory-card keyboard e2e.",
  });

  const page = await ctx.newPage();
  await page.goto(`/challenges/${named.digits}`);
  await expect(page.getByRole("heading", { name: named.title })).toBeVisible();

  const bubble = page.locator(".avatar.avatar-md[role='button']").first();
  const card = page.getByRole("dialog", { name: authorName });
  const link = card.getByRole("link", { name: "View profile" });

  // Where focus sits relative to the bubble in page order (the card is portalled to the end of
  // <body>, so "after the bubble" is exactly what the browser's own Tab order gets wrong).
  const focusRelativeToBubble = () =>
    page.evaluate(() => {
      const b = document.querySelector(".avatar.avatar-md[role='button']");
      const a = document.activeElement;
      if (!b || !a || a === document.body || a.closest(".dir-card")) return "none";
      const pos = b.compareDocumentPosition(a);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return "after";
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return "before";
      return "same";
    });

  // Your own bubble links to /profile — decided by id, no caller marks it "self".
  await bubble.focus();
  await expect(card).toBeVisible();
  await expect(link).toHaveAttribute("href", "/profile");

  // Tab on the bubble moves into the card…
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await expect(card).toBeVisible();
  // …and Tab out continues after the bubble, closing the card.
  await page.keyboard.press("Tab");
  await expect(card).toBeHidden();
  expect(await focusRelativeToBubble()).toBe("after");

  // Shift+Tab out of the card goes to the element before the bubble.
  await bubble.focus();
  await expect(card).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(card).toBeHidden();
  expect(await focusRelativeToBubble()).toBe("before");

  // Someone else's view of the same bubble links to the public profile. (An admin: a fresh
  // challenge is awaiting triage, visible only to its author and the namespace's admins.)
  const otherCtx = await browser.newContext();
  await signIn(otherCtx, { name: `E2E Card Viewer ${stamp}`, admin: true });
  const other = await otherCtx.newPage();
  await other.goto(`/challenges/${named.digits}`);
  await expect(other.getByRole("heading", { name: named.title })).toBeVisible();
  await other.locator(".avatar.avatar-md[role='button']").first().hover();
  await expect(other.getByRole("dialog", { name: authorName }).getByRole("link", { name: "View profile" })).toHaveAttribute(
    "href",
    `/profile/${authorId}`,
  );

  await ctx.close();
  await otherCtx.close();
});

test("directory card: a scrubbed author renders the Deleted User bubble from the flag, with no profile and no link", async ({ browser }) => {
  test.slow();

  const stamp = uniqueStamp();
  const json = { "content-type": "application/json", accept: "application/json" };
  const authorCtx = await browser.newContext();
  const { userId: authorId } = await signIn(authorCtx, { name: `E2E Card Leaver ${stamp}` });
  const ch = await createChallengeViaApi(authorCtx.request, {
    title: `E2E card scrubbed author ${stamp}`,
    description: "Raised by a user who is then erased.",
  });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Card Eraser ${stamp}`, admin: true });
  const scrub = await adminCtx.request.post(`/api/admin/users/${authorId}/scrub`, { data: {}, headers: json });
  expect(scrub.status()).toBe(200);

  // The payload names the state explicitly — the bubble never infers it from the display name.
  const detail = await (await adminCtx.request.get(`/api/challenges/${ch.digits}`, { headers: json })).json();
  expect(detail.challenge.author).toMatchObject({ userId: authorId, anonymous: false, active: false, scrubbed: true });

  const page = await adminCtx.newPage();
  await page.goto(`/challenges/${ch.digits}`);
  await expect(page.getByRole("heading", { name: ch.title })).toBeVisible();
  const bubble = page.locator(".avatar.avatar-md.avatar-deleted[role='button']").first();
  await expect(bubble).toBeVisible();
  await bubble.hover();
  const card = page.getByRole("dialog", { name: "Deleted User" });
  await expect(card.getByText("No directory information.")).toBeVisible();
  await expect(card.getByRole("link", { name: "View profile" })).toHaveCount(0);

  // A scrubbed user has no profile: the generic not-found, never a "Deleted User" page.
  await page.goto(`/profile/${authorId}`);
  await expect(page.getByText("That profile doesn't exist.")).toBeVisible();

  await authorCtx.close();
  await adminCtx.close();
});

test("directory card: the read-only assignee on a terminal triage row opens the card without opening the row", async ({ browser }) => {
  test.slow();

  const stamp = uniqueStamp();
  const json = { "content-type": "application/json", accept: "application/json" };
  const assigneeName = `E2E Card Assignee ${stamp}`;
  const assigneeCtx = await browser.newContext();
  const { userId: assigneeId } = await signIn(assigneeCtx, { name: assigneeName });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Card Triage Admin ${stamp}`, admin: true });
  const ch = await createChallengeViaApi(adminCtx.request, {
    title: `E2E card terminal row ${stamp}`,
    description: "Assigned, then rejected.",
  });
  await setChallengeStatusViaApi(adminCtx.request, ch.digits, "in_review");
  const assigned = await adminCtx.request.post(`/api/challenges/${ch.digits}/assign`, { data: { userId: assigneeId }, headers: json });
  expect(assigned.status()).toBe(200);
  await setChallengeStatusViaApi(adminCtx.request, ch.digits, "rejected");

  const page = await adminCtx.newPage();
  await page.goto("/admin/triage");
  // The unfiltered queue may already list this row; the debounced number filter then refetches
  // and remounts the rows, so a hover landed before that refetch hits a detached bubble. Wait
  // for the filtered response before touching the row.
  const filtered = page.waitForResponse((r) => r.url().includes("/api/admin/triage?") && r.url().includes(`number=${ch.number}`));
  await page.getByPlaceholder("CH-123").fill(ch.number);
  await filtered;
  const row = page.locator(".triage-rows .row-link").filter({ hasText: ch.title });
  await expect(row).toHaveCount(1);

  // Terminal row → the read-only assignee text, whose bubble is a card trigger (no popover here).
  await expect(row.locator(".assignee-input")).toHaveCount(0);
  const bubble = row.locator(`.avatar[role='button'][aria-label="${assigneeName}"]`);
  await expect(bubble).toBeVisible();
  await bubble.hover();
  await expect(page.getByRole("dialog", { name: assigneeName })).toBeVisible();

  // Clicking it stays on the queue — the read-only cell stops propagation like the editable one.
  await bubble.click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/admin\/triage$/);

  await assigneeCtx.close();
  await adminCtx.close();
});

test("directory card: press and hold opens it on touch; a tap, a drag or an anonymous bubble never does", async ({ browser }) => {
  test.slow();

  const stamp = uniqueStamp();
  const authorName = `E2E Card Holder ${stamp}`;
  const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  await signIn(ctx, { name: authorName });
  const named = await createChallengeViaApi(ctx.request, {
    title: `E2E card hold challenge ${stamp}`,
    description: "Raised by the press-and-hold e2e.",
  });
  const anon = await createChallengeViaApi(ctx.request, {
    title: `E2E card hold anonymous ${stamp}`,
    description: "Raised anonymously by the press-and-hold e2e.",
    isAnonymous: true,
  });

  const page = await ctx.newPage();
  const cardRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/api\/users\/[^/]+\/card(\?|$)/.test(req.url())) cardRequests.push(req.url());
  });

  // Real touch input through the browser's own gesture pipeline (pointerType "touch").
  const cdp = await ctx.newCDPSession(page);
  const press = async (target: Locator, opts: { ms: number; driftY?: number }) => {
    const box = (await target.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    if (opts.driftY) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + opts.driftY }] });
    await page.waitForTimeout(opts.ms);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  await page.goto(`/challenges/${named.digits}`);
  await expect(page.getByRole("heading", { name: named.title })).toBeVisible();
  const bubble = page.locator(".avatar.avatar-md[role='button']").first();
  const card = page.getByRole("dialog", { name: authorName });

  // A short tap is unchanged: no card, no request (it even focuses the bubble — still no card).
  await press(bubble, { ms: 80 });
  await page.waitForTimeout(700);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A press that drifts is a scroll, never a hold.
  await press(bubble, { ms: 800, driftY: 30 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(cardRequests, "neither a tap nor a drag fetches the card").toHaveLength(0);

  // Press and hold opens the same card, fetching it at the threshold.
  await press(bubble, { ms: 800 });
  await expect(card).toBeVisible();
  await expect(card.getByRole("link", { name: "View profile" })).toBeVisible();
  expect(cardRequests).toHaveLength(1);
  // Lifting the finger does not close it (touch "leaves" on every lift).
  await page.waitForTimeout(500);
  await expect(card).toBeVisible();

  // A tap outside closes it.
  await page.getByRole("heading", { name: named.title }).tap();
  await expect(card).toBeHidden();

  // Holding the same bubble again toggles it closed.
  await press(bubble, { ms: 800 });
  await expect(card).toBeVisible();
  await press(bubble, { ms: 800 });
  await expect(card).toBeHidden();

  // A hold-opened card closes on scroll.
  await press(bubble, { ms: 800 });
  await expect(card).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
  await expect(card).toBeHidden();

  // The bubble suppresses the native long-press callout / selection.
  expect(await bubble.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");

  // A hold inside a link (a search result row) opens the card and never also navigates.
  await page.goto(`/search?q=${encodeURIComponent(named.title)}`);
  const row = page.locator("a.row").filter({ hasText: named.title });
  await expect(row).toHaveCount(1);
  await press(row.locator(".avatar[role='button']"), { ms: 800 });
  await expect(page.getByRole("dialog", { name: authorName })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/search\?/);

  // An anonymous author's bubble: no card and no request, however long it is held.
  const before = cardRequests.length;
  await page.goto(`/challenges/${anon.digits}`);
  await expect(page.getByRole("heading", { name: anon.title })).toBeVisible();
  await press(page.locator(".avatar-anon").first(), { ms: 800 });
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(cardRequests.length, "an anonymous bubble issues NO card request").toBe(before);

  await ctx.close();
});
