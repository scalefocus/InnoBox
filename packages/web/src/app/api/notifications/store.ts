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

export async function getInbox(pool: Pool, userId: string): Promise<Inbox> {
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query<{ id: string; type: string; payload: { message: string; link: string }; read_at: Date | null; created_at: Date }>(
      `select id, type, payload, read_at, created_at from notifications where user_id = $1 order by created_at desc limit ${INBOX_LIMIT}`,
      [userId],
    ),
    pool.query<{ count: string }>(`select count(*)::text as count from notifications where user_id = $1 and read_at is null`, [userId]),
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
  await pool.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [userId]);
}

/** Returns false when no notification with this id belongs to the viewer (already gone,
 *  or someone else's — the 404 is indistinguishable either way). */
export async function markOneRead(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(`update notifications set read_at = now() where id = $1 and user_id = $2`, [id, userId]);
  return Boolean(rowCount);
}
