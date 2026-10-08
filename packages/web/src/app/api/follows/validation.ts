// Pure request-shape parsing for /api/follows (INNOBOX_SPEC.md §12.3).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function parseFollowToggle(body: unknown): Parsed<{ parentType: "challenge" | "solution"; parentId: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("request body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  if (rec.parentType !== "challenge" && rec.parentType !== "solution") {
    return fail("parentType must be 'challenge' or 'solution'");
  }
  if (typeof rec.parentId !== "string" || !UUID_RE.test(rec.parentId)) return fail("parentId must be a uuid");
  return { ok: true, value: { parentType: rec.parentType, parentId: rec.parentId } };
}
