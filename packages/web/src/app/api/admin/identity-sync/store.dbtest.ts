// Live-DB integration test (gated) for GET /api/admin/identity-sync (INNOBOX_SPEC.md §14.10): the
// response shape, what each count includes and excludes (JIT/reconciliation rows, scrubbed rows,
// reconciliation-mirrored groups), the "mapped groups that never arrived" list (the role-mapping
// "Dead" test), the last accepted / last rejected SCIM request, and the RBAC gate — a namespace
// admin gets 403, a platform admin the summary. Counts are global to the database, so the
// assertions compare deltas around this suite's own rows. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

type Role = "platform_admin" | "namespace_admin" | "committee" | "member";

test(
  "identity sync: summary shape, inclusion rules and the platform-admin gate",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, SCIM_LAST_REQUEST_AT_KEY } = await import("@innobox/shared");
    const { identitySyncSummary, SCIM_SYSTEM_LOG_ROUTE } = await import("./store");
    const { handleIdentitySyncGet } = await import("./handler");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const before = await identitySyncSummary(pool);

      // ── users: only SCIM-written, non-scrubbed rows count ────────────────────────────
      const user = async (suffix: string, scimSynced: boolean, active: boolean, scrubbed = false) =>
        (
          await pool.query<{ id: string }>(
            `insert into users (external_id, user_name, display_name, email, scim_synced, active, deactivated_at, scrubbed_at)
             values ($1, $2, $3, $4, $5, $6, case when $6 then null else now() end, case when $7 then now() else null end)
             returning id`,
            [`idsync-${stamp}-${suffix}`, `idsync-${stamp}-${suffix}@example.test`, `Idsync ${suffix}`, `idsync-${stamp}-${suffix}@example.test`, scimSynced, active, scrubbed],
          )
        ).rows[0]!.id;
      await user("scim-active", true, true);
      await user("scim-inactive", true, false);
      await user("jit-stub", false, true); // JIT stub / reconciliation-created — proves sign-in, not SCIM
      await user("scrubbed", true, false, true);

      // ── groups: SCIM-provisioned only; a reconciliation mirror (default false) does not count ──
      const group = async (suffix: string, scimSynced: boolean) =>
        (
          await pool.query<{ id: string }>(`insert into groups (external_id, display_name, scim_synced) values ($1, $2, $3) returning id`, [
            `idsync-${stamp}-${suffix}`,
            `Idsync ${suffix}`,
            scimSynced,
          ])
        ).rows[0]!.id;
      const scimGroupId = await group("scim-group", true);
      const mirrorGroupId = await group("mirror-group", false);

      // ── role mappings: one onto a mirrored group (arrived), three onto groups that never did ──
      const { rows: ns } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, $2) returning id`,
        [`idsync-${stamp}`, `Idsync NS ${stamp}`],
      );
      const nsId = ns[0]!.id;
      const mapping = (groupExternalId: string, role: Role, namespaceId: string | null) =>
        pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, $2, $3)`, [groupExternalId, role, namespaceId]);
      await mapping(`idsync-${stamp}-mirror-group`, "committee", nsId); // the group exists (reconciliation) → arrived
      await mapping(`idsync-${stamp}-scim-group`, "namespace_admin", nsId);
      const ghost = `idsync-${stamp}-ghost`;
      await mapping(ghost, "namespace_admin", nsId);
      await mapping(ghost, "committee", nsId);
      const platformGhost = `idsync-${stamp}-ghost-platform`;
      await mapping(platformGhost, "platform_admin", null);

      // ── SCIM last accepted / last rejected ──────────────────────────────────────────
      const acceptedAt = "2026-10-08T09:30:00.000Z";
      await pool.query(
        `insert into platform_settings (key, value, updated_at) values ($1, to_jsonb($2::text), now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [SCIM_LAST_REQUEST_AT_KEY, acceptedAt],
      );
      // Real insertion times (never future-dated — other suites count events "newer than now"),
      // each statement its own transaction so the later rows are strictly newer.
      const marker = `idsync ${stamp}`;
      const { rows: rejected } = await pool.query<{ created_at: Date }>(
        `insert into system_events (status, method, route, path, error_code, message, source)
         values (401, 'GET', $1, '/scim/v2/Users', 'scim_unauthorized', $2, 'worker')
         returning created_at`,
        [SCIM_SYSTEM_LOG_ROUTE, marker],
      );
      await new Promise((r) => setTimeout(r, 5));
      // A newer worker 403 from a webhook receiver must not pose as a rejected SCIM call, and a
      // web-tier 403 neither.
      await pool.query(
        `insert into system_events (status, method, route, path, error_code, message, source)
         values (403, 'POST', '/webhooks/[namespace]', '/webhooks/x', 'webhook_http_error', $1, 'worker')`,
        [marker],
      );
      await pool.query(
        `insert into system_events (status, method, route, path, message, source)
         values (403, 'GET', '/api/admin/identity-sync', '/api/admin/identity-sync', $1, 'web')`,
        [marker],
      );

      const after = await identitySyncSummary(pool);
      assert.deepEqual(Object.keys(after).sort(), [
        "groups",
        "lastRejectedScimRequestAt",
        "lastScimRequestAt",
        "state",
        "unarrivedMappedGroups",
        "users",
      ]);
      assert.equal(after.users.active - before.users.active, 1, "only the SCIM-written active user counts");
      assert.equal(after.users.deactivated - before.users.deactivated, 1, "scrubbed rows are excluded");
      assert.equal(after.groups - before.groups, 1, "a reconciliation mirror does not count as provisioned");
      assert.equal(after.state, "ok", "users and groups both present");
      assert.equal(after.lastScimRequestAt, acceptedAt);
      assert.equal(after.lastRejectedScimRequestAt, rejected[0]!.created_at.toISOString());

      const mine = after.unarrivedMappedGroups.filter((g) => g.groupExternalId.startsWith(`idsync-${stamp}-`));
      assert.deepEqual(mine, [
        { groupExternalId: ghost, role: "committee", namespaceId: nsId, namespaceName: `Idsync NS ${stamp}` },
        { groupExternalId: ghost, role: "namespace_admin", namespaceId: nsId, namespaceName: `Idsync NS ${stamp}` },
        { groupExternalId: platformGhost, role: "platform_admin", namespaceId: null, namespaceName: null },
      ]);
      assert.ok(mirrorGroupId, "the mirrored group exists, so its mapping is not listed");

      // ── RBAC: the route's gate is requirePlatformAdmin over DB-resolved roles ─────────
      const { rows: globalNs } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalNamespaceId = globalNs[0]!.id;
      const resolveRoles = async (userId: string) => {
        const { rows } = await pool.query<{ role: Role; namespace_id: string | null }>(
          `select rm.role, rm.namespace_id
             from group_members gm join groups g on g.id = gm.group_id
             join role_mappings rm on rm.group_external_id = g.external_id
            where gm.user_id = $1`,
          [userId],
        );
        return buildRoleSet(rows.map((r) => ({ role: r.role, namespaceId: r.namespace_id })), { globalNamespaceId });
      };
      // Mirrors lib/auth requirePlatformAdmin (which loads next-auth and so cannot be imported here).
      const gateFor = (userId: string) => async () => {
        const roles = await resolveRoles(userId);
        if (!roles.isPlatformAdmin) return { ok: false as const, response: Response.json({ error: "forbidden" }, { status: 403 }) };
        return {
          ok: true as const,
          user: { id: userId, externalId: userId, userName: userId, displayName: userId, email: null, emailNotificationsEnabled: true, quickStartSeenAt: null, roles },
        };
      };

      const nsAdminId = await user("ns-admin", true, true);
      await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [scimGroupId, nsAdminId]);
      const nsRoles = await resolveRoles(nsAdminId);
      assert.ok(nsRoles.isNamespaceAdmin(nsId) && !nsRoles.isPlatformAdmin, "the fixture really is a namespace admin");
      const refused = await handleIdentitySyncGet(gateFor(nsAdminId), pool);
      assert.equal(refused.status, 403, "namespace admins are refused");
      assert.deepEqual(await refused.json(), { error: "forbidden" });

      const adminGroupExternal = `idsync-${stamp}-platform`;
      const adminGroupId = (
        await pool.query<{ id: string }>(`insert into groups (external_id, display_name, scim_synced) values ($1, 'Idsync platform', true) returning id`, [adminGroupExternal])
      ).rows[0]!.id;
      await mapping(adminGroupExternal, "platform_admin", null);
      const adminId = await user("platform-admin", true, true);
      await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [adminGroupId, adminId]);
      const ok = await handleIdentitySyncGet(gateFor(adminId), pool);
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as Awaited<ReturnType<typeof identitySyncSummary>>;
      assert.equal(typeof body.users.active, "number");
      assert.equal(body.lastScimRequestAt, acceptedAt);
      assert.ok(Array.isArray(body.unarrivedMappedGroups));
      assert.ok(!body.unarrivedMappedGroups.some((g) => g.groupExternalId === adminGroupExternal), "an arrived group is not listed");

      // Leave no system-log rows behind for the suites that follow.
      await pool.query(`delete from system_events where message = $1`, [marker]);
    } finally {
      await pool.end();
    }
  },
);
