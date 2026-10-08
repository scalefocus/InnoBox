// Visibility enforcement e2e (INNOBOX_SPEC.md §4.3; invariant 2). A namespace-restricted
// challenge must NEVER leak to a non-member — not via the gallery, search, or a direct link. The
// filter is enforced server-side (canSeeChallenge), so this proves the whole read path end-to-end.
//
// Dev-auth can only mint a platform admin (member of every namespace) or a plain member (member of
// `global` only). So the realistic contrast is: platform-admin author (sees it) vs a true
// non-member outsider (must not). A namespace-visible challenge in a fresh NON-global namespace is
// the fixture — one in `global` would be visible to everyone (implicit global membership).
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { createChallengeViaApi, createNamespaceViaApi, setChallengeStatusViaApi } from "./helpers/api";

test("a namespace-restricted challenge is hidden from a non-member across gallery, search, and direct link", async ({
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const title = `E2E restricted challenge ${stamp}`;

  // ── Admin sets up a fresh namespace + a namespace-visible challenge, opened for solutions. ──
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: "E2E Vis Admin", admin: true });
  const ns = await createNamespaceViaApi(adminCtx.request, { slug: `e2e-${stamp}`, displayName: `E2E NS ${stamp}` });
  const challenge = await createChallengeViaApi(adminCtx.request, {
    title,
    description: "Only this namespace's members should see this.",
    namespaceId: ns.id,
    visibility: "namespace",
  });
  await setChallengeStatusViaApi(adminCtx.request, challenge.digits, "valid"); // out of awaiting_triage → target the namespace gate

  // ── Positive: the admin (a member of every namespace) DOES see it everywhere. ──
  const admin = await adminCtx.newPage();
  await admin.goto("/challenges");
  await expect(admin.getByRole("heading", { name: title })).toBeVisible();
  await admin.goto(`/search?q=CH-${challenge.digits}`);
  await expect(admin.locator(".chip.mono", { hasText: challenge.number })).toBeVisible();
  await admin.goto(`/challenges/${challenge.digits}`);
  await expect(admin.getByRole("heading", { name: title })).toBeVisible();

  // ── Negative: a plain-member outsider (non-member of the new namespace) sees it NOWHERE. ──
  const outsiderCtx = await browser.newContext();
  await signIn(outsiderCtx, { name: `E2E Outsider ${stamp}` });
  const outsider = await outsiderCtx.newPage();

  // Gallery (default "Open" tab lists `valid` challenges the viewer can see).
  await outsider.goto("/challenges");
  await expect(outsider.getByRole("heading", { name: title })).toHaveCount(0);

  // Search — even an exact CH-number lookup is filtered out server-side (no existence oracle).
  await outsider.goto(`/search?q=CH-${challenge.digits}`);
  await expect(outsider.getByText("No matching challenges.")).toBeVisible();
  await expect(outsider.locator(".chip.mono", { hasText: challenge.number })).toHaveCount(0);

  // Direct link — 404 folded together with "no access" (same page, no oracle).
  await outsider.goto(`/challenges/${challenge.digits}`);
  await expect(outsider.getByText("That challenge doesn't exist, or you don't have access to it.")).toBeVisible();

  await adminCtx.close();
  await outsiderCtx.close();
});
