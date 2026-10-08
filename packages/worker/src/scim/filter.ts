// SCIM filter parsing (ENTRA_AUTH_SPEC.md §5, "Filtering and
// pagination"): Entra only ever sends single `attr eq "value"` filters, and the GET-filter
// call is how it probes existence before every POST — precise support here, not a general
// RFC 7644 filter grammar. Attribute names are matched case-insensitively (Entra's own
// casing of UPN-derived attributes is not stable); the quoted value is compared exactly by
// the caller, who decides case-sensitivity per attribute (userName: case-insensitive).
export type FilterAttr = "username" | "externalid" | "displayname";

export interface ParsedFilter {
  attr: FilterAttr;
  value: string;
}

/** Thrown for anything outside the supported `attr eq "value"` shape — callers translate
 *  this into a 400 `invalidFilter` SCIM error rather than ever 500ing on a bad filter. */
export class InvalidFilterError extends Error {}

const FILTER_RE = /^\s*([A-Za-z][A-Za-z0-9_.:]*)\s+eq\s+"([^"]*)"\s*$/i;

const KNOWN_ATTRS: Record<string, FilterAttr> = {
  username: "username",
  externalid: "externalid",
  displayname: "displayname",
};

/** Parses a raw `?filter=` query value. Returns null when no filter was supplied (list-all
 *  semantics) and throws InvalidFilterError for anything unsupported — including a
 *  syntactically valid filter on an attribute this server doesn't index. */
export function parseFilter(raw: string | undefined | null): ParsedFilter | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const m = FILTER_RE.exec(raw);
  if (!m) throw new InvalidFilterError(`unsupported filter syntax: ${raw}`);
  const attr = KNOWN_ATTRS[m[1]!.toLowerCase()];
  if (!attr) throw new InvalidFilterError(`unsupported filter attribute: ${m[1]}`);
  return { attr, value: m[2]! };
}

/** Narrows a parsed filter to the attributes a given resource type actually supports
 *  (e.g. Users never filter on displayName). Anything else is still an invalidFilter. */
export function requireAttr(parsed: ParsedFilter, allowed: readonly FilterAttr[]): void {
  if (!allowed.includes(parsed.attr)) {
    throw new InvalidFilterError(`filter attribute not supported on this resource: ${parsed.attr}`);
  }
}
