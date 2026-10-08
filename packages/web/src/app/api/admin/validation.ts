// Request validation for the /api/admin routes (ENTRA_AUTH_SPEC.md §5 layer 3). Pure and
// dependency-free so the admin page can share the role vocabulary and the unit suite stays
// hermetic. Parsers return { ok: false, error } for the routes' 400 responses — never throw.

export const ROLES = ["platform_admin", "namespace_admin", "committee", "member"] as const;
export type Role = (typeof ROLES)[number];

const SLUG_RE = /^[a-z0-9-]{2,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISPLAY_NAME_MAX = 120;
const GROUP_ID_MAX = 200;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function parseDisplayName(value: unknown): Parsed<string> {
  if (typeof value !== "string" || value.trim() === "") {
    return fail("displayName must be a non-empty string");
  }
  const trimmed = value.trim();
  if (trimmed.length > DISPLAY_NAME_MAX) {
    return fail(`displayName must be at most ${DISPLAY_NAME_MAX} characters`);
  }
  return { ok: true, value: trimmed };
}

export function parseNamespaceCreate(body: unknown): Parsed<{ slug: string; displayName: string }> {
  const rec = asRecord(body);
  if (!rec) return fail("request body must be a JSON object");
  if (typeof rec.slug !== "string" || !SLUG_RE.test(rec.slug)) {
    return fail("slug must be 2-40 lowercase characters (a-z, 0-9, -)");
  }
  const name = parseDisplayName(rec.displayName);
  if (!name.ok) return name;
  return { ok: true, value: { slug: rec.slug, displayName: name.value } };
}

export function parseNamespacePatch(body: unknown): Parsed<{ displayName?: string; archived?: boolean }> {
  const rec = asRecord(body);
  if (!rec) return fail("request body must be a JSON object");
  const value: { displayName?: string; archived?: boolean } = {};
  if (rec.displayName !== undefined) {
    const name = parseDisplayName(rec.displayName);
    if (!name.ok) return name;
    value.displayName = name.value;
  }
  if (rec.archived !== undefined) {
    if (typeof rec.archived !== "boolean") return fail("archived must be a boolean");
    value.archived = rec.archived;
  }
  if (value.displayName === undefined && value.archived === undefined) {
    return fail("nothing to change: provide displayName and/or archived");
  }
  return { ok: true, value };
}

export function parseRoleMappingCreate(
  body: unknown,
): Parsed<{ groupExternalId: string; role: Role; namespaceId: string | null }> {
  const rec = asRecord(body);
  if (!rec) return fail("request body must be a JSON object");
  if (typeof rec.groupExternalId !== "string" || rec.groupExternalId.trim() === "") {
    return fail("groupExternalId must be a non-empty string (the Entra group object id)");
  }
  const groupExternalId = rec.groupExternalId.trim();
  if (groupExternalId.length > GROUP_ID_MAX) {
    return fail(`groupExternalId must be at most ${GROUP_ID_MAX} characters`);
  }
  const role = rec.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
    return fail(`role must be one of: ${ROLES.join(", ")}`);
  }
  const namespaceId = rec.namespaceId ?? null;
  if (namespaceId !== null && (typeof namespaceId !== "string" || !isUuid(namespaceId))) {
    return fail("namespaceId must be a namespace id (uuid) or null");
  }
  // Mirror of the DB CHECK ((role='platform_admin') = (namespace_id IS NULL)), as a friendly 400.
  if ((role === "platform_admin") !== (namespaceId === null)) {
    return role === "platform_admin"
      ? fail("platform_admin is platform-scoped: namespaceId must be null")
      : fail(`${role} is namespace-scoped: namespaceId is required`);
  }
  return { ok: true, value: { groupExternalId, role: role as Role, namespaceId } };
}
