// Home "Featured" pins — the DB side (INNOBOX_SPEC.md §13.2 *Featured challenges*, §14.3, §15).
// A platform admin pins a valid/solved challenge to the top of every viewer's Home dashboard.
//
//  - feature/unfeature: §2.4 order of checks — 404 when the caller cannot see the challenge (or
//    the number is malformed), then 403 for a non-platform-admin, then 409 for an ineligible
//    status, then 409 at the cap. The cap check and the pin run in ONE transaction under a
//    transaction-scoped advisory lock, so two concurrent features can never both take the last
//    slot. Idempotent: re-featuring keeps the original featured_at (no audit row); unfeaturing an
//    unpinned challenge is a no-op.
//  - Curation is not an edit: only featured_at / featured_by are written — never updated_at (the
//    Home spotlights and gallery order on it), edited_at, or status_changed_at — and nobody is
//    notified.
//  - listFeaturedForViewer: the full §4.3 gallery predicate per viewer (invariant 2), §9-masked
//    gallery-card rows (invariant 3), newest pin first. Hidden pins leave no trace — no count,
//    no cap, no "N more".
//
// Relative imports only, so the gated dbtest can run under the plain node test runner.
import type { Pool, PoolClient } from "pg";
import { canSeeChallenge, type ChallengeStatus } from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import {
  FEATURED_LIMIT_KEY,
  FEATURED_LIMIT_MAX,
  FEATURED_LOCK_NAME,
  isAtFeaturedCap,
  isFeaturableStatus,
  normalizeStoredFeaturedLimit,
} from "./featured-rules";
import { CHALLENGE_SELECT, pushChallengeVisibilityConditions, toListItem, type ChallengeListItem, type ChallengeRow, type Viewer } from "./store";
import { isEntityNumber } from "./validation";

// ── The cap setting (§14.3) ─────────────────────────────────────────────────────────────

export async function getFeaturedLimit(db: Pool | PoolClient): Promise<number> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [FEATURED_LIMIT_KEY]);
  return normalizeStoredFeaturedLimit(rows[0]?.value);
}

/** Platform-admin only (the route gates it). Lowering the limit unpins nothing (§13.2). */
export async function setFeaturedLimit(pool: Pool, limit: number, actorUserId: string): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query(
      `insert into platform_settings (key, value, updated_by, updated_at)
       values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [FEATURED_LIMIT_KEY, JSON.stringify(limit), actorUserId],
    );
    await appendAudit(client, {
      actorUserId,
      action: "settings.featured_limit_changed",
      targetType: "platform_settings",
      targetId: FEATURED_LIMIT_KEY,
      after: { limit },
    });
  });
}

// ── Feature / unfeature ─────────────────────────────────────────────────────────────────

export type FeatureResult =
  | { status: "ok"; featured: boolean; featuredAt: string | null }
  | { status: "not_found" }
  | { status: "forbidden" }
  | { status: "ineligible" }
  | { status: "at_cap"; limit: number };

interface PinRow {
  id: string;
  namespace_id: string;
  visibility: "org" | "namespace";
  status: string;
  author_id: string;
  featured_at: Date | null;
}

/** The shared front half: malformed / invisible → not_found, then non-platform-admin → forbidden. */
async function loadForCuration(pool: Pool, viewer: Viewer, number: string): Promise<{ status: "ok"; row: PinRow } | { status: "not_found" | "forbidden" }> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<PinRow>(
    `select id, namespace_id, visibility, status, author_id, featured_at from challenges where number = $1`,
    [number],
  );
  const row = rows[0];
  const visible =
    row !== undefined &&
    canSeeChallenge(viewer, { namespaceId: row.namespace_id, visibility: row.visibility, status: row.status as ChallengeStatus, authorId: row.author_id });
  if (!row || !visible) return { status: "not_found" };
  if (!viewer.roles.isPlatformAdmin) return { status: "forbidden" };
  return { status: "ok", row };
}

export async function featureChallenge(pool: Pool, viewer: Viewer, number: string): Promise<FeatureResult> {
  const loaded = await loadForCuration(pool, viewer, number);
  if (loaded.status !== "ok") return loaded;
  if (!isFeaturableStatus(loaded.row.status)) return { status: "ineligible" };

  return inTransaction(pool, async (client): Promise<FeatureResult> => {
    // Serializes every "count, then pin" — the cap can never be overshot by a race.
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [FEATURED_LOCK_NAME]);
    // Re-read under the row lock: the status or the pin may have moved since the check above.
    const { rows } = await client.query<{ status: string; featured_at: Date | null }>(
      `select status, featured_at from challenges where id = $1 for update`,
      [loaded.row.id],
    );
    const current = rows[0];
    if (!current) return { status: "not_found" }; // hard-deleted in between
    if (current.featured_at !== null) return { status: "ok", featured: true, featuredAt: current.featured_at.toISOString() }; // idempotent no-op
    if (!isFeaturableStatus(current.status)) return { status: "ineligible" };

    const limit = await getFeaturedLimit(client);
    const { rows: countRows } = await client.query<{ n: number }>(`select count(*)::int as n from challenges where featured_at is not null`);
    if (isAtFeaturedCap(countRows[0]?.n ?? 0, limit)) return { status: "at_cap", limit };

    // Curation only: featured_at / featured_by — deliberately NOT updated_at (§13.2).
    const { rows: pinned } = await client.query<{ featured_at: Date }>(
      `update challenges set featured_at = now(), featured_by = $2 where id = $1 returning featured_at`,
      [loaded.row.id, viewer.userId],
    );
    const featuredAt = pinned[0]!.featured_at.toISOString();
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "challenge.featured",
      targetType: "challenge",
      targetId: loaded.row.id,
      after: { featuredAt },
    });
    return { status: "ok", featured: true, featuredAt };
  });
}

export async function unfeatureChallenge(pool: Pool, viewer: Viewer, number: string): Promise<FeatureResult> {
  const loaded = await loadForCuration(pool, viewer, number);
  if (loaded.status !== "ok") return loaded;

  return inTransaction(pool, async (client): Promise<FeatureResult> => {
    const { rows } = await client.query<{ featured_at: Date | null }>(`select featured_at from challenges where id = $1 for update`, [loaded.row.id]);
    const featuredAt = rows[0]?.featured_at ?? null;
    if (featuredAt === null) return { status: "ok", featured: false, featuredAt: null }; // idempotent no-op
    await client.query(`update challenges set featured_at = null, featured_by = null where id = $1`, [loaded.row.id]);
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "challenge.unfeatured",
      targetType: "challenge",
      targetId: loaded.row.id,
      before: { featuredAt: featuredAt.toISOString() },
      after: { trigger: "manual" },
    });
    return { status: "ok", featured: false, featuredAt: null };
  });
}

// ── Home section ────────────────────────────────────────────────────────────────────────

/** The viewer's visible pins as §13.1 gallery cards, newest pin first. Never more than the
 *  §14.3 maximum (6) — a lowered limit still shows every current pin. */
export async function listFeaturedForViewer(db: Pool | PoolClient, viewer: Viewer): Promise<ChallengeListItem[]> {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const viewerParam = push(viewer.userId); // the $viewer placeholder in CHALLENGE_SELECT
  const conditions: string[] = ["c.featured_at is not null"];
  pushChallengeVisibilityConditions(viewer, push, conditions);
  const { rows } = await db.query<ChallengeRow>(
    `${CHALLENGE_SELECT.replaceAll("$viewer", viewerParam)} where ${conditions.join(" and ")} order by c.featured_at desc limit ${FEATURED_LIMIT_MAX}`,
    params,
  );
  return rows.map(toListItem);
}
