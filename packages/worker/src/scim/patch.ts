// SCIM PATCH normalization (what Entra actually sends — ENTRA_AUTH_SPEC.md §5):
// turns an `Operations` array — in whichever of Entra's serializations it arrives — into a
// small, resource-agnostic set of intended changes. Never throws: an operation this server
// doesn't recognize is simply not represented in the result, so the caller can apply what it
// understands and still answer success (failing the whole PATCH quarantines Entra's sync).
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface NormalizedUserPatch {
  active?: boolean;
  displayName?: string;
  userName?: string;
  email?: string;
  jobTitle?: string;
  department?: string;
}

/** Accepts boolean `false`, and the string forms `"false"`/`"False"`/etc. (Entra's
 *  notorious boolean-as-capitalized-string quirk); anything else is not a recognized value. */
export function parseActiveValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
}

function opName(rawOp: any): string {
  return typeof rawOp?.op === "string" ? rawOp.op.toLowerCase() : "";
}

function applyUserAttr(result: NormalizedUserPatch, key: string, value: unknown): void {
  switch (key.toLowerCase()) {
    case "active": {
      const b = parseActiveValue(value);
      if (b !== undefined) result.active = b;
      return;
    }
    case "displayname":
      if (typeof value === "string") result.displayName = value;
      return;
    case "username":
      if (typeof value === "string") result.userName = value;
      return;
    case "title":
      if (typeof value === "string") result.jobTitle = value;
      return;
    case "department":
    case "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user:department":
      if (typeof value === "string") result.department = value;
      return;
    default:
      // Unknown/unsupported attribute path (e.g. name.givenName) — tolerated silently,
      // never an anomaly: provisioning.md is explicit that unknown paths must not fail.
      return;
  }
}

/** `path` may carry the enterprise-extension URN prefix, e.g.
 *  `urn:...:enterprise:2.0:User:department` — strip a trailing `:department` segment. */
function normalizeUserPath(path: string): string {
  const idx = path.lastIndexOf(":");
  if (idx === -1) return path;
  const tail = path.slice(idx + 1).toLowerCase();
  if (tail === "department" || tail === "active" || tail === "title") return tail;
  return path;
}

export function normalizeUserPatch(operations: unknown): NormalizedUserPatch {
  const result: NormalizedUserPatch = {};
  if (!Array.isArray(operations)) return result;
  for (const rawOp of operations) {
    if (!rawOp || typeof rawOp !== "object") continue;
    const op = opName(rawOp);
    if (op !== "add" && op !== "replace" && op !== "remove") continue;
    const path = typeof (rawOp as any).path === "string" ? (rawOp as any).path.trim() : undefined;
    const value = (rawOp as any).value;

    if (!path) {
      // Path-less replace: value is an object of attribute-name -> new value
      // (the {"op":"replace","value":{"active":false}} deactivation quirk).
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value)) applyUserAttr(result, k, v);
      }
      continue;
    }
    applyUserAttr(result, normalizeUserPath(path), value);
  }
  return result;
}

// ── Groups ───────────────────────────────────────────────────────────────────────────────

export interface NormalizedGroupPatch {
  displayName?: string;
  addMemberIds: string[];
  removeMemberIds: string[];
  /** `Remove`/`Replace` on the bare `members` path with no value — clear the whole roster. */
  removeAll: boolean;
}

const MEMBERS_FILTER_RE = /^members\[\s*value\s+eq\s+"([^"]*)"\s*\]$/i;

function extractMemberIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) ids.push(item);
    else if (item && typeof item === "object" && typeof (item as any).value === "string") {
      ids.push((item as any).value);
    }
  }
  return ids;
}

export function normalizeGroupPatch(operations: unknown): NormalizedGroupPatch {
  const result: NormalizedGroupPatch = { addMemberIds: [], removeMemberIds: [], removeAll: false };
  if (!Array.isArray(operations)) return result;
  for (const rawOp of operations) {
    if (!rawOp || typeof rawOp !== "object") continue;
    const op = opName(rawOp);
    if (op !== "add" && op !== "replace" && op !== "remove") continue;
    const path = typeof (rawOp as any).path === "string" ? (rawOp as any).path.trim() : undefined;
    const value = (rawOp as any).value;

    if (path) {
      const filterMatch = MEMBERS_FILTER_RE.exec(path);
      if (filterMatch) {
        // The Remove-by-filter form never carries member ids anywhere else.
        result.removeMemberIds.push(filterMatch[1]!);
        continue;
      }
      if (path.toLowerCase() === "members") {
        const ids = extractMemberIds(value);
        if (op === "add") {
          result.addMemberIds.push(...ids);
        } else if (op === "remove") {
          if (ids.length > 0) result.removeMemberIds.push(...ids);
          else result.removeAll = true;
        } else {
          // replace: full membership swap.
          result.removeAll = true;
          result.addMemberIds.push(...ids);
        }
        continue;
      }
      if (path.toLowerCase() === "displayname" && op !== "remove" && typeof value === "string") {
        result.displayName = value;
      }
      // Any other path: tolerated silently, not an anomaly.
      continue;
    }

    // Path-less replace with an attribute object.
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (typeof (value as any).displayName === "string") result.displayName = (value as any).displayName;
      if (Array.isArray((value as any).members)) {
        result.addMemberIds.push(...extractMemberIds((value as any).members));
      }
    }
  }
  return result;
}
