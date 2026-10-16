// Data layer for /api/notifications (INNOBOX_SPEC.md §12.2): the in-app inbox — newest-first
// list with unread count, mark-all-read, and mark-one-read. Every query is scoped to the
// viewer's own user_id; there is no cross-user read path here. §12.1 (v1.16): the list, the
// unread count and mark-all-read also apply the §4.3 visibility gate at read time — a row about
// a challenge the viewer can no longer see is kept but hidden, and returns with access.
import type { Pool } from "pg";
import { pushChallengeVisibilityConditions, type Viewer } from "../challenges/store";

export interface NotificationItem {
  id: string;
  type: string;
  message: string;
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
 * brings it back exactly as it was. A row is "about" an item by the same matching the §10.3
 * purge uses: the target it carries (`parentType`/`parentId`, or `challengeId` on a comment row),
 * or its deep link (`/challenges/<n>`, `…#SOL-<m>`). Over `notifications n`.
 */
export const NOT_ABOUT_TRASH = `not exists (
    select 1 from challenges tc
     where tc.trashed_at is not null
       and (n.payload->>'link' = '/challenges/' || tc.number
            or n.payload->>'link' like '/challenges/' || tc.number || '#%'
            or (n.payload->>'parentType' = 'challenge' and n.payload->>'parentId' = tc.id::text)
            or n.payload->>'challengeId' = tc.id::text))
  and not exists (
    select 1 from solutions ts join challenges sc on sc.id = ts.challenge_id
     where ts.trashed_at is not null
       and ((n.payload->>'parentType' = 'solution' and n.payload->>'parentId' = ts.id::text)
            or n.payload->>'link' = '/challenges/' || sc.number || '#SOL-' || ts.number))`;

/** The challenge an inbox row is about, by the payload keys every item-bound row carries
 *  (§12.1): `challengeId` (comment rows), or `parentType` + `parentId` for a challenge or a
 *  solution (resolved to its challenge). Over `notifications n` and `challenges c`. A row that
 *  names no item matches no challenge. */
const ROW_IS_ABOUT_CHALLENGE = `(c.id::text = n.payload->>'challengeId'
         or (n.payload->>'parentType' = 'challenge' and c.id::text = n.payload->>'parentId')
         or (n.payload->>'parentType' = 'solution'
             and c.id = (select s.challenge_id from solutions s where s.id::text = n.payload->>'parentId')))`;

/**
 * §12.1 read-time visibility gate (v1.16): hide a row about a challenge — or a solution on one —
 * the viewer can no longer see. The predicate is the §4.3 SQL twin (pushChallengeVisibilityConditions:
 * platform admins see everything; awaiting_triage/withdrawn only the author and the namespace's
 * admins; `people` the access list, reviewers and assignee; else org-wide or members), so the
 * bell can never disagree with the detail page. A read-time predicate only — nothing is deleted,
 * and a row comes back as it was once access returns. Rows that name no item pass. Over
 * `notifications n`; parameters go through `push`.
 */
function pushInboxVisibilityCondition(viewer: Viewer, push: (v: unknown) => string, conditions: string[]): void {
  const visible: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, visible);
  // coalesce: the twin is written for a plain WHERE, where SQL NULL (e.g. `c.assignee_id = $viewer`
  // on a challenge with no assignee) already means "not visible". Negated inside `not exists` a
  // NULL would mean "not hidden" instead, so it is pinned to false before the negation.
  conditions.push(`not exists (
    select 1 from challenges c
     where ${ROW_IS_ABOUT_CHALLENGE}
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
  const list = inboxScope(viewer);
  const unread = inboxScope(viewer, [`n.read_at is null`]);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<{ id: string; type: string; payload: { message: string; link: string }; read_at: Date | null; created_at: Date }>(
      `select n.id, n.type, n.payload, n.read_at, n.created_at from notifications n
        where ${list.where} order by n.created_at desc limit ${INBOX_LIMIT}`,
      list.params,
    ),
    pool.query<{ count: string }>(`select count(*)::text as count from notifications n where ${unread.where}`, unread.params),
  ]);

  return {
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type,
      message: r.payload.message,
      link: r.payload.link,
      read: r.read_at !== null,
      createdAt: r.created_at.toISOString(),
    })),
    unreadCount: Number(countRows[0]?.count ?? 0),
  };
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
       where c.visibility <> 'org' and ${ROW_IS_ABOUT_CHALLENGE})`);
  }
  const { rows } = await pool.query<{ id: string; type: string; payload: { message: string; link: string }; read_at: Date | null; created_at: Date }>(
    `select n.id, n.type, n.payload, n.read_at, n.created_at from notifications n
      where ${conditions.join(" and ")}
      order by n.created_at desc limit ${opts.limit + 1} offset ${opts.offset}`,
    [userId],
  );
  return {
    notifications: rows.slice(0, opts.limit).map((r) => ({
      id: r.id,
      type: r.type,
      message: r.payload.message,
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
