// Data layer for the platform-admin audit browser (INNOBOX_SPEC.md §15): a read-only,
// filterable view over the append-only audit_log — category chips (action prefixes), a plain
// cross-table ILIKE search over the human-meaningful fields (never the JSON payload), a date
// range, and the capped newest-first CSV export. Platform-admin-only (gated in the routes).
// The log intentionally retains actor identity for provenance (§15), so this surface may show
// real names — it is the single authorized place to read the raw trail.
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import { AUDIT_CATEGORY_PATTERNS, AUDIT_EXPORT_CAP, AUDIT_PAGE_SIZE, type AuditCategory } from "@innobox/shared";
import { itemHref } from "../../../../lib/deep-link";

export interface AuditFilters {
  category?: AuditCategory;
  /** Substring over action ‖ target_type ‖ target_id ‖ target number ‖ actor name ‖ actor e-mail. */
  q?: string;
  action?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  from?: string; // ISO timestamp lower bound (inclusive)
  to?: string; // ISO timestamp upper bound (inclusive)
}

export interface AuditEntry {
  id: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  /** `CH-412` / `SOL-7` when the target is a challenge or solution that still exists. */
  targetNumber: string | null;
  /** Where a still-resolving target links (§15): `/challenges/<n>` for a challenge, the parent
   *  challenge anchored `#SOL-<m>` for a solution. Null for a target that no longer resolves
   *  (deleted, §10.3) and for every other target type — those render as plain text. */
  targetHref: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
  /** Hash-chain columns (§15) — null on rows written before the chain migration. */
  chainSeq: string | null;
  prevHash: string | null;
  rowHash: string | null;
}

/** One page of the browser. Deliberately no total: the browser query is bounded by its LIMIT on
 *  the created_at index (§15), and a window count would scan the whole filtered set instead. */
export interface AuditPage {
  rows: AuditEntry[];
  hasMore: boolean;
}

export { AUDIT_PAGE_SIZE, AUDIT_EXPORT_CAP };

interface AuditQueryRow {
  id: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_number: string | null;
  target_parent_number: string | null;
  before: unknown;
  after: unknown;
  created_at: Date;
  chain_seq: string | null;
  prev_hash: string | null;
  row_hash: string | null;
}

/** The target's display number, resolved live for challenge/solution targets. */
const TARGET_NUMBER_SQL = `case
    when a.target_type = 'challenge' then (select 'CH-' || c.number::text from challenges c where c.id::text = a.target_id)
    when a.target_type = 'solution'  then (select 'SOL-' || s.number::text from solutions s where s.id::text = a.target_id)
  end`;

/** A solution target's parent challenge number — what its link resolves to (§12.1 deep link). */
const TARGET_PARENT_NUMBER_SQL = `case
    when a.target_type = 'solution' then (select c.number::text from solutions s join challenges c on c.id = s.challenge_id where s.id::text = a.target_id)
  end`;

const SEARCH_SQL = `(a.action || ' ' || a.target_type || ' ' || coalesce(a.target_id, '') || ' ' || coalesce(${TARGET_NUMBER_SQL}, '')
   || ' ' || coalesce(u.display_name, '') || ' ' || coalesce(u.email, ''))`;

const SELECT_COLUMNS = `a.id::text, a.actor_user_id, u.display_name as actor_display_name, u.email as actor_email, a.action,
            a.target_type, a.target_id, ${TARGET_NUMBER_SQL} as target_number, ${TARGET_PARENT_NUMBER_SQL} as target_parent_number,
            a.before, a.after, a.created_at, a.chain_seq::text as chain_seq, a.prev_hash, a.row_hash`;
const FROM_SQL = `from audit_log a left join users u on u.id = a.actor_user_id`;
const SELECT_SQL = `select ${SELECT_COLUMNS} ${FROM_SQL}`;
/** The export's variant: the window count is evaluated before ORDER BY/LIMIT, so it is the full
 *  matching total even when the cap truncates the rows. */
const SELECT_SQL_WITH_TOTAL = `select ${SELECT_COLUMNS}, count(*) over()::text as total_count ${FROM_SQL}`;

/** §15: newest first on the created_at index; the id breaks ties between rows of one transaction
 *  (which share `now()`), so paging by offset is stable. */
const ORDER_SQL = `order by a.created_at desc, a.id desc`;

/** The link for a still-resolving challenge/solution target; null otherwise (plain text). */
function targetHref(r: Pick<AuditQueryRow, "target_type" | "target_number" | "target_parent_number">): string | null {
  if (!r.target_number) return null;
  if (r.target_type === "challenge") return itemHref(r.target_number);
  if (r.target_type === "solution" && r.target_parent_number) return itemHref(r.target_parent_number, r.target_number);
  return null;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildWhere(filters: AuditFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds: string[] = [];
  if (filters.category && filters.category !== "all") {
    const patterns = AUDIT_CATEGORY_PATTERNS[filters.category];
    conds.push(`(${patterns.map((p) => `a.action like ${push(p)}`).join(" or ")})`);
  }
  if (filters.q && filters.q.trim()) conds.push(`${SEARCH_SQL} ilike ${push(`%${escapeLike(filters.q.trim())}%`)}`);
  if (filters.action) conds.push(`a.action = ${push(filters.action)}`);
  if (filters.actorUserId) conds.push(`a.actor_user_id = ${push(filters.actorUserId)}`);
  if (filters.targetType) conds.push(`a.target_type = ${push(filters.targetType)}`);
  if (filters.targetId) conds.push(`a.target_id = ${push(filters.targetId)}`);
  if (filters.from) conds.push(`a.created_at >= ${push(filters.from)}`);
  if (filters.to) conds.push(`a.created_at <= ${push(filters.to)}`);
  return { where: conds.length ? `where ${conds.join(" and ")}` : "", params };
}

function mapRow(r: AuditQueryRow): AuditEntry {
  return {
    id: r.id,
    actorUserId: r.actor_user_id,
    actorDisplayName: r.actor_display_name,
    actorEmail: r.actor_email,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    targetNumber: r.target_number,
    targetHref: targetHref(r),
    before: r.before,
    after: r.after,
    createdAt: r.created_at.toISOString(),
    chainSeq: r.chain_seq,
    prevHash: r.prev_hash,
    rowHash: r.row_hash,
  };
}

export async function listAudit(pool: Pool, filters: AuditFilters, page: { limit?: number; offset?: number } = {}): Promise<AuditPage> {
  const limit = Math.min(AUDIT_PAGE_SIZE, Math.max(1, page.limit ?? AUDIT_PAGE_SIZE));
  const offset = Math.max(0, page.offset ?? 0);
  const { where, params } = buildWhere(filters);
  // One row past the page answers "is there more?" without counting the filtered set.
  const { rows } = await pool.query<AuditQueryRow>(`${SELECT_SQL} ${where} ${ORDER_SQL} limit ${limit + 1} offset ${offset}`, params);
  return { rows: rows.slice(0, limit).map(mapRow), hasMore: rows.length > limit };
}

export interface AuditExport {
  rows: AuditEntry[];
  totalMatching: number;
}

/** Newest-first, capped (§15): a filtered set larger than the cap still downloads its most recent
 *  `cap` rows; `totalMatching` lets the page say "exported N of M". */
export async function exportAudit(pool: Pool, filters: AuditFilters, cap: number = AUDIT_EXPORT_CAP): Promise<AuditExport> {
  const { where, params } = buildWhere(filters);
  // The export, unlike the browser, does report the matching total (X-Total-Matching drives the
  // "exported N of M" notice), so it carries the window count.
  const { rows } = await pool.query<AuditQueryRow & { total_count: string }>(
    `${SELECT_SQL_WITH_TOTAL} ${where} ${ORDER_SQL} limit ${Math.max(1, Math.floor(cap))}`,
    params,
  );
  return { rows: rows.map(mapRow), totalMatching: rows.length > 0 ? Number(rows[0]!.total_count) : 0 };
}
