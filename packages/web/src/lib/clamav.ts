// Web-tier ClamAV client (INNOBOX_SPEC.md §11). The worker owns the periodic fallback sweep;
// the web tier scans ON DEMAND the moment an upload's bytes are complete, so the verdict is
// known within moments and the §6.1/§6.2 submit gate can enforce "no unclean attachments".
// A short-TTL-cached PING probe yields the `scanAvailable` signal: when clamd is unreachable
// the platform fails open (uploads stay `pending`, submission is not blocked). The wire framing
// is the pure `@innobox/shared` INSTREAM helpers (mirrors the worker's createClamavScanner, but
// web and worker are separate deployables so the ~socket wiring is not shared).
import net from "node:net";
import { CLAMD_INSTREAM_COMMAND, CLAMD_INSTREAM_TERMINATOR, frameInstreamChunk, parseClamdResponse, type ClamdVerdict } from "@innobox/shared";

function clamavConfig(): { host: string; port: number } | null {
  const host = process.env.CLAMAV_HOST;
  if (!host || host.trim() === "") return null; // not configured → scanning unavailable → fail open
  return { host, port: Number(process.env.CLAMAV_PORT ?? 3310) };
}

/** Stream bytes to clamd via INSTREAM over a TCP socket and resolve the verdict. Rejects on
 *  connect/timeout/engine errors so the caller can leave the row `pending` for the sweep. */
export function scanBytes(bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<ClamdVerdict> {
  const cfg = clamavConfig();
  if (!cfg) return Promise.reject(new Error("clamav not configured"));
  return new Promise<ClamdVerdict>((resolve, reject) => {
    const socket = net.connect({ host: cfg.host, port: cfg.port });
    let response = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.setTimeout(opts?.timeoutMs ?? 120_000);
    socket.on("connect", () => {
      socket.write(CLAMD_INSTREAM_COMMAND);
      const CHUNK = 64 * 1024;
      for (let off = 0; off < bytes.length; off += CHUNK) {
        socket.write(frameInstreamChunk(bytes.subarray(off, Math.min(off + CHUNK, bytes.length))));
      }
      socket.write(CLAMD_INSTREAM_TERMINATOR);
    });
    socket.on("data", (d) => {
      response += d.toString("utf8");
    });
    socket.on("end", () =>
      finish(() => {
        try {
          resolve(parseClamdResponse(response));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );
    socket.on("timeout", () => finish(() => reject(new Error("clamd scan timed out"))));
    socket.on("error", (err) => finish(() => reject(err)));
  });
}

/** A single clamd PING/PONG round-trip. Resolves true on a healthy PONG, false otherwise. */
function pingClamav(timeoutMs: number): Promise<boolean> {
  const cfg = clamavConfig();
  if (!cfg) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: cfg.host, port: cfg.port });
    let response = "";
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (d) => {
      response += d.toString("utf8");
      if (response.includes("PONG")) finish(true);
    });
    socket.on("end", () => finish(response.includes("PONG")));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

// Cache the probe so the per-poll submit-gate check and every upload don't each open a socket.
let probeCache: { at: number; available: boolean } | null = null;
let probeInFlight: Promise<boolean> | null = null;
const PROBE_TTL_MS = 30_000;

/** Whether attachment scanning is currently enforced: a short-TTL-cached clamd PING probe. When
 *  false (clamd unreachable or unconfigured) the platform fails open — uploads stay `pending`
 *  and submission is not blocked on the scan (§11). Never throws. */
export async function isScanAvailable(opts?: { timeoutMs?: number }): Promise<boolean> {
  if (!clamavConfig()) return false;
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.available;
  if (!probeInFlight) {
    probeInFlight = pingClamav(opts?.timeoutMs ?? 2_000).then((available) => {
      probeCache = { at: Date.now(), available };
      probeInFlight = null;
      return available;
    });
  }
  return probeInFlight;
}
