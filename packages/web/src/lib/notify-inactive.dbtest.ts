// Live-DB integration test (gated) for the §12.1 rule that a deactivated or erased user is never
// a recipient (INNOBOX_SPEC.md §12.1, ENTRA_AUTH_SPEC.md §2 leaver semantics):
//  - dispatchEvent drops a deactivated (`active = false`) and an erased (`scrubbed_at` set)
//    candidate at insert time — neither the inbox row nor the outbox row is written — while an
//    active candidate who can see the item gets both;
//  - the role-resolving helpers (namespace admins, committee) return active, not-erased users
//    only, as the platform-admin helper already did — a leaver keeps their group memberships,
//    so this is the one filter between them and every admin/committee event.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§12.1 deactivated or erased users are never recipients: dropped at insert, excluded from the role helpers",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { dispatchEvent, getNamespaceAdminUserIds, getNamespaceCommitteeUserIds, getPlatformAdminUserIds } = await import("./notify");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Inactive NS') returning id`, [
        `dbtest-inactive-${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string, state: "active" | "deactivated" | "erased") => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email, active, scrubbed_at)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [
            `dbtest-inactive-${label}-${stamp}`,
            `dbtest-inactive-${label}-${stamp}@example.test`,
            `Dbtest Inactive ${label}`,
            `inactive-${label}-${stamp}@example.test`,
            state !== "deactivated",
            state === "erased" ? new Date() : null,
          ],
        );
        return rows[0]!.id;
      };
      const actor = await mkUser("actor", "active");
      const keen = await mkUser("keen", "active");
      const leaver = await mkUser("leaver", "deactivated");
      const erased = await mkUser("erased", "erased");

      // ── dispatchEvent: the drop happens before any row is written ──
      const { rows: ch } = await pool.query<{ id: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'inactive recipients', $3, $4, 'valid') returning id`,
        [globalId, `Inactive ${stamp}`, ia[0]!.id, actor],
      );
      const challengeId = ch[0]!.id;
      const resolveRoles = async () => buildRoleSet([], { globalNamespaceId: globalId });
      await dispatchEvent(
        { pool, actorId: actor, resolveRoles },
        { parentType: "challenge", parentId: challengeId },
        [keen, leaver, erased, actor],
        "status_changed",
        { message: `Inactive ${stamp}`, link: "/challenges/1" },
      );
      const counts = async (userId: string) => {
        const { rows } = await pool.query<{ inbox: string; outbox: string }>(
          `select (select count(*) from notifications where user_id = $1)::text as inbox,
                  (select count(*) from notification_outbox where user_id = $1)::text as outbox`,
          [userId],
        );
        return { inbox: Number(rows[0]!.inbox), outbox: Number(rows[0]!.outbox) };
      };
      assert.deepEqual(await counts(keen), { inbox: 1, outbox: 1 }, "an active recipient gets the inbox row and the outbox row");
      assert.deepEqual(await counts(leaver), { inbox: 0, outbox: 0 }, "a deactivated user gets neither row");
      assert.deepEqual(await counts(erased), { inbox: 0, outbox: 0 }, "an erased user gets neither row");
      assert.deepEqual(await counts(actor), { inbox: 0, outbox: 0 }, "the actor never notifies themself");

      // ── the role helpers: group membership alone is not enough ──
      const mkGroup = async (label: string, members: string[], role: string, namespaceId: string | null) => {
        const externalId = `dbtest-inactive-grp-${label}-${stamp}`;
        const { rows } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [externalId]);
        for (const userId of members) await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [rows[0]!.id, userId]);
        await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, $2, $3)`, [externalId, role, namespaceId]);
        return externalId;
      };
      await mkGroup("admins", [keen, leaver, erased], "namespace_admin", nsId);
      await mkGroup("committee", [keen, leaver, erased], "committee", nsId);
      const bootstrapGroup = await mkGroup("platform", [keen, leaver, erased], "platform_admin", null);

      const only = (ids: string[]) => ids.filter((id) => [keen, leaver, erased].includes(id)).sort();
      assert.deepEqual(only(await getNamespaceAdminUserIds(pool, nsId)), [keen], "namespace admins: the leaver and the erased member are excluded");
      assert.deepEqual(only(await getNamespaceCommitteeUserIds(pool, nsId)), [keen], "committee: the leaver and the erased member are excluded");
      assert.deepEqual(only(await getPlatformAdminUserIds(pool, bootstrapGroup)), [keen], "platform admins: as before");
    } finally {
      await pool.end();
    }
  },
);
