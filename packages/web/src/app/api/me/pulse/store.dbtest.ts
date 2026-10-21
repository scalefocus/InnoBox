// Live-DB integration test (gated) for the §12.2 pulse (INNOBOX_SPEC.md §12.2, §13.1, §14.4, §14.6,
// invariant 2; v1.18):
//  - one read returns the bell's unread count, the new-challenges count, the triage attention
//    count and the active banner — each equal to its surface's own count;
//  - attention is null for a non-admin and a number for a namespace admin;
//  - the counts obey visibility: a namespace-restricted challenge reaches neither count of a
//    non-member;
//  - the banner appears while active and is null once cleared.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§12.2 pulse: four bare values, scoped like their surfaces, attention only for admins",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { readPulse, hasTriageAttention } = await import("./store");
    const { countNewChallenges } = await import("../../challenges/store");
    const { countUnread } = await import("../../notifications/store");
    const { countTriageAttention } = await import("../../admin/triage/store");
    const { setSystemBanner, clearSystemBanner } = await import("../../admin/system-banner/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Pulse NS') returning id`, [
        `dbtest-pulse-${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
          [`dbtest-pulse-${label}-${stamp}`, `dbtest-pulse-${label}-${stamp}@example.test`, `Dbtest Pulse ${label}`, `pulse-${label}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "member" | "namespace_admin"; namespaceId: string }[]) => buildRoleSet(grants, { globalNamespaceId: globalId });
      const authorId = await mkUser("author");
      const outsider = { userId: await mkUser("outsider"), roles: roles([]) };
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      // Both viewers have "seen" the Challenges surface before the fixtures exist.
      await pool.query(`update users set challenges_seen_at = now() - interval '1 minute' where id = any($1::uuid[])`, [[outsider.userId, nsAdmin.userId]]);

      assert.equal(hasTriageAttention(outsider), false);
      assert.equal(hasTriageAttention(nsAdmin), true);

      // One namespace-restricted challenge awaiting triage, one org-visible valid one.
      const mkChallenge = async (visibility: "org" | "namespace", status: string) => {
        const { rows } = await pool.query<{ id: string; number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, $2, $3, 'pulse fixture', $4, $5, $6) returning id, number::text`,
          [nsId, visibility, `Pulse ${visibility} ${stamp}`, ia[0]!.id, authorId, status],
        );
        return rows[0]!;
      };
      const restricted = await mkChallenge("namespace", "awaiting_triage");
      const open = await mkChallenge("org", "valid");
      for (const v of [outsider, nsAdmin]) {
        for (const c of [restricted, open]) {
          await pool.query(`insert into notifications (user_id, type, payload) values ($1, 'status_changed', $2)`, [
            v.userId,
            JSON.stringify({ message: `pulse ${stamp}`, link: `/challenges/${c.number}`, parentType: "challenge", parentId: c.id }),
          ]);
        }
      }

      const p1 = await readPulse(pool, outsider);
      assert.equal(p1.attention, null, "a non-admin gets null, and nothing is computed for them");
      assert.equal(p1.unreadCount, await countUnread(pool, outsider));
      assert.equal(p1.newChallenges, await countNewChallenges(pool, outsider));
      assert.ok(p1.unreadCount >= 1, "the row about the org challenge counts");

      const p2 = await readPulse(pool, nsAdmin);
      assert.equal(typeof p2.attention, "number");
      assert.equal(p2.attention, await countTriageAttention(pool, nsAdmin));
      assert.ok((p2.attention ?? 0) >= 1, "the awaiting_triage challenge is unseen for its namespace admin");
      assert.equal(p2.unreadCount, await countUnread(pool, nsAdmin));
      assert.equal(p2.newChallenges, await countNewChallenges(pool, nsAdmin));

      // Invariant 2: the restricted challenge reaches neither of the outsider's counts.
      assert.equal(p2.unreadCount - p1.unreadCount, 1, "exactly the restricted row separates them");
      assert.equal(p2.newChallenges - p1.newChallenges, 1, "…and exactly the restricted challenge");

      // The banner rides along while active (a singleton — cleared again below).
      const banner = await setSystemBanner(pool, { message: `Pulse banner ${stamp}`, tone: "info", url: null, duration: "1h" }, nsAdmin.userId);
      const p3 = await readPulse(pool, outsider);
      assert.deepEqual(p3.banner, banner);
      await clearSystemBanner(pool, nsAdmin.userId);
      assert.equal((await readPulse(pool, outsider)).banner, null);
    } finally {
      await pool.end();
    }
  },
);
