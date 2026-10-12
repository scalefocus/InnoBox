// Avatar photo gateway e2e (INNOBOX_SPEC.md §3.1): a user with no cached Entra photo — every
// dev-auth persona — gets an empty 404 the browser may keep for 5 minutes, so a screen of
// photo-less bubbles does not re-ask the gateway on every render.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("photo gateway: a user with no photo gets a short-lived cacheable 404", async ({ browser }) => {
  const base = process.env.E2E_BASE_URL || "http://localhost:3000";
  const stamp = Date.now().toString(36);

  const ctx = await browser.newContext();
  const { userId } = await signIn(ctx, { name: `E2E Photo Less ${stamp}` });

  const res = await ctx.request.get(`${base}/api/users/${userId}/photo`);
  expect(res.status()).toBe(404);
  expect(res.headers()["cache-control"]).toBe("private, max-age=300");
  expect((await res.body()).length).toBe(0);

  await ctx.close();
});
