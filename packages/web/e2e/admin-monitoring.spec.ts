// Real user monitoring e2e (INNOBOX_SPEC.md §14.12). Covers the user-facing flow: the
// platform-admin gate (page and API), the console link and breadcrumb, the switch persisting
// across a reload, a beacon accepted and shown in the routes table under its page name, the
// chart (or the young-install note), the range buttons and the client-error list.
// The arithmetic (true p75 vs the rollup blend, the trims) is asserted at the SQL level in
// api/rum/store.dbtest.ts and the worker's rum/rollup.dbtest.ts.
import { test, expect } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { uniqueStamp } from "./helpers/stamp";

test("monitoring: platform-admin only, and the API refuses a member with 403", async ({ browser }) => {
  const stamp = uniqueStamp();
  const memberCtx = await browser.newContext();
  await signIn(memberCtx, { name: `E2E Monitoring Member ${stamp}` });
  const page = await memberCtx.newPage();
  await page.goto("/admin/monitoring");
  await expect(page.getByRole("heading", { name: "Real user monitoring is restricted" })).toBeVisible();

  for (const path of ["/api/admin/rum/summary?range=7d", "/api/admin/rum/series?range=7d", "/api/admin/rum/errors", "/api/admin/rum/settings"]) {
    const res = await memberCtx.request.get(path, { headers: { accept: "application/json" } });
    expect(res.status(), path).toBe(403);
  }
  await memberCtx.close();
});

test("monitoring: an admin turns collection on, and a beacon shows up under its page name", async ({ browser }) => {
  const stamp = uniqueStamp();
  const adminCtx = await browser.newContext();
  await signIn(adminCtx, { name: `E2E Monitoring Admin ${stamp}`, admin: true });
  const admin = await adminCtx.newPage();

  // Reached from the console, with the breadcrumb back to it.
  await admin.goto("/admin");
  await admin.getByRole("link", { name: /Real user monitoring/ }).first().click();
  await expect(admin).toHaveURL(/\/admin\/monitoring$/);
  await expect(admin.getByRole("heading", { name: "Real user monitoring", level: 1 })).toBeVisible();
  await expect(admin.getByRole("navigation", { name: /breadcrumb/i }).getByRole("link", { name: "Administration" })).toBeVisible();

  // The switch: turn it on (whatever an earlier run left) and see it persist across a reload.
  const toggle = admin.getByRole("switch", { name: "Collect telemetry" });
  await expect(toggle).toBeEnabled();
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
    await expect(admin.locator(".toast")).toContainText("Collecting telemetry");
  }
  await admin.reload();
  await expect(admin.getByRole("switch", { name: "Collect telemetry" })).toHaveAttribute("aria-checked", "true");

  try {
    // Range presets: 30d by default.
    const ranges = admin.getByRole("group", { name: "Range" });
    await expect(ranges.getByRole("button", { name: "30d", exact: true })).toHaveAttribute("aria-pressed", "true");

    // A beacon from this browser: a challenge page view with an API call and an error.
    const status = await admin.evaluate(async () => {
      const day = new Date().toISOString().slice(0, 10);
      const res = await fetch("/api/rum", {
        method: "POST",
        body: JSON.stringify({
          sid: crypto.randomUUID(),
          views: [{ route: "/challenges/[number]", day, hard: true, lcp: 1800, inp: 120, cls: 0.02, ttfb: 300, nav: 900, api: [140], calls: 1, apiErrors: 0, errors: 1 }],
          errors: [{ message: "E2E monitoring probe failed at step 7", source: "/_next/static/chunks/e2e.js:7", frame: "probe (/_next/static/chunks/e2e.js:7:3)", route: "/challenges/[number]" }],
        }),
      });
      return res.status;
    });
    expect(status).toBe(204);

    // The 7d table reads the raw views: the page name, not the template, and the all-routes row first.
    await ranges.getByRole("button", { name: "7d", exact: true }).click();
    await admin.getByRole("button", { name: "Refresh" }).click();
    const table = admin.getByTestId("rum-routes");
    await expect(table.locator("tbody tr").first()).toContainText("All routes");
    await expect(table.getByRole("rowheader", { name: "Challenge", exact: true })).toBeVisible();
    await expect(admin.getByText(/true 75th percentile/)).toBeVisible();

    // The chart, or the honest note on a young install.
    const chart = admin.getByTestId("rum-chart").locator("canvas");
    const note = admin.locator(".presence-chart-empty");
    await expect(chart.or(note).first()).toBeVisible();

    // The error list shows the probe, deduplicated, as text; expanding shows its source.
    const errorRow = admin.locator(".rum-error", { hasText: "E2E monitoring probe failed" }).first();
    await expect(errorRow).toBeVisible();
    await errorRow.locator("summary").click();
    await expect(errorRow).toContainText("/_next/static/chunks/e2e.js:7");
    await admin.getByRole("group", { name: "Sort errors" }).getByRole("button", { name: "Count" }).click();
    await expect(admin.getByRole("group", { name: "Sort errors" }).getByRole("button", { name: "Count" })).toHaveAttribute("aria-pressed", "true");

    // 30d reads the rollup and says so.
    await ranges.getByRole("button", { name: "30d", exact: true }).click();
    await expect(admin.getByText(/views-weighted mean of each day's p75/)).toBeVisible();
  } finally {
    // Leave the platform as it ships: collection off.
    const toggleNow = admin.getByRole("switch", { name: "Collect telemetry" });
    if ((await toggleNow.getAttribute("aria-checked")) === "true") {
      await toggleNow.click();
      await expect(toggleNow).toHaveAttribute("aria-checked", "false");
    }
    await adminCtx.close();
  }
});
