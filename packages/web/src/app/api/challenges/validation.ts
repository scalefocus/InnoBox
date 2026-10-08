// Pure request-shape parsing for /api/challenges (INNOBOX_SPEC.md §13.1). Field-level
// semantic validation (title/description length, clientName<->Client pairing) lives in
// @innobox/shared's validateChallengeFields/validateSolutionFields, called from store.ts
// where the impact-area lookup it needs is available. This module only handles the bits
// that don't need a DB round-trip: list filters and id-shaped fields.
import { CHALLENGE_STATUSES, type ChallengeStatus } from "@innobox/shared";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export const CHALLENGE_TABS = ["open", "mine", "completed"] as const;
export type ChallengeTab = (typeof CHALLENGE_TABS)[number];

export const CHALLENGE_SORTS = ["newest", "most_liked", "most_solutions"] as const;
export type ChallengeSort = (typeof CHALLENGE_SORTS)[number];

export interface ChallengeListFilters {
  tab: ChallengeTab;
  status?: ChallengeStatus;
  impactAreaId?: string;
  namespaceId?: string;
  authorName?: string;
  sort: ChallengeSort;
}

/** Parses the /api/challenges GET query string. Unknown/malformed values fail closed
 *  with a 400 rather than silently falling back, so a typo'd filter is never mistaken
 *  for "no filter" (which would return a broader, unintended result set). */
export function parseChallengeListFilters(params: URLSearchParams): Parsed<ChallengeListFilters> {
  const tabRaw = params.get("tab") ?? "open";
  if (!(CHALLENGE_TABS as readonly string[]).includes(tabRaw)) {
    return fail(`tab must be one of: ${CHALLENGE_TABS.join(", ")}`);
  }
  const sortRaw = params.get("sort") ?? "newest";
  if (!(CHALLENGE_SORTS as readonly string[]).includes(sortRaw)) {
    return fail(`sort must be one of: ${CHALLENGE_SORTS.join(", ")}`);
  }

  const value: ChallengeListFilters = { tab: tabRaw as ChallengeTab, sort: sortRaw as ChallengeSort };

  const status = params.get("status");
  if (status !== null) {
    if (!(CHALLENGE_STATUSES as readonly string[]).includes(status)) {
      return fail(`status must be one of: ${CHALLENGE_STATUSES.join(", ")}`);
    }
    value.status = status as ChallengeStatus;
  }

  const impactAreaId = params.get("impactAreaId");
  if (impactAreaId !== null) {
    if (!isUuid(impactAreaId)) return fail("impactAreaId must be a uuid");
    value.impactAreaId = impactAreaId;
  }

  const namespaceId = params.get("namespaceId");
  if (namespaceId !== null) {
    if (!isUuid(namespaceId)) return fail("namespaceId must be a uuid");
    value.namespaceId = namespaceId;
  }

  const authorName = params.get("authorName");
  if (authorName !== null && authorName.trim() !== "") {
    value.authorName = authorName.trim();
  }

  return { ok: true, value };
}

export interface RawChallengeCreate {
  title: unknown;
  description: unknown;
  impactAreaId: string;
  clientName: unknown;
  namespaceId: string;
  visibility: unknown;
  isAnonymous: unknown;
}

/** Extracts and shape-checks the two id fields; everything else passes through
 *  unvalidated to @innobox/shared's validateChallengeFields in the store layer. */
export function parseChallengeCreateIds(body: unknown): Parsed<{ impactAreaId: string; namespaceId: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("request body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.impactAreaId !== "string" || !isUuid(rec.impactAreaId)) {
    return fail("impactAreaId must be a uuid");
  }
  if (typeof rec.namespaceId !== "string" || !isUuid(rec.namespaceId)) {
    return fail("namespaceId must be a uuid");
  }
  return { ok: true, value: { impactAreaId: rec.impactAreaId, namespaceId: rec.namespaceId } };
}

export function parseStatusOverride(body: unknown, isValid: (s: string) => boolean): Parsed<string> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("request body must be a JSON object");
  }
  const status = (body as Record<string, unknown>).status;
  if (typeof status !== "string" || !isValid(status)) {
    return fail("status must be a valid status value");
  }
  return { ok: true, value: status };
}

export function parseLikeToggle(body: unknown): Parsed<{ parentType: "challenge" | "solution"; parentId: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("request body must be a JSON object");
  }
  const rec = body as Record<string, unknown>;
  if (rec.parentType !== "challenge" && rec.parentType !== "solution") {
    return fail("parentType must be 'challenge' or 'solution'");
  }
  if (typeof rec.parentId !== "string" || !isUuid(rec.parentId)) {
    return fail("parentId must be a uuid");
  }
  return { ok: true, value: { parentType: rec.parentType, parentId: rec.parentId } };
}
