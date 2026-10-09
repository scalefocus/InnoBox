// Guards the presence allowlist and its derived helpers (INNOBOX_SPEC.md §14.5). Two
// regressions here would each break the feature in a way the UI cannot show: a poller
// slipping into the allowlist makes "online" mean "left a tab open", and a submission route
// resolving to its own entity re-opens the §9 correlation channel. Both are pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRESENCE_RANGE,
  DEFAULT_PRESENCE_WINDOW,
  PRESENCE_RANGES,
  PRESENCE_WINDOWS,
  categoryLabel,
  parseEntityRoute,
  parsePresenceRange,
  parsePresenceWindow,
  presenceTouchFor,
  rangeDays,
  relativeActive,
  utcDayKey,
  windowPhrase,
  windowSeconds,
  ROUTE_ADMIN,
  ROUTE_CHALLENGES,
  ROUTE_OVERVIEW,
  ROUTE_TRIAGE,
} from "./presence";

test("the 30-second pollers are NOT activity — otherwise 'online' means 'left a tab open'", () => {
  // The notification bell (§12.2) and the triage attention badge (§14.4) both poll every
  // 30s from any open tab. If either counted, a user who opened InnoBox on Monday would
  // still read as "active just now" on Friday.
  assert.equal(presenceTouchFor("/api/notifications", "GET"), null);
  assert.equal(presenceTouchFor("/api/admin/triage/attention", "GET"), null);
  // The shell's new-challenges badge polls on every page — silent, so Home stays "Overview".
  assert.equal(presenceTouchFor("/api/challenges/new-count", "GET"), null);
});

test("the allowlist is exhaustive — an unlisted route is silent, never a default touch", () => {
  // The safe failure mode is an under-count. A route nobody thought about must not stamp.
  for (const p of [
    "/api/me",
    "/api/impact-areas",
    "/api/namespaces",
    "/api/users",
    "/api/users/abc/photo",
    "/api/users/abc/card",
    "/api/attachments/config",
    "/api/something-invented-next-year",
  ]) {
    assert.equal(presenceTouchFor(p, "GET"), null, `${p} must be silent`);
  }
  // Non-API paths never reach the write path at all.
  assert.equal(presenceTouchFor("/challenges/412", "GET"), null);
});

test("page-ish reads locate the user", () => {
  assert.deepEqual(presenceTouchFor("/api/dashboard", "GET"), { tier: "locate", route: ROUTE_OVERVIEW });
  assert.deepEqual(presenceTouchFor("/api/search", "GET"), { tier: "locate", route: "search" });
  assert.deepEqual(presenceTouchFor("/api/leaderboards", "GET"), { tier: "locate", route: "leaderboard" });
  assert.deepEqual(presenceTouchFor("/api/profile/abc", "GET"), { tier: "locate", route: "profile" });
});

test("entity routes carry the number; nested sub-routes stay on the parent", () => {
  assert.deepEqual(presenceTouchFor("/api/challenges/412", "GET"), { tier: "locate", route: "challenge:412" });
  assert.deepEqual(presenceTouchFor("/api/challenges/CH-412", "GET"), { tier: "locate", route: "challenge:412" });
  // Viewing a challenge's solutions, assigning, transitioning: all still "on CH-412".
  assert.deepEqual(presenceTouchFor("/api/challenges/412/solutions", "GET"), { tier: "locate", route: "challenge:412" });
  assert.deepEqual(presenceTouchFor("/api/challenges/412/assign", "POST"), { tier: "locate", route: "challenge:412" });
  assert.deepEqual(presenceTouchFor("/api/solutions/87", "GET"), { tier: "locate", route: "solution:87" });
  assert.deepEqual(presenceTouchFor("/api/solutions/SOL-87/withdraw", "POST"), { tier: "locate", route: "solution:87" });
});

test("a submission is located at the bare category, never at what it created (§9)", () => {
  // "X was submitting" + an anonymous challenge appearing moments later is the same
  // correlation the reveal path exists to gate. POST /api/challenges must stay generic.
  assert.deepEqual(presenceTouchFor("/api/challenges", "POST"), { tier: "locate", route: ROUTE_CHALLENGES });
  assert.deepEqual(presenceTouchFor("/api/solutions", "POST"), { tier: "locate", route: "solutions" });
  // A non-numeric segment can't be an entity — it degrades to the category, never a token.
  assert.deepEqual(presenceTouchFor("/api/challenges/new", "GET"), { tier: "locate", route: ROUTE_CHALLENGES });
});

test("admin routes split triage from the rest of the console", () => {
  assert.deepEqual(presenceTouchFor("/api/admin/triage", "GET"), { tier: "locate", route: ROUTE_TRIAGE });
  assert.deepEqual(presenceTouchFor("/api/admin/triage/solutions", "GET"), { tier: "locate", route: ROUTE_TRIAGE });
  assert.deepEqual(presenceTouchFor("/api/admin/namespaces", "GET"), { tier: "locate", route: ROUTE_ADMIN });
  // An admin refreshing the presence panel is themselves active.
  assert.deepEqual(presenceTouchFor("/api/admin/presence", "GET"), { tier: "locate", route: ROUTE_ADMIN });
});

test("location-less user actions stamp the time but keep the last known location", () => {
  // Posting a comment carries its parent in the body, not the path — blanking last_route
  // would move the user "nowhere" mid-read.
  for (const p of ["/api/comments", "/api/likes", "/api/follows"]) {
    assert.deepEqual(presenceTouchFor(p, "POST"), { tier: "touch" }, p);
  }
  // Marking one notification read is a human act; listing them is the poll.
  assert.deepEqual(presenceTouchFor("/api/notifications/abc", "PATCH"), { tier: "touch" });
  assert.equal(presenceTouchFor("/api/notifications/abc", "GET"), null);
  // Uploading is a human act; a gateway GET may be an inline preview firing on render.
  assert.deepEqual(presenceTouchFor("/api/attachments", "POST"), { tier: "touch" });
  assert.equal(presenceTouchFor("/api/attachments/abc", "GET"), null);
});

test("entity tokens round-trip; category tokens have labels and no entity", () => {
  assert.deepEqual(parseEntityRoute("challenge:412"), { kind: "challenge", number: 412 });
  assert.deepEqual(parseEntityRoute("solution:87"), { kind: "solution", number: 87 });
  assert.equal(parseEntityRoute(ROUTE_TRIAGE), null);
  assert.equal(categoryLabel(ROUTE_TRIAGE), "Triage");
  assert.equal(categoryLabel(ROUTE_OVERVIEW), "Overview");
  assert.equal(categoryLabel("challenge:412"), null);
  assert.equal(categoryLabel(null), null);
  // Every category token the allowlist can emit must have a label, or a row renders blank.
  for (const token of [ROUTE_OVERVIEW, ROUTE_CHALLENGES, "solutions", "search", "leaderboard", "profile", ROUTE_TRIAGE, ROUTE_ADMIN]) {
    assert.ok(categoryLabel(token), `${token} needs a label`);
  }
});

test("windows and ranges fall back to the documented defaults on junk input", () => {
  assert.equal(parsePresenceWindow("8h"), "8h");
  assert.equal(parsePresenceWindow("nonsense"), DEFAULT_PRESENCE_WINDOW);
  assert.equal(parsePresenceWindow(null), DEFAULT_PRESENCE_WINDOW);
  assert.equal(DEFAULT_PRESENCE_WINDOW, "5m"); // §14.5 pins the default
  assert.equal(parsePresenceRange("90d"), "90d");
  assert.equal(parsePresenceRange(undefined), DEFAULT_PRESENCE_RANGE);

  assert.equal(windowSeconds("5m"), 300);
  assert.equal(windowSeconds("30d"), 2_592_000);
  // Windows must be strictly increasing, or the selector's order lies.
  const secs = PRESENCE_WINDOWS.map(windowSeconds);
  assert.deepEqual(secs, [...secs].sort((a, b) => a - b));
  for (const w of PRESENCE_WINDOWS) assert.ok(windowPhrase(w).length > 0);

  assert.equal(rangeDays("7d"), 7);
  assert.equal(rangeDays("all"), null);
  for (const r of PRESENCE_RANGES) assert.ok(r === "all" || typeof rangeDays(r) === "number");
});

test("relative activity copy matches the panel's pills", () => {
  const now = Date.parse("2026-07-29T12:00:00Z");
  const ago = (ms: number) => relativeActive(new Date(now - ms).toISOString(), now);
  assert.equal(ago(0), "just now");
  assert.equal(ago(59_000), "just now");
  assert.equal(ago(60_000), "1m ago");
  assert.equal(ago(48 * 60_000), "48m ago");
  assert.equal(ago(60 * 60_000), "1h ago");
  assert.equal(ago(23.9 * 60 * 60_000), "23h ago");
  assert.equal(ago(5 * 24 * 60 * 60_000), "5d ago");
  // Clock skew (a stamp in the "future") must not render a negative age.
  assert.equal(relativeActive(new Date(now + 5_000).toISOString(), now), "just now");
});

test("chart buckets are UTC days, not the viewer's local days (invariant 8)", () => {
  // 23:30 UTC on the 13th belongs to the 13th even for a viewer at UTC+3, where it is
  // already the 14th locally.
  assert.equal(utcDayKey(new Date("2026-07-13T23:30:00Z")), "2026-07-13");
  assert.equal(utcDayKey(new Date("2026-07-14T00:30:00Z")), "2026-07-14");
});
