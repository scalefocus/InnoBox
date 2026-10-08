// Unit tests for the web tier's streaming scan plumbing (INNOBOX_SPEC.md §11): the on-demand scan
// streams the stored object to clamd — the ReadableStream adapter yields chunk by chunk and can be
// closed early — and the scanner frames it in ≤64 KB pieces against a fake clamd on loopback.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { ClamdErrorReply, ScanObjectReadError } from "@innobox/shared";
import { readableStreamSource, scanSource } from "./clamav";

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

test("readableStreamSource: yields the stream's chunks in order", async () => {
  const src = readableStreamSource(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]));
  const seen: number[] = [];
  for await (const c of src) seen.push(...c);
  assert.deepEqual(seen, [1, 2, 3]);
});

test("readableStreamSource: destroy() before reading cancels the underlying stream (no leaked connection)", async () => {
  let cancelled = false;
  const src = readableStreamSource(streamOf([new Uint8Array([1])], () => (cancelled = true)));
  src.destroy();
  src.destroy(); // idempotent
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, true);
  const seen: Uint8Array[] = [];
  for await (const c of src) seen.push(c);
  assert.deepEqual(seen, [], "a destroyed source yields nothing");
});

test("readableStreamSource: breaking out early cancels the stream; reading to the end does not", async () => {
  let cancelled = 0;
  const early = readableStreamSource(streamOf([new Uint8Array([1]), new Uint8Array([2])], () => (cancelled += 1)));
  for await (const _ of early) break;
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelled, 1);

  let cancelledFull = 0;
  const full = readableStreamSource(streamOf([new Uint8Array([1])], () => (cancelledFull += 1)));
  for await (const _ of full) {
    // read everything
  }
  full.destroy();
  await new Promise((r) => setImmediate(r));
  assert.equal(cancelledFull, 0, "a fully-read stream is not cancelled");
});

/** A minimal clamd on loopback: records frame sizes, replies after the terminator (or early, once
 *  `replyAfterBytes` payload bytes arrived — clamd's StreamMaxLength behaviour), then closes. */
async function startFakeClamd(opts: { reply: string; replyAfterBytes?: number }) {
  const frames: number[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let commandSeen = false;
    let total = 0;
    let replied = false;
    const reply = (): void => {
      if (replied) return;
      replied = true;
      sock.end(`stream: ${opts.reply}\0`);
    };
    sock.on("error", () => {});
    sock.on("close", () => sockets.delete(sock));
    sock.on("data", (d: Buffer) => {
      if (replied) return;
      buf = Buffer.concat([buf, d]);
      if (!commandSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        buf = buf.subarray(nul + 1);
        commandSeen = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) return reply();
        if (buf.length < 4 + len) return;
        frames.push(len);
        total += len;
        buf = buf.subarray(4 + len);
        if (opts.replyAfterBytes !== undefined && total >= opts.replyAfterBytes) return reply();
      }
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as net.AddressInfo).port;
  const close = (): Promise<void> => {
    for (const s of sockets) s.destroy();
    return new Promise<void>((ok) => server.close(() => ok()));
  };
  return { port, frames, close };
}

async function withClamd<T>(opts: { reply: string; replyAfterBytes?: number }, fn: (frames: number[]) => Promise<T>): Promise<T> {
  const clamd = await startFakeClamd(opts);
  const prev = { host: process.env.CLAMAV_HOST, port: process.env.CLAMAV_PORT };
  process.env.CLAMAV_HOST = "127.0.0.1";
  process.env.CLAMAV_PORT = String(clamd.port);
  try {
    return await fn(clamd.frames);
  } finally {
    if (prev.host === undefined) delete process.env.CLAMAV_HOST;
    else process.env.CLAMAV_HOST = prev.host;
    if (prev.port === undefined) delete process.env.CLAMAV_PORT;
    else process.env.CLAMAV_PORT = prev.port;
    await clamd.close();
  }
}

test("scanSource: streams an object-store stream to clamd in frames of at most 64 KB", async () => {
  await withClamd({ reply: "OK" }, async (frames) => {
    const src = readableStreamSource(streamOf([new Uint8Array(100 * 1024), new Uint8Array(10)]));
    assert.deepEqual(await scanSource(src, { timeoutMs: 5_000 }), { clean: true });
    assert.deepEqual(frames, [64 * 1024, 36 * 1024, 10]);
  });
});

test("scanSource: in-memory bytes (single-shot upload) still scan", async () => {
  await withClamd({ reply: "Eicar-Test-Signature FOUND" }, async () => {
    assert.deepEqual(await scanSource(new Uint8Array(5), { timeoutMs: 5_000 }), { clean: false, signature: "Eicar-Test-Signature" });
  });
});

test("scanSource: an early size-limit reply is a per-file error, and the stream is cancelled", async () => {
  await withClamd({ reply: "INSTREAM size limit exceeded. ERROR", replyAfterBytes: 128 * 1024 }, async () => {
    let cancelled = false;
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > 10_000) controller.error(new Error("read far past the reply"));
        else controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(scanSource(readableStreamSource(endless), { timeoutMs: 5_000 }), (err: unknown) => err instanceof ClamdErrorReply);
    for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(cancelled, true, "the object stream is not read to the end once clamd has answered");
  });
});

test("scanSource: a stream that errors mid-read rejects with ScanObjectReadError", async () => {
  await withClamd({ reply: "OK" }, async () => {
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(10));
        } else controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
      },
    });
    await assert.rejects(scanSource(readableStreamSource(broken), { timeoutMs: 5_000 }), (err: unknown) => err instanceof ScanObjectReadError);
  });
});
