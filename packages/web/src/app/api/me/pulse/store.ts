// Data layer for GET /api/me/pulse (INNOBOX_SPEC.md §12.2, v1.18): the four live values the app
// shell shows, read concurrently after one §4.2 resolution. Every value is a bare count or the
// banner — no titles, authors or namespaces — under the same visibility and namespace scoping as
// the surface it feeds (invariant 2). Relative imports only (no `@/`) so the gated .dbtest.ts suite
// runs under the plain node runner.
import type { Pool } from "pg";
import type { Pulse } from "../../../../lib/pulse";
import { countNewChallenges, type Viewer } from "../../challenges/store";
import { countUnread } from "../../notifications/store";
import { adminNamespaceIds, countTriageAttention } from "../../admin/triage/store";
import { getActiveSystemBanner } from "../../admin/system-banner/store";

/** Whether the §14.4 attention bubble applies: a platform admin, or a namespace admin somewhere. */
export function hasTriageAttention(viewer: Viewer): boolean {
  const ns = adminNamespaceIds(viewer.roles);
  return ns === "all" || ns.length > 0;
}

export async function readPulse(pool: Pool, viewer: Viewer): Promise<Pulse> {
  // Nothing about attention is computed for a non-admin: the key is present, the value null.
  const [unreadCount, newChallenges, attention, banner] = await Promise.all([
    countUnread(pool, viewer),
    countNewChallenges(pool, viewer),
    hasTriageAttention(viewer) ? countTriageAttention(pool, viewer) : Promise.resolve(null),
    getActiveSystemBanner(pool),
  ]);
  return { unreadCount, newChallenges, attention, banner };
}
