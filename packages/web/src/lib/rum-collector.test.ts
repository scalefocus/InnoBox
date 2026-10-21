// §14.12 collector engine (INNOBOX_SPEC.md): the per-tab session and its single sampling draw,
// which requests count as the page's work, how calls end, the view buffer (the held hard-load
// view, attribution to the starting view, the per-view error cap, the batch caps) and the flush
// clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUM_MAX_BEACON_BYTES, RUM_MAX_VIEWS_PER_BEACON } from "@innobox/shared/rum";
import {
  FlushClock,
  RUM_SESSION_KEY,
  RumBuffer,
  apiOutcomeOfStatus,
  apiOutcomeOfThrow,
  isTrackedApiCall,
  loadOrStartSession,
  type SessionStore,
} from "./rum-collector";

const ORIGIN = "https://innobox.example.test";
const DAY = "2026-10-21";

function memoryStore(): SessionStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

test("the session is drawn once per tab and honoured on reload, whatever the rate does later", () => {
  const store = memoryStore();
  let draws = 0;
  const random = () => {
    draws++;
    return 0.5;
  };
  const first = loadOrStartSession(store, 100, random, () => "11111111-aaaa");
  assert.deepEqual(first, { sid: "11111111-aaaa", sampled: true });
  assert.ok(store.data.has(RUM_SESSION_KEY));
  // A reload at a 1 % rate keeps the decision and the id; no second draw.
  const reload = loadOrStartSession(store, 1, random, () => "22222222-bbbb");
  assert.deepEqual(reload, first);
  assert.equal(draws, 1);
  // An unsampled session stays unsampled.
  const other = memoryStore();
  assert.equal(loadOrStartSession(other, 10, () => 0.5, () => "33333333-cccc").sampled, false);
  assert.equal(loadOrStartSession(other, 100, () => 0, () => "x").sampled, false);
  // No storage: a page-only session, still valid.
  assert.equal(loadOrStartSession(null, 100, () => 0, () => "44444444-dddd").sid, "44444444-dddd");
  // A corrupt entry starts afresh.
  const corrupt = memoryStore();
  corrupt.data.set(RUM_SESSION_KEY, "{not json");
  assert.equal(loadOrStartSession(corrupt, 100, () => 0, () => "55555555-eeee").sid, "55555555-eeee");
});

test("only the page's own /api work is tracked — never pollers, the beacon or auth", () => {
  assert.equal(isTrackedApiCall("/api/challenges?page=2", "GET", ORIGIN), true);
  assert.equal(isTrackedApiCall(`${ORIGIN}/api/comments`, "POST", ORIGIN), true);
  assert.equal(isTrackedApiCall("https://elsewhere.test/api/x", "GET", ORIGIN), false);
  assert.equal(isTrackedApiCall("/_next/data/x.json", "GET", ORIGIN), false);
  assert.equal(isTrackedApiCall("/api/rum", "POST", ORIGIN), false);
  assert.equal(isTrackedApiCall("/api/auth/session", "GET", ORIGIN), false);
  assert.equal(isTrackedApiCall("/api/me/pulse", "GET", ORIGIN), false, "the shell's 30-second pulse");
  assert.equal(isTrackedApiCall("/api/notifications", "GET", ORIGIN), true, "opening the bell's list is a person");
  assert.equal(isTrackedApiCall("/api/notifications", "PATCH", ORIGIN), true, "marking read is a person");
  assert.equal(isTrackedApiCall("/api/admin/triage/attention", "GET", ORIGIN), false);
  assert.equal(isTrackedApiCall("/api/challenges/new-count", "GET", ORIGIN), false);
});

test("how a call ends: 5xx, network failure and timeouts are errors; a cancel is nothing", () => {
  assert.equal(apiOutcomeOfStatus(200), "ok");
  assert.equal(apiOutcomeOfStatus(422), "ok", "a 4xx is the app saying no");
  assert.equal(apiOutcomeOfStatus(503), "error");
  assert.equal(apiOutcomeOfThrow(new TypeError("Failed to fetch")), "error");
  assert.equal(apiOutcomeOfThrow(new DOMException("timed out", "TimeoutError")), "error");
  assert.equal(apiOutcomeOfThrow(new DOMException("aborted", "AbortError")), "cancelled");
});

test("the hard-load view waits for the hide; soft views go on the next tick", () => {
  const buffer = new RumBuffer("sid-12345678");
  buffer.startView("/", DAY, true, 640);
  buffer.hardMetrics.lcp = 1800;
  buffer.hardMetrics.ttfb = 120;
  buffer.startView("/challenges", DAY, false);
  buffer.startView("/challenges/[number]", DAY, false);

  const tick = buffer.takeBatch(false)!;
  assert.deepEqual(
    tick.views.map((v) => v.route),
    ["/challenges"],
    "the hard load is held and the current view is still open",
  );
  assert.equal(buffer.takeBatch(false), null, "nothing left for a regular tick");

  buffer.hardMetrics.cls = 0.04; // CLS settles later — the hide carries the final value
  const hide = buffer.takeBatch(true)!;
  const wire = JSON.parse(hide.body) as { sid: string; views: { route: string; hard: boolean; lcp: number | null; cls: number | null; ttfb: number | null; nav: number | null }[] };
  assert.equal(wire.sid, "sid-12345678");
  assert.deepEqual(
    wire.views.map((v) => [v.route, v.hard, v.lcp, v.cls, v.ttfb, v.nav]),
    [
      ["/", true, 1800, 0.04, 120, 640],
      ["/challenges/[number]", false, null, null, null, null],
    ],
  );
  // The open view went out on the hide; ending it later does not send it twice.
  buffer.startView("/search", DAY, false);
  const after = buffer.takeBatch(false);
  assert.equal(after, null);
});

test("calls land on the view they started in, even after it ended; cancels are not counted", () => {
  const buffer = new RumBuffer("sid-12345678");
  const first = buffer.startView("/challenges", DAY, false);
  buffer.recordApi(first, 120.4, "ok");
  buffer.startView("/search", DAY, false); // the first view ended…
  buffer.recordApi(first, 900, "error"); // …and its slow call finished afterwards
  buffer.recordApi(first, 50, "cancelled");
  buffer.recordInteraction(7, 80);
  buffer.recordInteraction(7, 260); // the same interaction's longest event wins
  buffer.recordInteraction(8, 40);
  const batch = buffer.takeBatch(true)!;
  const views = (JSON.parse(batch.body) as { views: { route: string; api: number[]; calls: number; apiErrors: number; inp: number | null }[] }).views;
  assert.deepEqual(views[0], { ...views[0], route: "/challenges", api: [120, 900], calls: 2, apiErrors: 1, inp: null });
  assert.equal(views[1]!.route, "/search");
  assert.equal(views[1]!.inp, 260);
});

test("errors are counted always and described up to 10 per view, tagged with the view's route", () => {
  const buffer = new RumBuffer("sid-12345678");
  buffer.startView("/admin", DAY, false);
  for (let i = 0; i < 14; i++) buffer.recordError({ message: `boom ${i}`, source: "/_next/a.js:1", frame: "" });
  buffer.startView("/", DAY, false);
  const batch = buffer.takeBatch(false)!;
  assert.equal(batch.errors.length, 10);
  assert.ok(batch.errors.every((e) => e.route === "/admin"));
  const wire = JSON.parse(batch.body) as { views: { errors: number }[] };
  assert.equal(wire.views[0]!.errors, 14);
});

test("a batch holds at most 50 views and stays under 64 KB; the rest wait", () => {
  const buffer = new RumBuffer("sid-12345678");
  for (let i = 0; i < 70; i++) {
    const view = buffer.startView("/challenges/[number]", DAY, false);
    for (let c = 0; c < 50; c++) buffer.recordApi(view, 100000 + c, "ok");
  }
  buffer.startView("/", DAY, false);
  const first = buffer.takeBatch(false)!;
  assert.ok(first.views.length <= RUM_MAX_VIEWS_PER_BEACON);
  assert.ok(new TextEncoder().encode(first.body).length <= RUM_MAX_BEACON_BYTES);
  let sent = first.views.length;
  for (let b = buffer.takeBatch(false); b; b = buffer.takeBatch(false)) sent += b.views.length;
  assert.equal(sent, 70, "every completed view goes out, over several beacons");
});

test("a batch that could not be sent goes back to the front of the queue", () => {
  const buffer = new RumBuffer("sid-12345678");
  buffer.startView("/challenges", DAY, false);
  buffer.recordError({ message: "x", source: "/a.js:1", frame: "" });
  buffer.startView("/search", DAY, false);
  const batch = buffer.takeBatch(false)!;
  buffer.requeue(batch);
  const again = buffer.takeBatch(false)!;
  assert.deepEqual(
    again.views.map((v) => v.route),
    ["/challenges"],
  );
  assert.equal(again.errors.length, 1);
});

test("the flush clock walks 17 → 157 s while idle and resets after a send", () => {
  const clock = new FlushClock();
  const seen: number[] = [clock.delayMs / 1000];
  for (let i = 0; i < 6; i++) {
    clock.after(false);
    seen.push(clock.delayMs / 1000);
  }
  assert.deepEqual(seen, [17, 23, 37, 59, 97, 157, 157]);
  clock.after(true);
  assert.equal(clock.delayMs, 17_000);
});
