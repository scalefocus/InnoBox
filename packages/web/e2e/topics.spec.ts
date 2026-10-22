// Topics e2e (INNOBOX_SPEC.md §34.9): a platform admin adds a topic; a member follows it on
// `/topics`; a challenge tagged with it is moved to `valid`; the follower's bell shows the event-18
// row ("New in …"), and the topic's chip on the challenge's card filters the gallery to that topic,
// whose header shows the follow state. The topic list is platform-wide, so the spec retires and
// deletes its topic whatever happens (and runs in the platform-state project).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, setChallengeStatusViaApi } from "./helpers/api";
import { uniqueStamp } from "./helpers/stamp";

const base = () => process.env.E2E_BASE_URL || "http://localhost:3000";
const JSON_HEADERS = { "content-type": "application/json" };

test("topics: follow on /topics, hear when a tagged challenge opens, filter by its chip", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  const authorCtx = await browser.newContext();
  const fanCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Topics Admin ${stamp}`, admin: true });
  await signIn(authorCtx, { name: `E2E Topics Author ${stamp}` });
  await signIn(fanCtx, { name: `E2E Topics Fan ${stamp}` });

  const name = `E2E Topic ${stamp}`;
  let topicId: string | null = null;
  try {
    const created = await adminCtx.request.post(`${base()}/api/admin/topics`, {
      data: { name, description: "Followed by the topics spec." },
      headers: JSON_HEADERS,
    });
    expect(created.status()).toBe(201);
    topicId = ((await created.json()) as { topic: { id: string } }).topic.id;

    // ── The fan follows it on /topics. ──
    const page = await fanCtx.newPage();
    await page.goto("/topics");
    const row = page.getByTestId("topic-row").filter({ hasText: name });
    await expect(row).toBeVisible();
    const follow = row.getByTestId("topic-follow");
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    await follow.click();
    await expect(follow).toHaveAttribute("aria-pressed", "true");

    // ── A challenge tagged with it opens for solutions. ──
    const title = `Topical ${stamp}`;
    const challenge = await createChallengeViaApi(authorCtx.request, { title, description: "A challenge in a followed topic.", topicIds: [topicId] });
    await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid");

    // ── The fan's bell carries event 18. ──
    await page.goto("/");
    await page.getByRole("button", { name: "Notifications" }).click();
    await expect(page.locator(".msg-panel")).toContainText(`New in ${name}: ${challenge.number}`);

    // ── The chip on the card filters the gallery to the topic; its header shows the follow. ──
    await page.goto("/challenges");
    await expect(page.getByText(title)).toBeVisible();
    await page.getByRole("link", { name, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`topic=${topicId}`));
    await expect(page.getByTestId("topic-follow").first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(title)).toBeVisible();
  } finally {
    if (topicId) {
      await adminCtx.request.patch(`${base()}/api/admin/topics/${topicId}`, { data: { active: false }, headers: JSON_HEADERS }).catch(() => {});
      await adminCtx.request.delete(`${base()}/api/admin/topics/${topicId}`).catch(() => {});
    }
    await adminCtx.close();
    await authorCtx.close();
    await fanCtx.close();
  }
});
