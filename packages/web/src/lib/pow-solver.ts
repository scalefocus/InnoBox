// The browser half of the §24.4 proof-of-work (INNOBOX_SPEC.md §24.4): find the n for which
// SHA-256(salt ‖ n) equals the server's challenge. Part of the /submit page's own bundle — no Web
// Worker, no `blob:` URL, no third-party script, so the CSP is unchanged — and it runs in small
// chunks that yield to the event loop, so the page stays responsive while it searches. Uses
// WebCrypto (`crypto.subtle`), which the browser (a secure context) and Node both provide.

export interface PowTask {
  salt: string;
  challenge: string;
  maxNumber: number;
}

/** Hashes per chunk before yielding to the event loop. */
const CHUNK = 250;

function hex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

/** Yield one macrotask. A MessageChannel post, not setTimeout: browsers clamp timers in background
 *  tabs to once a second (or rarer), which would stall a visitor who switches tabs while it solves. */
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** The secret number, or null when none ≤ maxNumber matches (a forged or garbled challenge) or the
 *  search was aborted. */
export async function solvePow(task: PowTask, signal?: AbortSignal): Promise<number | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const encoder = new TextEncoder();
  const target = task.challenge.toLowerCase();
  for (let n = 0; n <= task.maxNumber; n++) {
    if (n % CHUNK === 0) {
      if (signal?.aborted) return null;
      if (n > 0) await yieldToEventLoop();
    }
    const digest = await subtle.digest("SHA-256", encoder.encode(`${task.salt}${n}`));
    if (hex(digest) === target) return n;
  }
  return null;
}
