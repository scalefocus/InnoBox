// "Currently online" panel e2e (INNOBOX_SPEC.md §14.5). Covers the user-facing flow: the
// platform-admin gate, the panel's four blocks, the window selector persisting per browser,
// the client-side search, the explicit Refresh (nothing polls), and the `presence.view` audit
// row. The anonymity masking of locations (§9) is asserted at the SQL level instead, in
// api/admin/presence/store.dbtest.ts — it needs anonymous fixtures and a controlled
// last_route, which the 60-second write throttle makes unreliable to stage through the UI.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";

test("presence panel: platform-admin only, and a namespace-less member gets 403 from the API", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Presence Member ${stamp}` });

  // The panel lives inside the platform-admin console, so a member sees no card at all…
  const memberPage = await memberCtx.newPage();
  await memberPage.goto("/admin");
  await expect(memberPage.getByRole("heading", { name: "Administration is restricted" })).toBeVisible();
  await expect(memberPage.getByRole("heading", { name: "Currently online" })).toHaveCount(0);

  // …and the endpoints behind it refuse them directly, not just in the UI.
  const summary = await memberCtx.request.get("/api/admin/presence?window=5m", { headers: { accept: "application/json" } });
  expect(summary.status()).toBe(403);
  const history = await memberCtx.request.get("/api/admin/presence/history?range=30d", { headers: { accept: "application/json" } });
  expect(history.status()).toBe(403);

  await memberCtx.close();
});

test("presence panel: lists who is active, with the window, search and Refresh — and no Reach out", async ({ browser }) => {
  const stamp = Date.now().toString(36);

  // A member whose sign-in lands them on the dashboard — an allowlisted request, so they are
  // located at "Overview". This is the allowlist working end to end.
  const memberName = `E2E Presence Visitor ${stamp}`;
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: memberName });

  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Presence Admin ${stamp}`, admin: true });
  const admin = await adminCtx.newPage();
  await admin.goto("/admin");

  const card = admin.locator(".card", { has: admin.getByRole("heading", { name: "Currently online" }) });
  await expect(card).toBeVisible();

  // Block 1 — the chart, or the honest "no history yet" note on a young install. One or the
  // other must render; a blank space would mean the fetch failed.
  const chart = card.locator("svg.presence-chart");
  const chartNote = card.locator(".presence-chart-empty");
  await expect(chart.or(chartNote).first()).toBeVisible();

  // Block 2 — the rolling tiles.
  for (const label of ["DAU · last 24h", "WAU · last 7d", "MAU · last 30d"]) {
    await expect(card.locator(".stat-label", { hasText: label })).toBeVisible();
  }

  // Block 3 — the window selector, defaulting to 5m (§14.5).
  await expect(card.getByRole("button", { name: "5m", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(card.getByText("Users active within the last 5 minutes.")).toBeVisible();

  // Block 4 — the list. The member was active seconds ago, so they are inside the default
  // window, and their location is the dashboard they landed on.
  const memberRow = card.locator(".rows .row", { hasText: memberName });
  await expect(memberRow).toBeVisible();
  await expect(memberRow.locator(".presence-where")).toHaveText("Overview");
  await expect(memberRow.locator(".chip", { hasText: "active" })).toBeVisible();

  // Explicitly NOT built (§14.5): there is no direct-message channel to hand off to.
  await expect(card.getByRole("button", { name: "Reach out" })).toHaveCount(0);

  // The search filters the fetched set client-side.
  const search = card.getByPlaceholder("Search online users by name or email…");
  await search.fill(memberName);
  await expect(memberRow).toBeVisible();
  await search.fill(`no-such-person-${stamp}`);
  await expect(card.getByText("No online user matches that search.")).toBeVisible();
  await search.fill("");

  // Nothing polls — the snapshot carries its own "as of" stamp and an explicit Refresh.
  await expect(card.getByText(/as of /)).toBeVisible();
  await card.getByRole("button", { name: "Refresh" }).click();
  await expect(card.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(memberRow).toBeVisible();

  // The disclosure line: presence tracking is stated in the panel, never covert.
  await expect(card.getByText(/Presence is recorded from activity in the app/)).toBeVisible();

  // Widening the window keeps them listed and persists the choice for this browser.
  await card.getByRole("button", { name: "24h", exact: true }).click();
  await expect(card.getByText("Users active within the last 24 hours.")).toBeVisible();
  await admin.reload();
  const reloaded = admin.locator(".card", { has: admin.getByRole("heading", { name: "Currently online" }) });
  await expect(reloaded.getByRole("button", { name: "24h", exact: true })).toHaveAttribute("aria-pressed", "true");

  await memberCtx.close();
  await adminCtx.close();
});

test("presence panel: opening it writes one presence.view audit row (§14.5, §15)", async ({ browser }) => {
  const stamp = Date.now().toString(36);
  const adminCtx = await browser.newContext();
  const { userId } = await signIn(adminCtx, { name: `E2E Presence Auditor ${stamp}`, admin: true });

  const admin = await adminCtx.newPage();
  await admin.goto("/admin");
  await expect(admin.locator(".rows .row").first()).toBeVisible();

  // Reads are normally unaudited in InnoBox; this one is the deliberate exception, because
  // "an admin looked at who is online" is the access a DPO asks about.
  await admin.goto("/admin/audit");
  await admin.getByRole("tab", { name: "Admin" }).click();
  await admin.getByLabel("Search").fill("presence.view");
  const row = admin.locator(".rows .row").first();
  await expect(row.locator(".chip.chip-accent.mono", { hasText: "presence.view" })).toBeVisible();
  await row.getByRole("button", { name: "Details" }).click();
  // The payload records which window was inspected, and by whom.
  await expect(row.locator("pre.mono")).toContainText("window");
  await expect(admin.locator(".rows .row").first()).toContainText("Presence Auditor");
  expect(userId).toBeTruthy();

  await adminCtx.close();
});
