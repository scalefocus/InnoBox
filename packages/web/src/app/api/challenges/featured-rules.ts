// Pure rules for Home "Featured" pins (INNOBOX_SPEC.md §13.2 *Featured challenges*, §14.3).
// No DB, no I/O — unit-tested in featured-rules.test.ts. The DB side lives in featured.ts
// (feature/unfeature/list/limit) and featured-unpin.ts (the automatic unpin hooks).

/** §14.3 *Featured challenges* setting: default and inclusive range. */
export const FEATURED_LIMIT_DEFAULT = 3;
export const FEATURED_LIMIT_MIN = 1;
export const FEATURED_LIMIT_MAX = 6;

/** The platform_settings key holding the cap (§5 `settings.featured_limit`). */
export const FEATURED_LIMIT_KEY = "featured_limit";

/** Transaction-scoped advisory-lock name serializing "count, then pin" (§13.2 cap). */
export const FEATURED_LOCK_NAME = "innobox:featured_challenges";

/** §13.2: a challenge may be pinned only while `valid` or `solved` (also DB-checked). */
export function isFeaturableStatus(status: string): boolean {
  return status === "valid" || status === "solved";
}

/** True when a status change must clear an existing pin: any move to a non-eligible status.
 *  `valid → solved` and `solved → valid` keep it (§13.2 *Eligible statuses*). */
export function transitionClearsPin(newStatus: string): boolean {
  return !isFeaturableStatus(newStatus);
}

/** Validates an admin-supplied limit (PATCH /api/admin/settings `featuredLimit`). */
export function parseFeaturedLimit(value: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < FEATURED_LIMIT_MIN || value > FEATURED_LIMIT_MAX) {
    return { ok: false, error: `featuredLimit must be an integer between ${FEATURED_LIMIT_MIN} and ${FEATURED_LIMIT_MAX}` };
  }
  return { ok: true, value };
}

/** Reads a stored setting value defensively: anything missing or out of range is the default. */
export function normalizeStoredFeaturedLimit(value: unknown): number {
  const parsed = parseFeaturedLimit(value);
  return parsed.ok ? parsed.value : FEATURED_LIMIT_DEFAULT;
}

/** §13.2: the cap check. Lowering the limit unpins nothing — the count may already exceed it,
 *  and a new pin is refused until the count drops below the limit. */
export function isAtFeaturedCap(currentCount: number, limit: number): boolean {
  return currentCount >= limit;
}

/** §13.2 409 message at the cap; N is the configured limit. */
export function featuredCapMessage(limit: number): string {
  return `${limit} challenge${limit === 1 ? " is" : "s are"} already featured. Unfeature one first.`;
}

export const FEATURE_FORBIDDEN_MESSAGE = "Only platform admins can feature challenges.";
export const FEATURE_INELIGIBLE_MESSAGE = "Only challenges that are valid or solved can be featured.";

/** The §13.2 detail-payload fields. `featured` is carried for every viewer; `canFeature` only for a
 *  platform admin on an eligible status; the provenance (`featuredBy` / `featuredAt`) only when
 *  `canFeature` — so a non-admin's payload carries no "who / when" of the pin. */
export interface FeaturedDetailFields {
  featured: boolean;
  canFeature: boolean;
  featuredBy?: string;
  featuredAt?: string;
}

export function featuredDetailFields(input: {
  isPlatformAdmin: boolean;
  status: string;
  featuredAt: Date | null;
  featuredByName: string | null;
}): FeaturedDetailFields {
  const featured = input.featuredAt !== null;
  const canFeature = input.isPlatformAdmin && isFeaturableStatus(input.status);
  const fields: FeaturedDetailFields = { featured, canFeature };
  if (canFeature && input.featuredAt !== null) {
    fields.featuredAt = input.featuredAt.toISOString();
    if (input.featuredByName !== null) fields.featuredBy = input.featuredByName;
  }
  return fields;
}
