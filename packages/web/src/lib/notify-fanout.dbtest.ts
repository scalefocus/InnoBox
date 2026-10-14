// Live-DB integration test (gated) for the §12.1 notification fan-out at scale (INNOBOX_SPEC.md
// §4.3, §12.1, invariants 1–2):
//  - resolveRolesForUsers (the bulk resolver) gives every user exactly the RoleSet the per-user
//    resolveRolesForUser does — namespace grants, the bootstrap admin group, the §4.3 access
//    list, and no grants at all;
//  - dispatchEvent with the real resolver drops the actor, duplicates, nulls and every candidate
//    who cannot see the item, and writes ONE inbox row + ONE outbox row per remaining recipient,
//    each outbox row naming its own inbox row and carrying the digest hold only where it applies;
//  - a resolver without the bulk form (the fallback) selects the same recipients;
//  - the fan-out's cost does not grow with the recipient list: the same number of queries for
//    3 recipients as for 30, and one bulk role resolution instead of one per recipient.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§12.1 fan-out: bulk role resolution matches per-user, recipients filtered, one inbox + outbox row each, fixed query count",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, listActiveImpactAreas } = await import("../app/api/challenges/store");
    const { resolveRolesForUser, resolveRolesForUsers } = await import("./auth");
    const { dispatchEvent } = await import("./notify");

    const pool = new Pool({ connectionString: url });
    const bootstrapBefore = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNamespace = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
          `dbtest-fo-${label}-${stamp}`,
          `Dbtest Fanout ${label}`,
        ]);
        return rows[0]!.id;
      };
      const nsId = await mkNamespace("ns");
      const otherNsId = await mkNamespace("other");
      const mkUser = async (label: string, emailDelivery = "immediate") => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email_delivery) values ($1, $2, $3, $4) returning id`,
          [`dbtest-fo-${label}-${stamp}`, `dbtest-fo-${label}-${stamp}@example.test`, `Dbtest Fo ${label} ${stamp}`, emailDelivery],
        );
        return rows[0]!.id;
      };
      /** A group whose members get `role` (in `namespaceId`, null for platform-wide) via role_mappings. */
      const mkGroup = async (label: string, members: string[], role?: { role: string; namespaceId: string | null }) => {
        const externalId = `dbtest-fo-grp-${label}-${stamp}`;
        const { rows } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [externalId]);
        for (const userId of members) await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [rows[0]!.id, userId]);
        if (role) {
          await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, $2, $3)`, [externalId, role.role, role.namespaceId]);
        }
        return externalId;
      };

      const authorId = await mkUser("author");
      const adminA = await mkUser("admina");
      const adminB = await mkUser("adminb", "daily");
      const memberC = await mkUser("memberc");
      const outsiderD = await mkUser("outsiderd");
      const bootE = await mkUser("boote");
      const listedF = await mkUser("listedf");
      const committeeG = await mkUser("committeeg");
      await mkGroup("admins", [adminA, adminB], { role: "namespace_admin", namespaceId: nsId });
      await mkGroup("members", [authorId, memberC], { role: "member", namespaceId: nsId });
      await mkGroup("committee", [committeeG], { role: "committee", namespaceId: otherNsId });
      const bootstrapGroup = await mkGroup("bootstrap", [bootE]);
      process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP = bootstrapGroup;

      // A fresh namespace challenge awaits triage, which only its author and the namespace's
      // admins (and platform admins) can see — the visibility split the fan-out must honour.
      const member = { userId: authorId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const created = await createChallenge(pool, member, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: `Fanout ${stamp}`,
        description: "d",
        clientName: null,
        visibility: "namespace",
        isAnonymous: false,
      });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const challengeId = created.challenge.id;
      await pool.query(`insert into challenge_access (challenge_id, user_id) values ($1, $2)`, [challengeId, listedF]);

      // ── The bulk resolver agrees with the per-user one for every shape of grant. ──
      const everyone = [authorId, adminA, adminB, memberC, outsiderD, bootE, listedF, committeeG];
      const shape = (roles: Awaited<ReturnType<typeof resolveRolesForUser>>) => ({
        isPlatformAdmin: roles.isPlatformAdmin,
        grants: roles.grants.map((r) => `${r.role}:${r.namespaceId}`).sort(),
        nsAdmin: roles.isNamespaceAdmin(nsId),
        committeeOther: roles.isCommittee(otherNsId),
        memberNs: roles.isMemberOf(nsId),
        memberOther: roles.isMemberOf(otherNsId),
        memberGlobal: roles.isMemberOf(globalId),
        accessList: roles.accessListChallenges().sort(),
      });
      const bulk = await resolveRolesForUsers([...everyone, adminA]); // a duplicate id is harmless
      assert.equal(bulk.size, everyone.length, "one entry per distinct user");
      for (const id of everyone) assert.deepEqual(shape(bulk.get(id)!), shape(await resolveRolesForUser(id)), `bulk roles match per-user roles for ${id}`);
      assert.equal(bulk.get(bootE)!.isPlatformAdmin, true, "the bootstrap group makes a platform admin");
      assert.ok(bulk.has(outsiderD), "a user with no grants still gets an entry");
      assert.deepEqual([bulk.get(outsiderD)!.isMemberOf(nsId), bulk.get(outsiderD)!.isMemberOf(globalId)], [false, true], "— the implicit global member only");
      assert.deepEqual(bulk.get(listedF)!.accessListChallenges(), [challengeId], "the §4.3 access list is resolved");
      assert.equal(bulk.get(committeeG)!.isCommittee(otherNsId), true);
      assert.equal((await resolveRolesForUsers([])).size, 0, "no ids → no queries, empty map");

      // ── dispatchEvent with the real resolver: who gets a row, and what the rows say. ──
      const scope = { parentType: "challenge" as const, parentId: challengeId };
      const facts = { kind: "status" as const, challengeNumber: "1", challengeTitle: `Fanout ${stamp}`, statusLabel: "In review" };
      const ctx = { pool, actorId: authorId, resolveRoles: resolveRolesForUser };
      const candidates = [authorId, adminA, adminB, adminA, null, memberC, outsiderD, bootE];
      await dispatchEvent(ctx, scope, candidates, "status_changed", { message: `bulk ${stamp}`, link: "/x" }, undefined, { event: 3, facts });

      const { rows: inbox } = await pool.query<{ id: string; user_id: string; target: string }>(
        `select id, user_id, concat(payload->>'parentType', ':', payload->>'parentId') as target
           from notifications where type = 'status_changed' and payload->>'message' = $1`,
        [`bulk ${stamp}`],
      );
      assert.deepEqual(inbox.map((r) => r.user_id).sort(), [adminA, adminB, bootE].sort(), "the actor, duplicates, nulls and non-viewers are dropped");
      for (const r of inbox) assert.equal(r.target, `challenge:${challengeId}`, "every row is targeted at the item");

      const { rows: outbox } = await pool.query<{ user_id: string; notification_id: string; digest: unknown; digest_due_at: Date | null }>(
        `select user_id, payload->>'notificationId' as notification_id, payload->'digest' as digest, digest_due_at
           from notification_outbox where type = 'status_changed' and payload->>'message' = $1`,
        [`bulk ${stamp}`],
      );
      assert.equal(outbox.length, inbox.length, "one outbox row per inbox row");
      const inboxIdOf = new Map(inbox.map((r) => [r.user_id, r.id]));
      for (const o of outbox) {
        assert.equal(o.notification_id, inboxIdOf.get(o.user_id), "each outbox row names its OWN recipient's inbox row");
        if (o.user_id === adminB) {
          assert.ok(o.digest_due_at, "the daily-digest recipient's row is held");
          assert.deepEqual(o.digest, facts, "and carries the digest facts");
        } else {
          assert.equal(o.digest_due_at, null, "an immediate recipient's row is not held");
          assert.equal(o.digest, null, "and carries no digest facts");
        }
      }

      // ── The fallback (a resolver without `many`) selects the same recipients. ──
      const plain = { pool, actorId: authorId, resolveRoles: async (id: string) => resolveRolesForUser(id) };
      await dispatchEvent(plain, scope, candidates, "status_changed", { message: `plain ${stamp}`, link: "/x" });
      const { rows: plainRows } = await pool.query<{ user_id: string }>(
        `select user_id from notifications where type = 'status_changed' and payload->>'message' = $1`,
        [`plain ${stamp}`],
      );
      assert.deepEqual(plainRows.map((r) => r.user_id).sort(), [adminA, adminB, bootE].sort());

      // ── Cost: fixed, whatever the recipient count. ──
      const manyAdmins = await Promise.all(Array.from({ length: 27 }, (_, i) => mkUser(`bulkadmin${i}`)));
      await mkGroup("bulkadmins", manyAdmins, { role: "namespace_admin", namespaceId: nsId });
      const measure = async (label: string, recipients: string[]) => {
        let queries = 0;
        let bulkCalls = 0;
        let singleCalls = 0;
        const countingPool = new Proxy(pool, {
          get(target, prop, receiver) {
            if (prop === "query") return (...args: Parameters<typeof pool.query>) => (queries++, (target.query as (...a: unknown[]) => unknown)(...args));
            return Reflect.get(target, prop, receiver);
          },
        });
        const resolveRoles = Object.assign(async (id: string) => (singleCalls++, resolveRolesForUser(id)), {
          many: async (ids: readonly string[]) => (bulkCalls++, resolveRolesForUsers(ids)),
        });
        await dispatchEvent({ pool: countingPool, actorId: authorId, resolveRoles }, scope, recipients, "status_changed", {
          message: `${label} ${stamp}`,
          link: "/x",
        });
        const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from notifications where payload->>'message' = $1`, [`${label} ${stamp}`]);
        return { queries, bulkCalls, singleCalls, written: Number(rows[0]!.n) };
      };
      const small = await measure("small", [adminA, adminB, bootE]);
      const large = await measure("large", [adminA, adminB, bootE, ...manyAdmins]);
      assert.equal(small.written, 3);
      assert.equal(large.written, 30);
      assert.equal(large.queries, small.queries, `the same number of queries for 30 recipients as for 3 (got ${large.queries} vs ${small.queries})`);
      assert.deepEqual([large.bulkCalls, large.singleCalls], [1, 0], "roles are resolved once, in bulk — never per recipient");
    } finally {
      if (bootstrapBefore === undefined) delete process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
      else process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP = bootstrapBefore;
      await pool.end();
    }
  },
);
