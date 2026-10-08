// Unit tests for the client chunked-upload driver (INNOBOX_SPEC.md §11): the happy path, the
// abort-on-failure rule, and the cancel path — removing a file mid-upload cancels the in-flight
// chunk and discards the session through the abort endpoint. `fetch` is stubbed; no server.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isAbortError, uploadFileInChunks } from "./chunked-upload";

interface Call {
  url: string;
  method: string;
  signal: AbortSignal | undefined;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch: initiate answers with a 4-byte chunk size; `onPart` may intercept part PUTs. */
function stubFetch(onPart?: (partNumber: number, init: RequestInit) => Promise<Response> | Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", signal: init.signal ?? undefined });
    if (url === "/api/attachments/uploads") return Response.json({ uploadId: "u1", chunkSizeBytes: 4 });
    const part = url.match(/\/parts\/(\d+)$/);
    if (part) return onPart ? onPart(Number(part[1]), init) : new Response(null, { status: 204 });
    if (url.endsWith("/complete")) return Response.json({ attachment: { id: "a1" } });
    if (url.endsWith("/abort")) return Response.json({ ok: true });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return calls;
}

const file = () => new File([new Uint8Array(10)], "big.zip", { type: "application/zip" });

test("uploads every slice, reports cumulative progress, then completes", async () => {
  const calls = stubFetch();
  const progress: number[] = [];
  const out = await uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, (up) => progress.push(up));
  assert.deepEqual(out, { attachment: { id: "a1" } });
  assert.deepEqual(progress, [4, 8, 10]);
  assert.deepEqual(
    calls.map((c) => c.url),
    ["/api/attachments/uploads", "/api/attachments/uploads/u1/parts/1", "/api/attachments/uploads/u1/parts/2", "/api/attachments/uploads/u1/parts/3", "/api/attachments/uploads/u1/complete"],
  );
});

test("a failed chunk aborts the session and surfaces the server's error", async () => {
  const calls = stubFetch((n) => (n === 2 ? Response.json({ error: "boom" }, { status: 500 }) : new Response(null, { status: 204 })));
  await assert.rejects(uploadFileInChunks(file(), { parentType: "solution", parentId: "p" }, () => {}), /boom/);
  assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/abort");
  assert.equal(calls.some((c) => c.url.endsWith("/complete")), false);
});

test("cancelling mid-upload stops the in-flight chunk, aborts the session, and never completes", async () => {
  const controller = new AbortController();
  const calls = stubFetch((n, init) => {
    if (n === 1) return new Response(null, { status: 204 });
    // Part 2 hangs until the signal fires, then rejects the way fetch does.
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      controller.abort();
    });
  });
  const err = await uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, () => {}, controller.signal).catch((e: unknown) => e);
  assert.equal(isAbortError(err), true);
  assert.equal(calls.filter((c) => c.url.includes("/parts/")).length, 2, "no chunk is sent after the cancel");
  assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/abort");
  assert.equal(calls.at(-1)!.signal, undefined, "the abort call itself is not cancelled by the same signal");
  assert.equal(calls.some((c) => c.url.endsWith("/complete")), false);
});

test("a cancel that lands between chunks is honoured before the next chunk", async () => {
  const controller = new AbortController();
  const calls = stubFetch((n) => {
    if (n === 1) controller.abort();
    return new Response(null, { status: 204 });
  });
  const err = await uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, () => {}, controller.signal).catch((e: unknown) => e);
  assert.equal(isAbortError(err), true);
  assert.equal(calls.filter((c) => c.url.includes("/parts/")).length, 1);
  assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/abort");
});

test("an already-cancelled signal starts nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = stubFetch();
  const err = await uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, () => {}, controller.signal).catch((e: unknown) => e);
  assert.equal(isAbortError(err), true);
  assert.equal(calls.length, 0);
});

test("isAbortError: only cancellations, not ordinary failures", () => {
  assert.equal(isAbortError(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isAbortError(new Error("x")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("AbortError"), false);
});
