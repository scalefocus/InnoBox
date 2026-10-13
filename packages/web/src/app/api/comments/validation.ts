// Pure request-shape parsing for /api/comments (INNOBOX_SPEC.md §10.2). Body-length
// validation lives in @innobox/shared's validateCommentBody; this handles ids/parent shape.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function parseParentQuery(params: URLSearchParams): Parsed<{ parentType: "challenge" | "solution"; parentId: string }> {
  const parentType = params.get("parentType");
  const parentId = params.get("parentId");
  if (parentType !== "challenge" && parentType !== "solution") {
    return fail("parentType must be 'challenge' or 'solution'");
  }
  if (typeof parentId !== "string" || !isUuid(parentId)) return fail("parentId must be a uuid");
  return { ok: true, value: { parentType, parentId } };
}

/**
 * `replyTo` (§10.2) is optional; when present it must be a string. Whether it names a real comment
 * on this item is the store's question (422), not the request shape's.
 */
export function parseCommentCreate(
  body: unknown,
): Parsed<{ parentType: "challenge" | "solution"; parentId: string; body: unknown; replyTo: string | null }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("request body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  if (rec.parentType !== "challenge" && rec.parentType !== "solution") {
    return fail("parentType must be 'challenge' or 'solution'");
  }
  if (typeof rec.parentId !== "string" || !isUuid(rec.parentId)) return fail("parentId must be a uuid");
  if (rec.replyTo !== undefined && rec.replyTo !== null && typeof rec.replyTo !== "string") return fail("replyTo must be a comment id");
  const replyTo = typeof rec.replyTo === "string" ? rec.replyTo : null;
  return { ok: true, value: { parentType: rec.parentType, parentId: rec.parentId, body: rec.body, replyTo } };
}
