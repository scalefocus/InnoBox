// Unit tests for the streaming INSTREAM framing (INNOBOX_SPEC.md §11: both scan paths stream the
// object from the store to clamd and never hold the whole file in memory).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAMD_INSTREAM_CHUNK_BYTES, instreamFrames, ScanObjectReadError } from "./attachments.js";

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

/** Strip the 4-byte length prefixes and concatenate the payloads. */
function unframe(frames: Uint8Array[]): number[] {
  const out: number[] = [];
  for (const f of frames) {
    const len = new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(0, false);
    assert.equal(len, f.length - 4, "each frame's prefix matches its payload");
    out.push(...f.subarray(4));
  }
  return out;
}

test("instreamFrames: an in-memory buffer is split into frames of at most the chunk size", async () => {
  const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
  const frames = await collect(instreamFrames(bytes, 4));
  assert.deepEqual(frames.map((f) => f.length - 4), [4, 4, 2]);
  assert.deepEqual(unframe(frames), Array.from(bytes));
  assert.equal(CLAMD_INSTREAM_CHUNK_BYTES, 64 * 1024, "the default chunk size");
});

test("instreamFrames: a stream's chunks are re-split to the chunk size and never accumulated", async () => {
  async function* source() {
    yield new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    yield new Uint8Array([8]);
    yield new Uint8Array([]);
    yield new Uint8Array([9, 10]);
  }
  const frames = await collect(instreamFrames(source(), 3));
  assert.deepEqual(frames.map((f) => f.length - 4), [3, 3, 1, 1, 2], "no frame exceeds the chunk size; small chunks are not merged");
  assert.deepEqual(unframe(frames), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("instreamFrames: an empty source yields no frames", async () => {
  assert.deepEqual(await collect(instreamFrames(new Uint8Array(0))), []);
  async function* empty() {}
  assert.deepEqual(await collect(instreamFrames(empty())), []);
});

test("instreamFrames: a source read failure surfaces as ScanObjectReadError carrying the store error", async () => {
  const storeErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  async function* source() {
    yield new Uint8Array([1]);
    throw storeErr;
  }
  await assert.rejects(collect(instreamFrames(source())), (err: unknown) => {
    assert.ok(err instanceof ScanObjectReadError);
    assert.equal((err as ScanObjectReadError).storeError, storeErr);
    return true;
  });
});

test("instreamFrames: stopping early (clamd already answered) closes the source stream", async () => {
  let closed = false;
  let pulled = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          pulled += 1;
          return { done: false, value: new Uint8Array([pulled]) };
        },
        return: async () => {
          closed = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  for await (const frame of instreamFrames(source)) {
    assert.ok(frame.length > 4);
    if (pulled >= 2) break;
  }
  assert.equal(closed, true, "the endless source was closed instead of read to the end");
  assert.equal(pulled, 2);
});

test("instreamFrames: a source read to the end is not closed a second time", async () => {
  let returns = 0;
  const chunks = [new Uint8Array([1]), new Uint8Array([2])];
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          const value = chunks.shift();
          return value ? { done: false, value } : { done: true, value: undefined };
        },
        return: async () => {
          returns += 1;
          return { done: true, value: undefined };
        },
      };
    },
  };
  assert.deepEqual(unframe(await collect(instreamFrames(source))), [1, 2]);
  assert.equal(returns, 0);
});
