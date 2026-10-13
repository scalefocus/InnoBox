// Data layer for /api/notifications (INNOBOX_SPEC.md §12.2): the in-app inbox — newest-first
// list with unread count, mark-all-read, and mark-one-read. Every query is scoped to the
// viewer's own user_id; there is no cross-user read path here.
import type { Pool } from "pg";

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

export async function getInbox(pool: Pool, userId: string): Promise<Inbox> {
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<{ id: string; type: string; payload: { message: string; link: string }; read_at: Date | null; created_at: Date }>(
      `select n.id, n.type, n.payload, n.read_at, n.created_at from notifications n
        where n.user_id = $1 and ${NOT_ABOUT_TRASH} order by n.created_at desc limit ${INBOX_LIMIT}`,
      [userId],
    ),
    pool.query<{ count: string }>(
      `select count(*)::text as count from notifications n where n.user_id = $1 and n.read_at is null and ${NOT_ABOUT_TRASH}`,
      [userId],
    ),
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

export async function markAllRead(pool: Pool, userId: string): Promise<void> {
  await pool.query(`update notifications n set read_at = now() where n.user_id = $1 and n.read_at is null and ${NOT_ABOUT_TRASH}`, [userId]);
}

/** Returns false when no notification with this id belongs to the viewer (already gone,
 *  or someone else's — the 404 is indistinguishable either way). */
export async function markOneRead(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`update notifications set read_at = now() where id = $1 and user_id = $2`, [id, userId]);
  return Boolean(rowCount);
}
