// Live-DB integration test (gated) for the /api/notifications inbox (INNOBOX_SPEC.md
// §12.2) — extracted into its own store.ts as part of the route/store split. Self-skips
// when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "notifications store: inbox listing, unread count, mark-one-read, mark-all-read",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { getInbox, markAllRead, markOneRead } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
          [`dbtest-notif-${label}-${stamp}`, `dbtest-notif-${label}-${stamp}@example.test`, `Dbtest Notif ${label}`, `${label}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      const userId = await mkUser("owner");
      const otherUserId = await mkUser("other");

      const insertNotification = async (forUserId: string, message: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into notifications (user_id, type, payload) values ($1, 'comment_posted', $2) returning id`,
          [forUserId, JSON.stringify({ message, link: `/challenges/${stamp}` })],
        );
        return rows[0]!.id;
      };

      const n1 = await insertNotification(userId, `first ${stamp}`);
      const n2 = await insertNotification(userId, `second ${stamp}`);
      const otherUsersNotification = await insertNotification(otherUserId, `not yours ${stamp}`);

      const inbox = await getInbox(pool, userId);
      assert.equal(inbox.unreadCount, 2);
      assert.equal(inbox.notifications.some((n) => n.id === n1), true);
      assert.equal(inbox.notifications.some((n) => n.id === n2), true);
      assert.equal(inbox.notifications.some((n) => n.id === otherUsersNotification), false, "the inbox is scoped to its own user_id");
      const found = inbox.notifications.find((n) => n.id === n1)!;
      assert.equal(found.message, `first ${stamp}`);
      assert.equal(found.read, false);

      // Marking someone else's notification read (by id) must fail — no cross-user write.
      const crossUserAttempt = await markOneRead(pool, userId, otherUsersNotification);
      assert.equal(crossUserAttempt, false);

      const ownAttempt = await markOneRead(pool, userId, n1);
      assert.equal(ownAttempt, true);
      const afterOneRead = await getInbox(pool, userId);
      assert.equal(afterOneRead.unreadCount, 1);
      assert.equal(afterOneRead.notifications.find((n) => n.id === n1)!.read, true);
      assert.equal(afterOneRead.notifications.find((n) => n.id === n2)!.read, false);

      await markAllRead(pool, userId);
      const afterAllRead = await getInbox(pool, userId);
      assert.equal(afterAllRead.unreadCount, 0);

      // markOneRead on a nonexistent id returns false rather than throwing.
      assert.equal(await markOneRead(pool, userId, randomUUID()), false);
    } finally {
      await pool.end();
    }
  },
);

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  return { Pool, randomUUID };
}
