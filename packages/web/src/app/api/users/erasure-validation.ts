// Pure request-shape parsing for POST /api/admin/users/:userId/scrub (INNOBOX_SPEC.md §3, §16):
// the optional `reassignTo` successor of the GDPR erasure. No DB here — whether the successor is
// an ACTIVE, not-scrubbed user is checked inside the scrub transaction (erasure-reassignment.ts).
import { isUuid } from "../challenges/validation";

export type ScrubRequestParse = { ok: true; value: { reassignTo: string | null } } | { ok: false; error: string };

/**
 * `body` is the JSON object the route read (an empty body counts as `{}`); `userId` is the
 * already-validated path parameter. `reassignTo` absent or null keeps the no-successor erasure;
 * anything that is not a uuid, or that names the user being erased, is a 400. Other keys are
 * ignored. The uuid is lower-cased so the "not the same user" check cannot be dodged by case.
 */
export function parseScrubRequest(body: Record<string, unknown>, userId: string): ScrubRequestParse {
  const raw = body.reassignTo;
  if (raw === undefined || raw === null) return { ok: true, value: { reassignTo: null } };
  if (typeof raw !== "string" || !isUuid(raw)) return { ok: false, error: "reassignTo must be a user id or null" };
  const reassignTo = raw.toLowerCase();
  if (reassignTo === userId.toLowerCase()) {
    return { ok: false, error: "open assignments cannot be reassigned to the user being erased" };
  }
  return { ok: true, value: { reassignTo } };
}
