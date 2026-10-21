// Live-DB integration test (gated) for role resolution in ONE statement (INNOBOX_SPEC.md §4.2
// *Resolution*, ENTRA_AUTH_SPEC.md "Role staleness", invariant 1):
//  - the session row and its roles come back from a single round trip — grants from SCIM-synced
//    group membership + role_mappings, the bootstrap group's implicit platform_admin while it is
//    set, the §4.3 `people` access list, and the implicit `global` membership;
//  - the bulk resolver returns the same RoleSet for each id, in one round trip whatever the count,
//    and an id with no user row still gets the implicit-member RoleSet;
//  - a role or access change is visible on the next resolution (nothing is cached);
//  - an unknown oid resolves to null.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§4.2 role resolution: one statement per resolution, same grants as before, nothing cached",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { loadSessionRow, resolveRoleSets, bootstrapAdminGroup } = await import("./role-resolution");

    const pool = new Pool({ connectionString: url });
    // Counts round trips without changing behaviour.
    let roundTrips = 0;
    const counted = {
      query: (...args: unknown[]) => {
        roundTrips++;
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      },
    } as unknown as import("pg").Pool;

    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Roles NS') returning id`, [
        `dbtest-roles-${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);

      const mkUser = async (label: string) => {
        const oid = `dbtest-roles-${label}-${stamp}`;
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
          [oid, `${oid}@example.test`, `Dbtest Roles ${label}`, `roles-${label}-${stamp}@example.test`],
        );
        return { id: rows[0]!.id, oid };
      };
      const mkGroup = async (label: string) => {
        const ext = `dbtest-roles-grp-${label}-${stamp}`;
        const { rows } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $2) returning id`, [ext, ext]);
        return { id: rows[0]!.id, ext };
      };
      const join = (groupId: string, userId: string) => pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [groupId, userId]);

      const admins = await mkGroup("nsadmins");
      const committee = await mkGroup("committee");
      const boot = await mkGroup("bootstrap");
      await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, 'namespace_admin', $2)`, [admins.ext, nsId]);
      await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, 'committee', $2)`, [committee.ext, nsId]);
      // The bootstrap group has NO role mapping: it grants platform_admin only through the env.

      const alice = await mkUser("alice"); // namespace admin + committee, on one access list
      const bob = await mkUser("bob"); // bootstrap group member only
      const carol = await mkUser("carol"); // nothing at all
      await join(admins.id, alice.id);
      await join(committee.id, alice.id);
      await join(boot.id, bob.id);

      const { rows: ch } = await pool.query<{ id: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'people', $2, 'roles fixture', $3, $4, 'valid') returning id`,
        [nsId, `Roles ${stamp}`, ia[0]!.id, carol.id],
      );
      const challengeId = ch[0]!.id;
      await pool.query(`insert into challenge_access (challenge_id, user_id) values ($1, $2)`, [challengeId, alice.id]);

      // ── the session row: one round trip, everything on it ───────────────────────────────
      roundTrips = 0;
      const a = await loadSessionRow(counted, alice.oid, null);
      assert.equal(roundTrips, 1, "the user row and its roles are ONE statement");
      assert.ok(a);
      assert.equal(a.id, alice.id);
      assert.equal(a.active, true);
      assert.equal(a.roles.isPlatformAdmin, false);
      assert.equal(a.roles.isNamespaceAdmin(nsId), true);
      assert.equal(a.roles.isCommittee(nsId), true);
      assert.equal(a.roles.isMemberOf(globalId), true, "every user is an implicit member of global");
      assert.deepEqual(a.roles.accessListChallenges(), [challengeId]);
      assert.equal(a.roles.isOnAccessList(challengeId), true);

      // The bootstrap group counts only while the env names it.
      roundTrips = 0;
      const bOff = await loadSessionRow(counted, bob.oid, null);
      const bOn = await loadSessionRow(counted, bob.oid, boot.ext);
      assert.equal(roundTrips, 2, "one statement each, bootstrap or not");
      assert.equal(bOff!.roles.isPlatformAdmin, false);
      assert.equal(bOn!.roles.isPlatformAdmin, true);
      assert.equal(bootstrapAdminGroup({}), null);
      assert.equal(bootstrapAdminGroup({ INNOBOX_BOOTSTRAP_ADMIN_GROUP: "" }), null);
      assert.equal(bootstrapAdminGroup({ INNOBOX_BOOTSTRAP_ADMIN_GROUP: boot.ext }), boot.ext);

      const c = await loadSessionRow(pool, carol.oid, null);
      assert.deepEqual(
        c!.roles.grants.map((x) => x.role),
        ["member"],
        "no grants → just the implicit global membership",
      );
      assert.equal(await loadSessionRow(pool, `dbtest-roles-nobody-${stamp}`, null), null);

      // A deactivated row still loads — the caller (lib/auth.ts) applies the active check.
      await pool.query(`update users set active = false where id = $1`, [carol.id]);
      assert.equal((await loadSessionRow(pool, carol.oid, null))!.active, false);

      // ── bulk: one round trip for many ids, identical RoleSets ────────────────────────────
      const ghost = randomUUID(); // no user row at all
      roundTrips = 0;
      const many = await resolveRoleSets(counted, [alice.id, bob.id, carol.id, ghost, alice.id], boot.ext);
      assert.equal(roundTrips, 1, "bulk resolution is ONE statement whatever the count");
      assert.equal(many.size, 4, "deduplicated, and every id gets an entry");
      const describe = (r: import("@innobox/shared").RoleSet) => ({
        pa: r.isPlatformAdmin,
        nsAdmin: r.isNamespaceAdmin(nsId),
        committee: r.isCommittee(nsId),
        access: r.accessListChallenges(),
        global: r.isMemberOf(globalId),
      });
      assert.deepEqual(describe(many.get(alice.id)!), describe(a.roles));
      assert.deepEqual(describe(many.get(bob.id)!), describe(bOn!.roles));
      assert.deepEqual(describe(many.get(ghost)!), { pa: false, nsAdmin: false, committee: false, access: [], global: true });
      roundTrips = 0;
      assert.equal((await resolveRoleSets(counted, [], null)).size, 0);
      assert.equal(roundTrips, 0, "an empty list costs nothing");

      // ── nothing is cached: a change shows on the next resolution ─────────────────────────
      await pool.query(`delete from group_members where group_id = $1 and user_id = $2`, [admins.id, alice.id]);
      await pool.query(`delete from challenge_access where challenge_id = $1 and user_id = $2`, [challengeId, alice.id]);
      const after = await loadSessionRow(pool, alice.oid, null);
      assert.equal(after!.roles.isNamespaceAdmin(nsId), false);
      assert.equal(after!.roles.isCommittee(nsId), true);
      assert.deepEqual(after!.roles.accessListChallenges(), []);
    } finally {
      await pool.end();
    }
  },
);
