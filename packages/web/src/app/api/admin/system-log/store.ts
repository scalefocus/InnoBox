// Data layer for the §14.7 system log (INNOBOX_SPEC.md): the capture insert, the platform-admin
// listing/search/export, the nav-badge marker, and the GDPR scrub of actor snapshots.
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool, PoolClient } from "pg";
import {
  SYSTEM_LOG_EXPORT_CAP,
  SYSTEM_LOG_PAGE_SIZE,
  sanitizeSystemMessage,
  type SystemEventInput,
  type SystemEventSource,
  type SystemLogStatusFilter,
} from "@innobox/shared";

type Db = Pool | PoolClient;

export interface SystemEventRecord {
  id: string;
  createdAt: string;
  status: number;
  method: string;
  route: string;
  path: string;
  userId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  errorCode: string | null;
  message: string;
  requestId: string | null;
  durationMs: number | null;
  source: SystemEventSource;
}

export interface SystemLogFilters {
  status: SystemLogStatusFilter;
  q?: string;
  /** ISO instants, inclusive. */
  from?: string;
  to?: string;
  userId?: string;
}

export interface SystemLogPage {
  events: SystemEventRecord[];
  total: number;
  hasMore: boolean;
}

/** Must match the expression of system_events_search_trgm_idx (migration 0023) exactly. */
const SEARCH_EXPR =
  "(coalesce(e.path, '') || ' ' || coalesce(e.error_code, '') || ' ' || coalesce(e.message, '') || ' ' || coalesce(e.actor_email, '') || ' ' || coalesce(e.actor_name, ''))";

const COLUMNS =
  "e.id::text, e.created_at, e.status, e.method, e.route, e.path, e.user_id, e.actor_name, e.actor_email, e.error_code, e.message, e.request_id, e.duration_ms, e.source";

interface Row {
  id: string;
  created_at: Date;
  status: number;
  method: string;
  route: string;
  path: string;
  user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  error_code: string | null;
  message: string;
  request_id: string | null;
  duration_ms: number | null;
  source: SystemEventSource;
}

function mapRow(r: Row): SystemEventRecord {
  return {
    id: r.id,
    createdAt: r.created_at.toISOString(),
    status: r.status,
    method: r.method,
    route: r.route,
    path: r.path,
    userId: r.user_id,
    actorName: r.actor_name,
    actorEmail: r.actor_email,
    errorCode: r.error_code,
    message: r.message,
    requestId: r.request_id,
    durationMs: r.duration_ms,
    source: r.source,
  };
}

/** The capture insert. Callers fire-and-forget it (a logging failure must never fail the request
 *  it describes); the message is re-sanitized here as the last line of defence. */
export async function recordSystemEvent(db: Db, input: SystemEventInput): Promise<void> {
  await db.query(
    `insert into system_events
       (status, method, route, path, user_id, actor_name, actor_email, error_code, message, request_id, duration_ms, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.status,
      input.method.toUpperCase().slice(0, 16),
      input.route.slice(0, 512),
      input.path.slice(0, 2048),
      input.userId ?? null,
      input.actorName ?? null,
      input.actorEmail ?? null,
      input.errorCode ?? null,
      sanitizeSystemMessage(input.message),
      input.requestId ? input.requestId.slice(0, 128) : null,
      input.durationMs == null ? null : Math.max(0, Math.round(input.durationMs)),
      input.source,
    ],
  );
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildWhere(filters: SystemLogFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conds: string[] = [];
  if (filters.status === "5xx") conds.push("e.status >= 500");
  else if (filters.status !== "all") conds.push(`e.status = ${push(Number(filters.status))}`);
  if (filters.q && filters.q.trim()) conds.push(`${SEARCH_EXPR} ilike ${push(`%${escapeLike(filters.q.trim())}%`)}`);
  if (filters.from) conds.push(`e.created_at >= ${push(filters.from)}`);
  if (filters.to) conds.push(`e.created_at <= ${push(filters.to)}`);
  if (filters.userId) conds.push(`e.user_id = ${push(filters.userId)}`);
  return { where: conds.length ? `where ${conds.join(" and ")}` : "", params };
}

export async function listSystemEvents(
  pool: Pool,
  filters: SystemLogFilters,
  page: { limit?: number; offset?: number } = {},
): Promise<SystemLogPage> {
  const limit = Math.min(SYSTEM_LOG_PAGE_SIZE, Math.max(1, page.limit ?? SYSTEM_LOG_PAGE_SIZE));
  const offset = Math.max(0, page.offset ?? 0);
  const { where, params } = buildWhere(filters);
  const { rows } = await pool.query<Row & { total_count: string }>(
    `select ${COLUMNS}, count(*) over()::text as total_count
       from system_events e
       ${where}
      order by e.created_at desc, e.id desc
      limit ${limit} offset ${offset}`,
    params,
  );
  const total = rows.length > 0 ? Number(rows[0]!.total_count) : offset === 0 ? 0 : await countOnly(pool, filters);
  return { events: rows.map(mapRow), total, hasMore: offset + rows.length < total };
}

async function countOnly(pool: Pool, filters: SystemLogFilters): Promise<number> {
  const { where, params } = buildWhere(filters);
  const { rows } = await pool.query<{ count: string }>(`select count(*)::text as count from system_events e ${where}`, params);
  return Number(rows[0]?.count ?? 0);
}

export interface SystemLogExport {
  rows: SystemEventRecord[];
  /** How many rows matched the filters in total — the page shows "exported N of M" when capped. */
  totalMatching: number;
}

/** Newest-first, capped at SYSTEM_LOG_EXPORT_CAP (§14.7). */
export async function exportSystemEvents(pool: Pool, filters: SystemLogFilters, cap: number = SYSTEM_LOG_EXPORT_CAP): Promise<SystemLogExport> {
  const { where, params } = buildWhere(filters);
  const { rows } = await pool.query<Row & { total_count: string }>(
    `select ${COLUMNS}, count(*) over()::text as total_count
       from system_events e
       ${where}
      order by e.created_at desc, e.id desc
      limit ${Math.max(1, Math.floor(cap))}`,
    params,
  );
  return { rows: rows.map(mapRow), totalMatching: rows.length > 0 ? Number(rows[0]!.total_count) : 0 };
}

/** Events recorded since this admin last opened the page (null marker → everything). */
export async function countUnseenSystemEvents(pool: Pool, userId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count
       from system_events e
      where e.created_at > coalesce((select system_log_seen_at from users where id = $1), '-infinity'::timestamptz)`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function markSystemLogSeen(pool: Pool, userId: string): Promise<void> {
  await pool.query(`update users set system_log_seen_at = now(), updated_at = now() where id = $1`, [userId]);
}

/** GDPR erasure (§3): the table is mutable, so unlike audit_log the actor snapshot is scrubbed. */
export async function scrubSystemEventsForUser(db: Db, userId: string): Promise<number> {
  const { rowCount } = await db.query(
    `update system_events set user_id = null, actor_name = null, actor_email = null where user_id = $1`,
    [userId],
  );
  return rowCount ?? 0;
}
