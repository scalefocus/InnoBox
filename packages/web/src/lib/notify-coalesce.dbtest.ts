// Live-DB integration test (gated) for §12.1 coalesced comment notifications: the first comment
// inserts one inbox row + one outbox row; further comments refresh that row in place (count,
// latest commenter, message, re-sorted) with no new outbox row; a separate item gets its own row;
// reading (by id, or by opening the challenge, which also covers its solutions) ends the
// coalescing and the next comment starts a fresh row with a fresh e-mail. The SQL-rendered message
// matches the shared JS renderer. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "coalesced comments: one row per item until read, one e-mail, read-on-open",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, commentNotificationMessage } = await import("@innobox/shared");
    const { dispatchCoalescedComment, markCommentNotificationsReadForChallenge } = await import("./notify");
    const { markOneRead } = await import("../app/api/notifications/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-coal-${label}-${stamp}`, `dbtest-coal-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const reader = await mkUser("reader");
      const alice = await mkUser("alice");
      const bob = await mkUser("bob");
      const { rows: ch } = await pool.query<{ id: string; number: number }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'coalesce', $3, $4, 'valid') returning id, number`,
        [globalId, `Coalesce ${stamp}`, ia[0]!.id, reader],
      );
      const challengeId = ch[0]!.id;
      const challengeNumber = `CH-${ch[0]!.number}`;
      const { rows: sol } = await pool.query<{ id: string }>(
        `insert into solutions (challenge_id, description, author_id, status) values ($1, 'a solution', $2, 'valid') returning id`,
        [challengeId, reader],
      );
      const solutionId = sol[0]!.id;

      const resolveRoles = async () => buildRoleSet([], { globalNamespaceId: globalId });
      const post = (actorId: string, latestBy: string, parentType: "challenge" | "solution" = "challenge") =>
        dispatchCoalescedComment({ pool, actorId, resolveRoles }, [reader], {
          parentType,
          parentId: parentType === "challenge" ? challengeId : solutionId,
          challengeId,
          challengeNumber,
          challengeTitle: `Coalesce ${stamp}`,
          latestBy,
          link: `/challenges/${ch[0]!.number}`,
        });
      const unread = async () =>
        (
          await pool.query<{ id: string; payload: { count: number; message: string; latestBy: string; parentType: string }; created_at: Date }>(
            `select id, payload, created_at from notifications where user_id = $1 and type = 'comment_posted' and read_at is null order by created_at`,
            [reader],
          )
        ).rows;
      const outboxCount = async () =>
        Number((await pool.query<{ c: string }>(`select count(*)::text as c from notification_outbox where user_id = $1 and type = 'comment_posted'`, [reader])).rows[0]!.c);

      // First comment: one row, one outbox row (one e-mail).
      await post(alice, "Dbtest alice");
      let rows = await unread();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.payload.count, 1);
      assert.equal(rows[0]!.payload.message, commentNotificationMessage(1, challengeNumber, `Coalesce ${stamp}`, "Dbtest alice"));
      assert.equal(await outboxCount(), 1);
      const firstId = rows[0]!.id;
      const firstAt = rows[0]!.created_at.getTime();

      // Two more on the same item: still ONE row, refreshed in place; still one e-mail.
      await new Promise((r) => setTimeout(r, 15));
      await post(bob, "Dbtest bob");
      await post(alice, "Dbtest alice");
      rows = await unread();
      assert.equal(rows.length, 1, "coalesced");
      assert.equal(rows[0]!.id, firstId, "updated in place, not replaced");
      assert.equal(rows[0]!.payload.count, 3);
      assert.equal(rows[0]!.payload.latestBy, "Dbtest alice");
      assert.equal(rows[0]!.payload.message, commentNotificationMessage(3, challengeNumber, `Coalesce ${stamp}`, "Dbtest alice"), "the SQL renderer matches the shared one");
      assert.ok(rows[0]!.created_at.getTime() > firstAt, "re-sorted to the top");
      assert.equal(await outboxCount(), 1, "no new e-mail while unread");

      // A comment on the solution is a different item → its own row.
      await post(bob, "Dbtest bob", "solution");
      rows = await unread();
      assert.equal(rows.length, 2);
      assert.equal(await outboxCount(), 2);

      // Reading by id ends coalescing for that item only.
      assert.equal(await markOneRead(pool, reader, firstId), true);
      await post(bob, "Dbtest bob");
      rows = await unread();
      assert.equal(rows.length, 2, "a fresh challenge row + the still-unread solution row");
      const fresh = rows.find((r) => r.payload.parentType === "challenge")!;
      assert.notEqual(fresh.id, firstId);
      assert.equal(fresh.payload.count, 1);
      assert.equal(await outboxCount(), 3, "a fresh row means a fresh e-mail");

      // Opening the challenge reads its own AND its solutions' rows.
      await markCommentNotificationsReadForChallenge(pool, reader, challengeId);
      assert.equal((await unread()).length, 0);

      // The commenter is never notified about their own comment.
      await dispatchCoalescedComment({ pool, actorId: reader, resolveRoles }, [reader], {
        parentType: "challenge",
        parentId: challengeId,
        challengeId,
        challengeNumber,
        challengeTitle: `Coalesce ${stamp}`,
        latestBy: "Dbtest reader",
        link: "/x",
      });
      assert.equal((await unread()).length, 0);
    } finally {
      await pool.end();
    }
  },
);
