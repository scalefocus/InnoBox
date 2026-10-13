// Live-DB integration test (gated) for the §12.1 e-mail digest HOLD at insert time: a follower-type
// event's outbox row is held until the recipient's next slot (daily / weekly) and carries its inbox
// row's id and the digest facts; immediate recipients, the admin route of a new solution, and the
// actionable events bypass the hold; a coalesced comment holds one row whose inbox count keeps
// growing; and changing the choice re-slots (or, back to immediate, releases) the held rows.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "e-mail digests: hold at insert, bypasses, coalesced comments, re-slot on a change of choice",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, nextDigestSlot } = await import("@innobox/shared");
    const { dispatchCoalescedComment, dispatchEvent, dispatchToUser } = await import("./notify");
    const { getOwnProfile, setEmailDelivery } = await import("../app/api/profile/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string, delivery: "immediate" | "daily" | "weekly") => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email_delivery) values ($1, $2, $3, $4) returning id`,
          [`dbtest-digest-${label}-${stamp}`, `dbtest-digest-${label}-${stamp}@example.test`, `Dbtest Digest ${label}`, delivery],
        );
        return rows[0]!.id;
      };
      const actor = await mkUser("actor", "immediate");
      const daily = await mkUser("daily", "daily");
      const weekly = await mkUser("weekly", "weekly");
      const now = await mkUser("now", "immediate");
      const admin = await mkUser("admin", "daily"); // on a digest, but on the admin route below
      const { rows: ch } = await pool.query<{ id: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'digest', $3, $4, 'valid') returning id, number::text`,
        [globalId, `Digest ${stamp}`, ia[0]!.id, actor],
      );
      const challengeId = ch[0]!.id;
      const ctx = { pool, actorId: actor, resolveRoles: async () => buildRoleSet([], { globalNamespaceId: globalId }) };
      const scope = { parentType: "challenge" as const, parentId: challengeId };
      const facts = { kind: "status" as const, challengeNumber: "1", challengeTitle: `Digest ${stamp}`, statusLabel: "In review" };

      const outboxFor = async (message: string) =>
        (
          await pool.query<{ user_id: string; digest_due_at: Date | null; payload: { notificationId?: string; digest?: unknown } }>(
            `select user_id, digest_due_at, payload from notification_outbox where payload->>'message' = $1`,
            [message],
          )
        ).rows;
      const byUser = (rows: Awaited<ReturnType<typeof outboxFor>>) => new Map(rows.map((r) => [r.user_id, r]));

      // Event 3 — held for the daily and weekly recipients, immediate for the rest.
      const before = new Date();
      const status = `status ${stamp}`;
      await dispatchEvent(ctx, scope, [daily, weekly, now], "status_changed", { message: status, link: "/x" }, undefined, { event: 3, facts });
      const held = byUser(await outboxFor(status));
      assert.equal(held.size, 3);
      assert.equal(held.get(now)!.digest_due_at, null, "an immediate recipient is never held");
      assert.equal(held.get(now)!.payload.digest, undefined, "only a held row carries the digest facts");
      const dailySlot = held.get(daily)!.digest_due_at!;
      const weeklySlot = held.get(weekly)!.digest_due_at!;
      assert.ok([nextDigestSlot("daily", before).getTime(), nextDigestSlot("daily", new Date()).getTime()].includes(dailySlot.getTime()), "next daily slot");
      assert.equal(weeklySlot.getUTCDay(), 1, "weekly slot is a Monday");
      assert.equal(weeklySlot.getUTCHours(), 6);
      assert.deepEqual(held.get(daily)!.payload.digest, facts);
      // The held row names its own inbox row.
      const { rows: inbox } = await pool.query<{ id: string }>(`select id from notifications where user_id = $1 and payload->>'message' = $2`, [
        daily,
        status,
      ]);
      assert.equal(held.get(daily)!.payload.notificationId, inbox[0]!.id);

      // Event 2 — the admin route is an attention event, never held; the follower is held.
      const proposed = `proposed ${stamp}`;
      await dispatchEvent(ctx, scope, [admin, daily], "solution_proposed", { message: proposed, link: "/x" }, undefined, {
        event: 2,
        adminRoute: [admin],
        facts: { kind: "solution", challengeNumber: "1", challengeTitle: "t" },
      });
      const p = byUser(await outboxFor(proposed));
      assert.equal(p.get(admin)!.digest_due_at, null, "admins and the committee hear about a new solution at once");
      assert.ok(p.get(daily)!.digest_due_at);

      // Actionable events bypass the hold: event 4 via dispatchEvent, event 7 via dispatchToUser.
      const rejected = `rejected ${stamp}`;
      await dispatchEvent(ctx, scope, [daily], "rejected", { message: rejected, link: "/x" }, undefined, { event: 4, facts });
      assert.equal((await outboxFor(rejected))[0]!.digest_due_at, null);
      const assigned = `assigned ${stamp}`;
      await dispatchToUser(ctx, daily, "challenge_assigned", { message: assigned, link: "/x" }, scope);
      assert.equal((await outboxFor(assigned))[0]!.digest_due_at, null);

      // Event 6 — the first comment's outbox row is held; a second one coalesces into the inbox row.
      const comment = {
        parentType: "challenge" as const,
        parentId: challengeId,
        challengeId,
        challengeNumber: "CH-1",
        challengeTitle: `Digest ${stamp}`,
        latestBy: "Dbtest Digest actor",
        link: "/x",
        replyToAuthorId: null,
      };
      await dispatchCoalescedComment(ctx, [daily], comment);
      await dispatchCoalescedComment(ctx, [daily], comment);
      const { rows: commentOutbox } = await pool.query<{ digest_due_at: Date | null; payload: { notificationId: string; digest: { kind: string } } }>(
        `select digest_due_at, payload from notification_outbox where user_id = $1 and type = 'comment_posted'`,
        [daily],
      );
      assert.equal(commentOutbox.length, 1, "one held row per unread coalesced inbox row");
      assert.ok(commentOutbox[0]!.digest_due_at);
      assert.equal(commentOutbox[0]!.payload.digest.kind, "comment");
      const { rows: commentInbox } = await pool.query<{ count: string }>(`select payload->>'count' as count from notifications where id = $1`, [
        commentOutbox[0]!.payload.notificationId,
      ]);
      assert.equal(commentInbox[0]!.count, "2", "the digest will report both comments");

      // Changing the choice: daily → weekly moves every held row to the weekly slot.
      const asViewer = { userId: daily, roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      assert.equal((await getOwnProfile(pool, asViewer))!.emailDelivery, "daily");
      await setEmailDelivery(pool, daily, "weekly");
      assert.equal((await getOwnProfile(pool, asViewer))!.emailDelivery, "weekly");
      const heldFor = async (userId: string) =>
        (
          await pool.query<{ digest_due_at: Date }>(
            `select digest_due_at from notification_outbox where user_id = $1 and digest_due_at is not null and status <> 'sent'`,
            [userId],
          )
        ).rows.map((r) => r.digest_due_at);
      const reslotted = await heldFor(daily);
      assert.equal(reslotted.length, 3, "status, new solution and comment rows are held");
      for (const due of reslotted) assert.equal(due.getUTCDay(), 1, "each re-slotted to a Monday");

      // Back to immediate: the held rows become due now — the digest job releases them as one.
      await setEmailDelivery(pool, daily, "immediate");
      const released = await heldFor(daily);
      assert.equal(released.length, 3, "nothing held is lost");
      for (const due of released) assert.ok(due.getTime() <= Date.now() + 1000, "due at once");
    } finally {
      await pool.end();
    }
  },
);
