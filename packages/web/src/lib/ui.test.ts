// Hermetic unit tests for the shared client GET cache (lib/ui.ts). The module-level
// cache persists for the process, so every test uses its own unique URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedGet, invalidateApi } from "./ui";

let fetchCalls: string[] = [];

function mockFetch(handler: (url: string) => { ok: boolean; status: number; body?: unknown }) {
  (globalThis as { fetch: unknown }).fetch = async (url: string) => {
    fetchCalls.push(url);
    const r = handler(url);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  };
}

test("cachedGet fetches once and serves repeats from the cache", async () => {
  fetchCalls = [];
  mockFetch(() => ({ ok: true, status: 200, body: { value: 1 } }));
  const a = await cachedGet<{ value: number }>("/api/t-cache");
  const b = await cachedGet<{ value: number }>("/api/t-cache");
  assert.deepEqual(a, { value: 1 });
  assert.deepEqual(b, { value: 1 });
  assert.equal(fetchCalls.length, 1);
});

test("concurrent cachedGet calls for the same URL share one in-flight request", async () => {
  fetchCalls = [];
  mockFetch(() => ({ ok: true, status: 200, body: { value: 2 } }));
  const [a, b] = await Promise.all([
    cachedGet<{ value: number }>("/api/t-inflight"),
    cachedGet<{ value: number }>("/api/t-inflight"),
  ]);
  assert.deepEqual(a, b);
  assert.equal(fetchCalls.length, 1);
});

test("invalidateApi evicts the exact URL and everything under the prefix", async () => {
  fetchCalls = [];
  mockFetch(() => ({ ok: true, status: 200, body: {} }));
  await cachedGet("/api/t-inv");
  await cachedGet("/api/t-inv/child");
  await cachedGet("/api/t-other");
  invalidateApi("/api/t-inv");
  await cachedGet("/api/t-inv"); // refetched
  await cachedGet("/api/t-inv/child"); // refetched (prefix match)
  await cachedGet("/api/t-other"); // still cached
  assert.equal(fetchCalls.length, 5);
});

test("a non-OK response rejects and is not cached", async () => {
  fetchCalls = [];
  let fail = true;
  mockFetch(() => (fail ? { ok: false, status: 500 } : { ok: true, status: 200, body: { fine: true } }));
  await assert.rejects(cachedGet("/api/t-fail"), /500/);
  fail = false;
  // The failure was evicted, so this refetches and succeeds.
  const recovered = await cachedGet<{ fine: boolean }>("/api/t-fail");
  assert.deepEqual(recovered, { fine: true });
  assert.equal(fetchCalls.length, 2);
});
