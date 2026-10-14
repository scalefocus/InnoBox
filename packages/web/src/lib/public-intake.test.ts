// INNOBOX_SPEC.md §24.2, §24.9: the Public submissions card lists every unmet precondition, in the
// fixed key → notice → transport order, each with its hint — one, two, all three, or none — and the
// first-only `missingPrecondition` (kept for compatibility, and the 409 the switch answers) agrees
// with the head of that list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECONDITION_HINT, missingPrecondition, unmetPreconditionList, unmetPreconditions, type PublicIntakePreconditions } from "./public-intake";

const ALL_MET: PublicIntakePreconditions = { keyValid: true, noticeSet: true, transportAvailable: true };

test("none unmet → empty list, no first missing", () => {
  assert.deepEqual(unmetPreconditions(ALL_MET), []);
  assert.deepEqual(unmetPreconditionList(ALL_MET), []);
  assert.equal(missingPrecondition(ALL_MET), null);
});

test("each single precondition on its own", () => {
  assert.deepEqual(unmetPreconditions({ ...ALL_MET, keyValid: false }), ["key"]);
  assert.deepEqual(unmetPreconditions({ ...ALL_MET, noticeSet: false }), ["notice"]);
  assert.deepEqual(unmetPreconditions({ ...ALL_MET, transportAvailable: false }), ["transport"]);
});

test("two unmet → both, in order", () => {
  assert.deepEqual(unmetPreconditions({ keyValid: true, noticeSet: false, transportAvailable: false }), ["notice", "transport"]);
  assert.deepEqual(unmetPreconditions({ keyValid: false, noticeSet: true, transportAvailable: false }), ["key", "transport"]);
});

test("all three unmet → all three in key → notice → transport order, each with its hint", () => {
  const none: PublicIntakePreconditions = { keyValid: false, noticeSet: false, transportAvailable: false };
  assert.deepEqual(unmetPreconditionList(none), [
    { precondition: "key", hint: PRECONDITION_HINT.key },
    { precondition: "notice", hint: PRECONDITION_HINT.notice },
    { precondition: "transport", hint: PRECONDITION_HINT.transport },
  ]);
  assert.equal(missingPrecondition(none), "key", "the first-only answer is the head of the list");
});

test("the live-state cache: one load per 10 seconds, shared by concurrent misses, cleared on demand", async () => {
  const { createStateCache, PUBLIC_STATE_CACHE_MS } = await import("./public-intake");
  assert.equal(PUBLIC_STATE_CACHE_MS, 10_000);
  let t = 0;
  let loads = 0;
  const cache = createStateCache(async () => ++loads, PUBLIC_STATE_CACHE_MS, () => t);

  assert.deepEqual(await Promise.all([cache.get(), cache.get(), cache.get()]), [1, 1, 1]);
  assert.equal(loads, 1, "concurrent misses share one load");
  t = 9_999;
  assert.equal(await cache.get(), 1);
  t = 10_000;
  assert.equal(await cache.get(), 2, "expired after 10 seconds");
  cache.clear();
  assert.equal(await cache.get(), 3, "clear() forces the next read");
});

test("the live-state cache does not keep a failed load", async () => {
  const { createStateCache } = await import("./public-intake");
  let fail = true;
  const cache = createStateCache(async () => {
    if (fail) throw new Error("db down");
    return "ok";
  }, 10_000, () => 0);
  await assert.rejects(cache.get(), /db down/);
  fail = false;
  assert.equal(await cache.get(), "ok");
});

test("the settings card reads fresh state, and saving it clears the public routes' cache", async () => {
  const { readFileSync } = await import("node:fs");
  const card = readFileSync(new URL("../app/api/admin/settings/public-submissions.ts", import.meta.url), "utf8");
  assert.match(card, /await readPublicIntakeState\(\)/);
  const route = readFileSync(new URL("../app/api/admin/settings/route.ts", import.meta.url), "utf8");
  assert.match(route, /invalidatePublicIntakeState\(\);/);
});
