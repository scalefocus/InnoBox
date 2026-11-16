// Data layer for /api/notifications (INNOBOX_SPEC.md §12.2): the in-app inbox — newest-first
// list with unread count, mark-all-read, and mark-one-read. Every query is scoped to the
// viewer's own user_id; there is no cross-user read path here. §12.1 (v1.16): the list, the
// unread count and mark-all-read also apply the §4.3 visibility gate at read time — a row about
// a challenge the viewer can no longer see is kept but hidden, and returns with access.
import type { Pool } from "pg";
import { closedAsDuplicateMessage } from "@innobox/shared";
import { CHALLENGE_VIS_COLS, isChallengeRowVisible, pushChallengeVisibilityConditions, type ChallengeVisibilityColumns, type Viewer } from "../challenges/store";

interface InboxRow {
  id: string;
  type: string;
  payload: { message: string; link: string; detail?: unknown; number?: unknown; originalNumber?: unknown; author?: unknown };
  read_at: Date | null;
  created_at: Date;
}

/**
 * §42.6 event 25 is rendered at READ time: the row stores the original's number only, and the bell
 * names it — and links to it — only while the reader can still see it; otherwise the second form
 * ("CH-30 was closed as a duplicate"), linking to the duplicate. `canSee` decides per original;
 * every other row passes through unchanged.
 */
async function renderInboxRows(pool: Pool, rows: InboxRow[], canSee: (row: ChallengeVisibilityColumns) => boolean): Promise<InboxRow[]> {
  const numbers = [
    ...new Set(
      rows
        .filter((r) => r.type === "closed_as_duplicate" && typeof r.payload.originalNumber === "string")
        .map((r) => r.payload.originalNumber as string),
    ),
  ];
  if (numbers.length === 0) return rows;
  const { rows: originals } = await pool.query<ChallengeVisibilityColumns & { number: string }>(
    `select ${CHALLENGE_VIS_COLS}, c.number::text from challenges c where c.number::text = any($1::text[])`,
    [numbers],
  );
  const visible = new Set(originals.filter((o) => !o.trashed && canSee(o)).map((o) => o.number));
  return rows.map((r) => {
    if (r.type !== "closed_as_duplicate" || typeof r.payload.number !== "string") return r;
    const original = typeof r.payload.originalNumber === "string" && visible.has(r.payload.originalNumber) ? r.payload.originalNumber : null;
    return {
      ...r,
      payload: {
        ...r.payload,
        message: closedAsDuplicateMessage({ number: r.payload.number, original: original ? { number: original } : null, author: r.payload.author === true }),
        link: `/challenges/${original ?? r.payload.number}`,
      },
    };
  });
}

/** §25.6: the agent's inbox has no role set to judge by — an original is named only when every
 *  signed-in person could see it (org-wide, past triage, not withdrawn). */
function visibleToEveryone(row: ChallengeVisibilityColumns): boolean {
  return row.visibility === "org" && row.status !== "awaiting_triage" && row.status !== "withdrawn";
}

export interface NotificationItem {
  id: string;
  type: string;
  message: string;
  /** A second, muted line under the message — §40.6's quoted note on an invitation; null otherwise. */
  detail: string | null;
  link: string;
  read: boolean;
  createdAt: string;
}

export interface Inbox {
  notifications: NotificationItem[];
  unreadCount: number;
}

const INBOX_LIMIT = 50;

/**
 * §10.4: an inbox row about a trashed item — or about anything under a trashed challenge — is kept
 * but hidden: the list and the unread count skip it, mark-all-read leaves it alone, and a restore
 * brings it back exactly as it was. Since v1.18 a row is "about" an item by its `challenge_id` /
 * `solution_id` columns (§5, migration 0051 — derived from the payload target by a trigger, so a
 * solution row carries its parent challenge too), looked up by primary key: one index probe per
 * row instead of a scan of every trashed item's link and payload keys. Over `notifications n`.
 */
export const NOT_ABOUT_TRASH = `not exists (
    select 1 from challenges tc where tc.id = n.challenge_id and tc.trashed_at is not null)
  and not exists (
    select 1 from solutions ts where ts.id = n.solution_id and ts.trashed_at is not null)`;

/**
 * §12.1 read-time visibility gate (v1.16): hide a row about a challenge — or a solution on one —
 * the viewer can no longer see. The predicate is the §4.3 SQL twin (pushChallengeVisibilityConditions:
 * platform admins see everything; awaiting_triage/withdrawn only the authors (the team) and the namespace's
 * admins; `people` the access list, reviewers and assignee; else org-wide or members), so the
 * bell can never disagree with the detail page. A read-time predicate only — nothing is deleted,
 * and a row comes back as it was once access returns. Rows that name no item (`challenge_id` null)
 * pass. The web list, the §12.2 pulse count and the §25.6 agent view all go through it. Over
 * `notifications n`; parameters go through `push`.
 */
function pushInboxVisibilityCondition(viewer: Viewer, push: (v: unknown) => string, conditions: string[]): void {
  const visible: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, visible);
  // coalesce: the twin is written for a plain WHERE, where SQL NULL (e.g. `c.assignee_id = $viewer`
  // on a challenge with no assignee) already means "not visible". Negated inside `not exists` a
  // NULL would mean "not hidden" instead, so it is pinned to false before the negation.
  // §12.1 (v1.18): the challenge the row is about is its `challenge_id` column — a primary-key join,
  // where matching payload text against `c.id::text` used to scan every challenge per row.
  conditions.push(`not exists (
    select 1 from challenges c
     where c.id = n.challenge_id
       and not coalesce((${visible.join(" and ")}), false))`);
}

/** The inbox's own WHERE clause: the viewer's rows, minus the trash (§10.4) and minus what the
 *  viewer can no longer see (§12.1). Returns the SQL and its parameters. */
function inboxScope(viewer: Viewer, extra: string[] = []): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions = [`n.user_id = ${push(viewer.userId)}`, NOT_ABOUT_TRASH, ...extra];
  pushInboxVisibilityCondition(viewer, push, conditions);
  return { where: conditions.join(" and "), params };
}

export async function getInbox(pool: Pool, viewer: Viewer): Promise<Inbox> {
  // One evaluation of the gates: the window count runs over every row the WHERE keeps, before the
  // LIMIT, so the list and its unread count come from the same pass (§12.2 — the list response
  // carries `unreadCount`, which the shell adopts).
  const list = inboxScope(viewer);
  const { rows: raw } = await pool.query<InboxRow & { unread_count: string }>(
    `select n.id, n.type, n.payload, n.read_at, n.created_at,
            (count(*) filter (where n.read_at is null) over ())::text as unread_count
       from notifications n
      where ${list.where} order by n.created_at desc limit ${INBOX_LIMIT}`,
    list.params,
  );
  const rows = await renderInboxRows(pool, raw, (o) => isChallengeRowVisible(viewer, o));

  return {
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type,
      message: r.payload.message,
      detail: typeof r.payload.detail === "string" ? r.payload.detail : null,
      link: r.payload.link,
      read: r.read_at !== null,
      createdAt: r.created_at.toISOString(),
    })),
    unreadCount: Number(raw[0]?.unread_count ?? 0),
  };
}

/** §12.2 pulse: the bell's unread count alone, under the same gates as the list. */
export async function countUnread(pool: Pool, viewer: Viewer): Promise<number> {
  const scope = inboxScope(viewer, [`n.read_at is null`]);
  const { rows } = await pool.query<{ count: string }>(`select count(*)::text as count from notifications n where ${scope.where}`, scope.params);
  return Number(rows[0]?.count ?? 0);
}

/**
 * §25.6 list_my_notifications: a page of the caller's inbox, newest first. With `orgVisibleOnly`
 * (§25.5) a row about a restricted challenge (namespace-only or shared with specific people, §4.3)
 * — or a solution on one — is left out, so the agent's view behaves as if those items did not
 * exist. Read-only: nothing is marked read.
 */
export async function listInboxPage(
  pool: Pool,
  userId: string,
  opts: { limit: number; offset: number; unreadOnly?: boolean; orgVisibleOnly?: boolean },
): Promise<{ notifications: NotificationItem[]; hasMore: boolean }> {
  // §10.4: rows about the trash stay hidden here too.
  const conditions = [`n.user_id = $1`, NOT_ABOUT_TRASH];
  if (opts.unreadOnly) conditions.push(`n.read_at is null`);
  if (opts.orgVisibleOnly) {
    conditions.push(`not exists (
      select 1 from challenges c
       where c.id = n.challenge_id and c.visibility <> 'org')`);
  }
  const { rows: raw } = await pool.query<InboxRow>(
    `select n.id, n.type, n.payload, n.read_at, n.created_at from notifications n
      where ${conditions.join(" and ")}
      order by n.created_at desc limit ${opts.limit + 1} offset ${opts.offset}`,
    [userId],
  );
  const rows = await renderInboxRows(pool, raw, visibleToEveryone);
  return {
    notifications: rows.slice(0, opts.limit).map((r) => ({
      id: r.id,
      type: r.type,
      message: r.payload.message,
      detail: typeof r.payload.detail === "string" ? r.payload.detail : null,
      link: r.payload.link,
      read: r.read_at !== null,
      createdAt: r.created_at.toISOString(),
    })),
    hasMore: rows.length > opts.limit,
  };
}

/** Marks read what the bell shows: like a row about the trash (§10.4), a row hidden by the §12.1
 *  read-time gate is left alone, so it comes back unread when access returns. */
export async function markAllRead(pool: Pool, viewer: Viewer): Promise<void> {
  const scope = inboxScope(viewer, [`n.read_at is null`]);
  await pool.query(`update notifications n set read_at = now() where ${scope.where}`, scope.params);
}

/** Returns false when no notification with this id belongs to the viewer (already gone,
 *  or someone else's — the 404 is indistinguishable either way). */
export async function markOneRead(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`update notifications set read_at = now() where id = $1 and user_id = $2`, [id, userId]);
  return Boolean(rowCount);
}
