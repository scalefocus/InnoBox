// Unit tests for the client chunked-upload driver (INNOBOX_SPEC.md §11): the happy path, the
// per-part retry rule (network error / 5xx / 429 retried up to 3 attempts with a 1 s then 2 s
// wait; any other 4xx final), the abort once a part is out of attempts, and the cancel path —
// cancelling mid-upload stops the in-flight chunk (or a retry wait) and discards the session
// through the abort endpoint. `fetch` and the retry wait are stubbed; no server, no sleeping.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isAbortError, isRetryablePartStatus, PART_MAX_ATTEMPTS, PART_RETRY_DELAYS_MS, uploadFileInChunks } from "./chunked-upload";

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

/** A recording stand-in for the retry wait: no sleeping, just the requested delays. */
function recordWaits(): { waits: number[]; wait: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return { waits, wait: async (ms) => void waits.push(ms) };
}

const partCalls = (calls: Call[], n: number) => calls.filter((c) => c.url.endsWith(`/parts/${n}`)).length;

test("retry classification: 5xx and 429 are transient; every other status is final", () => {
  for (const status of [429, 500, 502, 503, 504, 599]) assert.equal(isRetryablePartStatus(status), true, `${status} is retried`);
  for (const status of [200, 204, 400, 401, 403, 404, 409, 413, 415, 422, 499, 600]) assert.equal(isRetryablePartStatus(status), false, `${status} is not`);
  assert.equal(PART_MAX_ATTEMPTS, 3);
  assert.deepEqual(PART_RETRY_DELAYS_MS, [1000, 2000]);
});

test("a part that fails transiently is retried and the upload completes", async () => {
  let failures = 0;
  const calls = stubFetch((n) => {
    if (n === 2 && failures < 2) {
      failures += 1;
      return failures === 1 ? Response.json({ error: "busy" }, { status: 503 }) : Response.json({ error: "slow down" }, { status: 429 });
    }
    return new Response(null, { status: 204 });
  });
  const { waits, wait } = recordWaits();
  const progress: number[] = [];
  const out = await uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, (up) => progress.push(up), undefined, { wait });
  assert.deepEqual(out, { attachment: { id: "a1" } });
  assert.equal(partCalls(calls, 2), 3, "part 2 took three attempts");
  assert.deepEqual(waits, [1000, 2000], "1 s before the second attempt, 2 s before the third");
  assert.deepEqual(progress, [4, 8, 10], "progress advances once per part, not per attempt");
  assert.equal(calls.some((c) => c.url.endsWith("/abort")), false, "a recovered part never aborts the session");
});

test("a network error is retried like a 5xx", async () => {
  let thrown = false;
  const calls = stubFetch((n) => {
    if (n === 1 && !thrown) {
      thrown = true;
      throw new TypeError("Failed to fetch");
    }
    return new Response(null, { status: 204 });
  });
  const { waits, wait } = recordWaits();
  await uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, () => {}, undefined, { wait });
  assert.equal(partCalls(calls, 1), 2);
  assert.deepEqual(waits, [1000]);
  assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/complete");
});

test("a part still failing after 3 attempts aborts the session and surfaces the last error", async () => {
  const calls = stubFetch((n) => (n === 2 ? Response.json({ error: "boom" }, { status: 500 }) : new Response(null, { status: 204 })));
  const { waits, wait } = recordWaits();
  await assert.rejects(uploadFileInChunks(file(), { parentType: "solution", parentId: "p" }, () => {}, undefined, { wait }), /boom/);
  assert.equal(partCalls(calls, 2), PART_MAX_ATTEMPTS);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(partCalls(calls, 3), 0, "no later part is sent");
  assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/abort");
  assert.equal(calls.some((c) => c.url.endsWith("/complete")), false);
});

test("a network error on every attempt aborts with that error", async () => {
  const calls = stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const { wait } = recordWaits();
  await assert.rejects(uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, () => {}, undefined, { wait }), /Failed to fetch/);
  assert.equal(partCalls(calls, 1), PART_MAX_ATTEMPTS);
  assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/abort");
});

test("any other 4xx is final: no retry, the session is aborted at once", async () => {
  for (const status of [400, 404, 415]) {
    const calls = stubFetch((n) => (n === 1 ? Response.json({ error: `refused ${status}` }, { status }) : new Response(null, { status: 204 })));
    const { waits, wait } = recordWaits();
    await assert.rejects(uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, () => {}, undefined, { wait }), new RegExp(`refused ${status}`));
    assert.equal(partCalls(calls, 1), 1, `${status} is not retried`);
    assert.deepEqual(waits, []);
    assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/abort");
  }
});

test("a cancel during the wait before a retry stops the retry and aborts the session", async () => {
  const controller = new AbortController();
  const calls = stubFetch((n) => {
    if (n !== 1) return new Response(null, { status: 204 });
    // Part 1 fails transiently; the user cancels just after, while the driver waits to retry.
    setTimeout(() => controller.abort(), 0);
    return Response.json({ error: "busy" }, { status: 503 });
  });
  const started = Date.now();
  // The default (real) 1 s wait is used here: it must give up the moment the signal fires.
  const err = await uploadFileInChunks(file(), { parentType: "challenge", draftKey: "k" }, () => {}, controller.signal).catch((e: unknown) => e);
  assert.equal(isAbortError(err), true);
  assert.ok(Date.now() - started < PART_RETRY_DELAYS_MS[0]!, "the cancel cuts the retry wait short");
  assert.equal(partCalls(calls, 1), 1, "nothing is retried after a cancel");
  assert.equal(calls.at(-1)!.url, "/api/attachments/uploads/u1/abort");
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
