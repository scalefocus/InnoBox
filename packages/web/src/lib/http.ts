// Request-body helpers for the §2.4 web security baseline (INNOBOX_SPEC.md): every body is
// size-capped BEFORE it is buffered (Content-Length first, then a running byte count for
// bodies that arrive without one), JSON endpoints require `application/json`, and a body
// that is not a JSON object is a 400 — never a 500 from `(body as Record).x` on `null`.

/** §2.4: the cap on any JSON request body. */
export const JSON_BODY_MAX_BYTES = 1024 * 1024;

/** §2.4: multipart framing allowance on top of the file itself for single-shot uploads. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export type BodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

function tooLarge(): BodyResult<never> {
  return { ok: false, response: Response.json({ error: "request body is too large" }, { status: 413 }) };
}

/** True when the declared Content-Length already exceeds `maxBytes`. An absent or malformed
 *  header is not a rejection — the running count in `readBytesLimited` catches those. */
export function declaredLengthExceeds(req: Request, maxBytes: number): boolean {
  const raw = req.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return false;
  return Number(raw) > maxBytes;
}

/** Read the raw body, refusing (413) once more than `maxBytes` have arrived — the body is
 *  never buffered past the cap, whatever Content-Length claimed. */
export async function readBytesLimited(req: Request, maxBytes: number): Promise<BodyResult<Uint8Array>> {
  if (declaredLengthExceeds(req, maxBytes)) return tooLarge();
  if (!req.body) return { ok: true, value: new Uint8Array(0) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, value: out };
}

/** True when the request declares a JSON body (`application/json`, any parameters). */
export function isJsonContentType(req: Request): boolean {
  const ct = req.headers.get("content-type");
  if (!ct) return false;
  return ct.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** Read a JSON-object body for a state-changing endpoint: 415 unless `application/json`,
 *  413 over `maxBytes`, 400 unless it parses to a plain object (not null/array/scalar). */
export async function readJsonObject(
  req: Request,
  maxBytes: number = JSON_BODY_MAX_BYTES,
): Promise<BodyResult<Record<string, unknown>>> {
  if (!isJsonContentType(req)) {
    return { ok: false, response: Response.json({ error: "request body must be application/json" }, { status: 415 }) };
  }
  const bytes = await readBytesLimited(req, maxBytes);
  if (!bytes.ok) return bytes;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes.value));
  } catch {
    return { ok: false, response: Response.json({ error: "request body must be valid JSON" }, { status: 400 }) };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: Response.json({ error: "request body must be a JSON object" }, { status: 400 }) };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
