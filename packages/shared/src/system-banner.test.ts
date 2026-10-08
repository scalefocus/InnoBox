// Unit tests for the §14.6 system-banner rules: input validation (length, tone, fixed durations,
// safe links), lazy expiry, and the remaining-time label.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SYSTEM_BANNER_DURATION_HOURS,
  SYSTEM_BANNER_MESSAGE_MAX,
  bannerRemainingLabel,
  isAllowedBannerUrl,
  isSystemBannerActive,
  validateSystemBannerInput,
} from "./system-banner.js";

test("durations are the fixed set in whole hours", () => {
  assert.deepEqual(SYSTEM_BANNER_DURATION_HOURS, { "1h": 1, "4h": 4, "8h": 8, "1d": 24, "1w": 168, "30d": 720 });
});

test("validateSystemBannerInput accepts a plain message with a duration and defaults the tone", () => {
  const r = validateSystemBannerInput({ message: "  Maintenance   tonight ", duration: "4h" });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.value, { message: "Maintenance tonight", tone: "info", url: null, duration: "4h" });
});

test("validateSystemBannerInput refuses bad shapes", () => {
  assert.equal(validateSystemBannerInput(null).ok, false);
  assert.equal(validateSystemBannerInput({ duration: "1h" }).ok, false, "message required");
  assert.equal(validateSystemBannerInput({ message: "   ", duration: "1h" }).ok, false, "whitespace is not a message");
  assert.equal(validateSystemBannerInput({ message: "x".repeat(SYSTEM_BANNER_MESSAGE_MAX + 1), duration: "1h" }).ok, false, "over the cap");
  assert.equal(validateSystemBannerInput({ message: "x".repeat(SYSTEM_BANNER_MESSAGE_MAX), duration: "1h" }).ok, true, "exactly the cap");
  assert.equal(validateSystemBannerInput({ message: "x", duration: "2h" }).ok, false, "no custom durations");
  assert.equal(validateSystemBannerInput({ message: "x", duration: "1h", tone: "danger" }).ok, false, "unknown tone");
  assert.equal(validateSystemBannerInput({ message: "x", duration: "1h", tone: "warning" }).ok, true);
});

test("links: https or app-relative only", () => {
  assert.equal(isAllowedBannerUrl("https://example.test/status"), true);
  assert.equal(isAllowedBannerUrl("/whats-new"), true);
  assert.equal(isAllowedBannerUrl("http://example.test"), false);
  assert.equal(isAllowedBannerUrl("//evil.test"), false);
  assert.equal(isAllowedBannerUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedBannerUrl("data:text/html,hi"), false);
  assert.equal(isAllowedBannerUrl("/a path"), false);
  const ok = validateSystemBannerInput({ message: "m", duration: "1h", url: " https://example.test/x " });
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.value.url, "https://example.test/x");
  assert.equal(validateSystemBannerInput({ message: "m", duration: "1h", url: "http://x" }).ok, false);
  const empty = validateSystemBannerInput({ message: "m", duration: "1h", url: "" });
  assert.ok(empty.ok);
  if (empty.ok) assert.equal(empty.value.url, null, "an empty link field means no link");
});

test("isSystemBannerActive is lazy expiry judged at read time", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const banner = { message: "m", tone: "info" as const, url: null, expiresAt: "2026-10-08T13:00:00Z" };
  assert.equal(isSystemBannerActive(banner, now), true);
  assert.equal(isSystemBannerActive(banner, now + 3_600_000), false, "the boundary itself is expired");
  assert.equal(isSystemBannerActive(null, now), false);
  assert.equal(isSystemBannerActive({ ...banner, expiresAt: "garbage" }, now), false);
});

test("bannerRemainingLabel reads naturally at every scale", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(bannerRemainingLabel(at(30_000), now), "expires in 30s");
  assert.equal(bannerRemainingLabel(at(5 * 60_000), now), "expires in 5m");
  assert.equal(bannerRemainingLabel(at((3 * 60 + 20) * 60_000), now), "expires in 3h 20m");
  assert.equal(bannerRemainingLabel(at((6 * 24 + 2) * 3_600_000), now), "expires in 6d 2h");
  assert.equal(bannerRemainingLabel(at(-1), now), "expired");
});
