// Data layer for /api/admin/triage (INNOBOX_SPEC.md §14.1): the namespace triage queue,
// bulk assign/status actions, and CSV export. Namespace admins see their own namespace(s)
// in full (canSeeChallenge already grants namespace admins visibility into every status,
// including awaiting_triage/withdrawn, so this view needs no extra visibility gate beyond
// "is this namespace one the viewer administers") — platform admins see every namespace.
// Bulk actions delegate to challenges/store.ts's single-item functions so every change is
// audited individually, exactly as if done one row at a time from the detail page — and fire the
// same §12.1 notifications (events 3/4/5 on a real transition, event 7 on an assignment change)
// through the shared builders in lib/notify-events.
import type { Pool } from "pg";
import { canAssignAtStatus, formatChallengeNumber, formatSolutionNumber, type ChallengeStatus, type RoleSet } from "@innobox/shared";
import { appendAudit } from "../../../../lib/audit";
import type { NotifyContext } from "../../../../lib/notify";
import { logNotifyFailure, notifyAssignmentChanged, notifyChallengeStatusChanged } from "../../../../lib/notify-events";
import { setChallengeAssigneeLean, setChallengeStatusLean, type Viewer } from "../../challenges/store";
import { isEntityNumber } from "../../challenges/validation";

export interface TriageRow {
  number: string;
  title: string;
  authorDisplayName: string;
  authorAnonymous: boolean;
  /** Anonymity-safe (§9/§13.6): null when the author is anonymous — never the real id. */
  authorId: string | null;
  status: ChallengeStatus;
  impactAreaName: string;
  namespaceSlug: string;
  assigneeDisplayName: string | null;
  assigneeId: string | null;
  createdAt: string;
}

export interface TriageFilters {
  namespaceId?: string;
  status?: ChallengeStatus;
  authorName?: string;
  assigneeId?: string | "unassigned";
  number?: string;
}

/** Namespace ids the viewer may administer, or "all" for platform admins. Empty array means
 *  the viewer has no admin namespace at all (route should 403/return nothing). */
export function adminNamespaceIds(roles: RoleSet): string[] | "all" {
  if (roles.isPlatformAdmin) return "all";
  return [...new Set(roles.grants.filter((g) => g.role === "namespace_admin" && g.namespaceId !== null).map((g) => g.namespaceId as string))];
}

/** Shared WHERE-clause construction for both the paginated queue view and the (unpaginated,
 *  capped) CSV export — one place decides what "matches this filter, for this viewer" means.
 *  `null` return means "viewer has no admin namespace at all" or "requested a namespace they
 *  don't administer" — both fold to an empty result, same anti-oracle treatment as elsewhere. */
function buildTriageQuery(viewer: Viewer, filters: TriageFilters): { whereClause: string; params: unknown[] } | null {
  const adminNs = adminNamespaceIds(viewer.roles);
  if (adminNs !== "all" && adminNs.length === 0) return null;

  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];

  if (filters.namespaceId) {
    if (adminNs !== "all" && !adminNs.includes(filters.namespaceId)) return null;
    conditions.push(`c.namespace_id = ${push(filters.namespaceId)}`);
  } else if (adminNs !== "all") {
    conditions.push(`c.namespace_id = ANY(${push(adminNs)}::uuid[])`);
  }

  if (filters.status) conditions.push(`c.status = ${push(filters.status)}`);
  if (filters.number) conditions.push(`c.number::text = ${push(filters.number)}`);
  if (filters.authorName) {
    // Anonymity-safety (mirrors challenges/store.ts): the filter must never distinguish
    // "no match" from "hidden because anonymous", so anonymous rows are excluded outright.
    conditions.push(`c.is_anonymous = false and u.display_name ILIKE ${push(`%${filters.authorName}%`)}`);
  }
  if (filters.assigneeId === "unassigned") {
    conditions.push(`c.assignee_id is null`);
  } else if (filters.assigneeId) {
    conditions.push(`c.assignee_id = ${push(filters.assigneeId)}`);
  }

  return { whereClause: conditions.length ? `where ${conditions.join(" and ")}` : "", params };
}

interface TriageQueryRow {
  number: string;
  title: string;
  author_id: string;
  author_display_name: string;
  is_anonymous: boolean;
  status: ChallengeStatus;
  impact_area_name: string;
  namespace_slug: string;
  assignee_id: string | null;
  assignee_display_name: string | null;
  created_at: Date;
}

function toTriageRow(row: TriageQueryRow): TriageRow {
  return {
    number: formatChallengeNumber(row.number),
    title: row.title,
    authorDisplayName: row.is_anonymous ? "Anonymous" : row.author_display_name,
    authorAnonymous: row.is_anonymous,
    // Anonymity-safe: never expose the real author id for an anonymous item (§9, invariant 3).
    authorId: row.is_anonymous ? null : row.author_id,
    status: row.status,
    impactAreaName: row.impact_area_name,
    namespaceSlug: row.namespace_slug,
    assigneeDisplayName: row.assignee_display_name,
    assigneeId: row.assignee_id,
    createdAt: row.created_at.toISOString(),
  };
}

const TRIAGE_SELECT = `
  select c.number::text, c.title, c.author_id, u.display_name as author_display_name, c.is_anonymous, c.status,
         ia.name as impact_area_name, ns.slug as namespace_slug, c.assignee_id, au.display_name as assignee_display_name,
         c.created_at
    from challenges c
    join users u on u.id = c.author_id
    join impact_areas ia on ia.id = c.impact_area_id
    join namespaces ns on ns.id = c.namespace_id
    left join users au on au.id = c.assignee_id
`;

export const TRIAGE_PAGE_SIZE_DEFAULT = 50;
export const TRIAGE_PAGE_SIZE_MAX = 100;
/** Export stays capped at the same ceiling the un-paginated queue used to have — a single
 *  filtered view is never realistically larger than this at InnoBox's scale, and it bounds
 *  the CSV response size regardless. */
const TRIAGE_EXPORT_MAX = 500;

export interface TriagePage {
  rows: TriageRow[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTriageQueue(
  pool: Pool,
  viewer: Viewer,
  filters: TriageFilters,
  pagination: { page: number; pageSize: number } = { page: 1, pageSize: TRIAGE_PAGE_SIZE_DEFAULT },
): Promise<TriagePage> {
  const query = buildTriageQuery(viewer, filters);
  const { page, pageSize } = pagination;
  if (!query) return { rows: [], total: 0, page, pageSize };

  const { whereClause, params } = query;
  const offset = (page - 1) * pageSize;
  // count(*) over() rides along in the same query — one round trip instead of a separate
  // count query — then gets stripped off before mapping to the public TriageRow shape.
  const { rows } = await pool.query<TriageQueryRow & { total_count: string }>(
    `select *, count(*) over()::text as total_count from (
       ${TRIAGE_SELECT}
       ${whereClause}
     ) t
     order by t.created_at desc
     limit ${pageSize} offset ${offset}`,
    params,
  );

  return {
    rows: rows.map(toTriageRow),
    total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
    page,
    pageSize,
  };
}

export interface BulkActionOutcome {
  number: string;
  status: "ok" | "forbidden" | "not_found" | "invalid" | "terminal_status" | "unknown_user";
}

/** Bulk actions are independent per-item transactions (each individually audited) — running
 *  them fully sequentially wastes wall-clock time waiting on round-trips one at a time, but
 *  running all of them at once could exhaust the pool on a large selection. This chunks the
 *  concurrency to a modest width instead. */
const BULK_CONCURRENCY = 10;

async function runInChunks<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** How the bulk actions resolve a recipient's roles for the §12.1 visibility drop — injected (the
 *  route passes `resolveRolesForUser`) so this module stays free of the session layer. */
export type ResolveRoles = NotifyContext["resolveRoles"];

export async function bulkSetStatus(
  pool: Pool,
  admin: Viewer,
  numbers: string[],
  newStatus: string,
  resolveRoles: ResolveRoles,
): Promise<BulkActionOutcome[]> {
  const notify: NotifyContext = { pool, actorId: admin.userId, resolveRoles };
  return runInChunks(numbers, BULK_CONCURRENCY, async (number) => {
    const result = await setChallengeStatusLean(pool, admin, number, newStatus);
    // §7.2: "a real transition fires the same §12.1 notifications regardless of mode" — the bulk
    // path included. A no-op (already at that status) is not a transition and fires nothing.
    if (result.status === "ok" && result.changed) {
      await notifyChallengeStatusChanged(notify, { number }, newStatus).catch(logNotifyFailure("bulk status notification failed"));
    }
    // Bulk actions are admin-only, so `illegal_transition` can't occur (admins free-set) — it's
    // folded into "invalid" alongside invalid_status purely to keep the outcome union closed.
    return {
      number: formatChallengeNumber(number),
      status:
        result.status === "ok"
          ? "ok"
          : result.status === "invalid_status" || result.status === "illegal_transition"
            ? "invalid"
            : result.status,
    };
  });
}

export async function bulkAssign(
  pool: Pool,
  admin: Viewer,
  numbers: string[],
  assigneeUserId: string | null,
  resolveRoles: ResolveRoles,
): Promise<BulkActionOutcome[]> {
  const notify: NotifyContext = { pool, actorId: admin.userId, resolveRoles };
  return runInChunks(numbers, BULK_CONCURRENCY, async (number) => {
    // The prior assignee is read first so a reassignment can tell them they were unassigned
    // (§12.1 event 7). The store's own load below re-checks visibility and RBAC, and nothing read
    // here reaches the caller unless that check passed.
    const prior = isEntityNumber(number)
      ? (await pool.query<{ assignee_id: string | null; title: string }>(`select assignee_id, title from challenges where number = $1`, [number])).rows
      : [];
    const result = await setChallengeAssigneeLean(pool, admin, number, assigneeUserId);
    // The new assignee's auto-follow (§12.3) happens inside the store's shared assignment write,
    // exactly as on the detail page.
    if (result.status === "ok" && prior[0]) {
      await notifyAssignmentChanged(notify, { number, title: prior[0].title }, prior[0].assignee_id, assigneeUserId).catch(
        logNotifyFailure("bulk assignment notification failed"),
      );
    }
    return { number: formatChallengeNumber(number), status: result.status === "ok" ? "ok" : result.status };
  });
}

/** CSV export of the current filtered view (§14.1) — anonymous authors masked, audited with
 *  who/filter/row count. `canAssignAtStatus` is re-exported here purely so callers building
 *  the triage UI's assign-availability hint don't need a second import path. */
export { canAssignAtStatus };

/** The full filtered set (not the paginated queue view), capped at TRIAGE_EXPORT_MAX —
 *  exports must capture everything matching the filter, not just one page of it. */
export async function exportTriageCsv(pool: Pool, admin: Viewer, filters: TriageFilters): Promise<{ rows: TriageRow[] }> {
  const query = buildTriageQuery(admin, filters);
  const rows = query
    ? (
        await pool.query<TriageQueryRow>(
          `${TRIAGE_SELECT} ${query.whereClause} order by c.created_at desc limit ${TRIAGE_EXPORT_MAX}`,
          query.params,
        )
      ).rows.map(toTriageRow)
    : [];

  await appendAudit(pool, {
    actorUserId: admin.userId,
    // `*.exported`, so the audit browser's Admin chip catches it (§15). Rows written under the
    // legacy name `admin.triage_exported` stay under that chip too — audit rows are immutable.
    action: "triage.exported",
    targetType: "challenge",
    after: { filters, rowCount: rows.length },
  });
  return { rows };
}

// ── Attention badge (§14.4) ──────────────────────────────────────────────────────────────

/** The "unseen actionable items" count behind the Triage/Administration nav bubble (§14.4):
 *  `awaiting_triage` challenges + `proposed` solutions in the viewer's namespace(s) (platform
 *  admins: all) whose `status_changed_at` is newer than the viewer's `users.triage_seen_at`.
 *  A null `triage_seen_at` (never visited) counts everything currently actionable (epoch). The
 *  return is a bare integer — no identity leaks — and obeys the same namespace scoping as the
 *  queue (invariant 2). Zero for a non-admin (empty namespace set). */
export async function countTriageAttention(pool: Pool, viewer: Viewer): Promise<number> {
  const adminNs = adminNamespaceIds(viewer.roles);
  if (adminNs !== "all" && adminNs.length === 0) return 0;

  const params: unknown[] = [viewer.userId];
  let nsClause = "";
  if (adminNs !== "all") {
    params.push(adminNs);
    nsClause = `and c.namespace_id = any($${params.length}::uuid[])`;
  }
  const seen = `coalesce((select triage_seen_at from users where id = $1), 'epoch'::timestamptz)`;
  const { rows } = await pool.query<{ count: string }>(
    `select (
       (select count(*) from challenges c
          where c.status = 'awaiting_triage' and c.status_changed_at > ${seen} ${nsClause})
       +
       (select count(*) from solutions s join challenges c on c.id = s.challenge_id
          where s.status = 'proposed' and s.status_changed_at > ${seen} ${nsClause})
     )::text as count`,
    params,
  );
  return rows[0] ? Number(rows[0].count) : 0;
}

/** Stamp the viewer's triage_seen_at = now() — fired when they open the triage queue (§14.4),
 *  clearing the attention bubble until a newer actionable item arrives. */
export async function markTriageSeen(pool: Pool, userId: string): Promise<void> {
  await pool.query(`update users set triage_seen_at = now() where id = $1`, [userId]);
}

// ── Solutions tab (§14.1) ────────────────────────────────────────────────────────────────

export interface TriageSolutionRow {
  number: string;
  challengeNumber: string;
  challengeTitle: string;
  authorDisplayName: string;
  authorAnonymous: boolean;
  /** Anonymity-safe (§9/§13.6): null when the solution author is anonymous. */
  authorId: string | null;
  impactAreaName: string;
  namespaceSlug: string;
  createdAt: string;
}

interface TriageSolutionQueryRow {
  number: string;
  challenge_number: string;
  challenge_title: string;
  author_id: string;
  author_display_name: string;
  is_anonymous: boolean;
  impact_area_name: string;
  namespace_slug: string;
  created_at: Date;
}

function toTriageSolutionRow(row: TriageSolutionQueryRow): TriageSolutionRow {
  return {
    number: formatSolutionNumber(row.number),
    challengeNumber: formatChallengeNumber(row.challenge_number),
    challengeTitle: row.challenge_title,
    authorDisplayName: row.is_anonymous ? "Anonymous" : row.author_display_name,
    authorAnonymous: row.is_anonymous,
    authorId: row.is_anonymous ? null : row.author_id,
    impactAreaName: row.impact_area_name,
    namespaceSlug: row.namespace_slug,
    createdAt: row.created_at.toISOString(),
  };
}

export interface TriageSolutionsPage {
  rows: TriageSolutionRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** The Solutions tab of the triage queue (§14.1): `proposed` solutions awaiting review, in the
 *  viewer's namespace(s) (platform admins: all). Same RBAC/visibility as the challenges tab;
 *  anonymous authors masked (§9). Navigational only — status changes live on the detail page. */
export async function listTriageSolutions(
  pool: Pool,
  viewer: Viewer,
  pagination: { page: number; pageSize: number } = { page: 1, pageSize: TRIAGE_PAGE_SIZE_DEFAULT },
): Promise<TriageSolutionsPage> {
  const adminNs = adminNamespaceIds(viewer.roles);
  const { page, pageSize } = pagination;
  if (adminNs !== "all" && adminNs.length === 0) return { rows: [], total: 0, page, pageSize };

  const params: unknown[] = [];
  const conditions = [`s.status = 'proposed'`];
  if (adminNs !== "all") {
    params.push(adminNs);
    conditions.push(`c.namespace_id = any($${params.length}::uuid[])`);
  }
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query<TriageSolutionQueryRow & { total_count: string }>(
    `select *, count(*) over()::text as total_count from (
       select s.number::text as number, c.number::text as challenge_number, c.title as challenge_title,
              s.author_id, u.display_name as author_display_name, s.is_anonymous,
              ia.name as impact_area_name, ns.slug as namespace_slug, s.created_at
         from solutions s
         join challenges c on c.id = s.challenge_id
         join users u on u.id = s.author_id
         join impact_areas ia on ia.id = c.impact_area_id
         join namespaces ns on ns.id = c.namespace_id
        where ${conditions.join(" and ")}
     ) t
     order by t.created_at desc
     limit ${pageSize} offset ${offset}`,
    params,
  );

  return {
    rows: rows.map(toTriageSolutionRow),
    total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
    page,
    pageSize,
  };
}
