// Live-DB integration test (gated) for the /api/admin data layer (ENTRA_AUTH_SPEC.md §5
// layer 3): namespace CRUD-lite + role mappings against a real Postgres with
// db/migrations applied, including the audit trail every mutation must leave. Self-skips
// when DATABASE_URL is unset so the hermetic unit stage stays green. Namespaces/users are
// never hard-deleted by the app (§4 grants), so this test leaves its rows behind (archived
// where applicable) rather than cleaning up — routine for a throwaway/dev database.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "namespaces CRUD-lite and role mappings, audited end to end",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const {
      createNamespace,
      listNamespaces,
      patchNamespace,
      createRoleMapping,
      listRoleMappings,
      deleteRoleMapping,
    } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);

      // An actor row satisfying audit_log's actor_user_id FK (0003_identity.sql).
      const { rows: actorRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name)
         values ($1, $2, 'Store Dbtest Actor')
         returning id`,
        [`dbtest-actor-${stamp}`, `dbtest-actor-${stamp}@example.test`],
      );
      const actorId = actorRows[0]!.id;

      // 1. Create a namespace; duplicate slug ('global') is rejected with null, not a throw.
      const slug = `dbtest-${stamp}`;
      const created = await createNamespace(pool, { slug, displayName: "Dbtest NS" }, actorId);
      assert.ok(created, "namespace was created");
      assert.equal(created!.slug, slug);
      assert.equal(created!.archivedAt, null);

      const dup = await createNamespace(pool, { slug: "global", displayName: "Nope" }, actorId);
      assert.equal(dup, null, "the seeded 'global' slug cannot be recreated");

      const listed = await listNamespaces(pool);
      assert.ok(listed.some((ns) => ns.id === created!.id));

      // 2. Rename — audited namespace.renamed.
      const renamed = await patchNamespace(pool, created!.id, { displayName: "Renamed NS" }, actorId);
      assert.equal(renamed.status, "ok");
      if (renamed.status === "ok") assert.equal(renamed.namespace.displayName, "Renamed NS");
      await assertAudited(pool, "namespace.renamed", created!.id);

      // 3. Archive — audited namespace.archived.
      const archived = await patchNamespace(pool, created!.id, { archived: true }, actorId);
      assert.equal(archived.status, "ok");
      if (archived.status === "ok") assert.ok(archived.namespace.archivedAt);
      await assertAudited(pool, "namespace.archived", created!.id);

      // 4. Unarchive — audited namespace.unarchived.
      const unarchived = await patchNamespace(pool, created!.id, { archived: false }, actorId);
      assert.equal(unarchived.status, "ok");
      if (unarchived.status === "ok") assert.equal(unarchived.namespace.archivedAt, null);
      await assertAudited(pool, "namespace.unarchived", created!.id);

      // 5. The built-in global namespace can never be archived.
      const { rows: globalRows } = await pool.query<{ id: string }>(
        `select id from namespaces where slug = 'global'`,
      );
      const globalId = globalRows[0]!.id;
      const globalArchiveAttempt = await patchNamespace(pool, globalId, { archived: true }, actorId);
      assert.equal(globalArchiveAttempt.status, "global_archive");

      // Leave the dbtest namespace archived (there is no DELETE grant on namespaces).
      await patchNamespace(pool, created!.id, { archived: true }, actorId);

      // 6. Role mapping: create against an unknown namespace id -> unknown_namespace.
      const unknownNs = await createRoleMapping(
        pool,
        { groupExternalId: `dbtest-grp-${stamp}`, role: "member", namespaceId: randomUUID() },
        actorId,
      );
      assert.equal(unknownNs.status, "unknown_namespace");

      // 7. Create against the real namespace -> ok, dead (no synced group locally), audited.
      const mapping = await createRoleMapping(
        pool,
        { groupExternalId: `dbtest-grp-${stamp}`, role: "member", namespaceId: created!.id },
        actorId,
      );
      assert.equal(mapping.status, "ok");
      if (mapping.status === "ok") {
        assert.equal(mapping.mapping.dead, true);
        assert.equal(mapping.mapping.groupDisplayName, null);
        assert.equal(mapping.mapping.namespaceSlug, slug);
      }
      await assertAudited(pool, "role_mapping.created", mapping.status === "ok" ? mapping.mapping.id : "");

      // 8. Duplicate (group, role, namespace) triple -> duplicate, not a constraint throw.
      const duplicateMapping = await createRoleMapping(
        pool,
        { groupExternalId: `dbtest-grp-${stamp}`, role: "member", namespaceId: created!.id },
        actorId,
      );
      assert.equal(duplicateMapping.status, "duplicate");

      const mappings = await listRoleMappings(pool);
      assert.ok(mappings.some((m) => m.id === (mapping.status === "ok" ? mapping.mapping.id : null)));

      // 9. Delete — audited role_mapping.deleted; deleting again reports false, not an error.
      if (mapping.status === "ok") {
        const deleted = await deleteRoleMapping(pool, mapping.mapping.id, actorId);
        assert.equal(deleted, true);
        await assertAudited(pool, "role_mapping.deleted", mapping.mapping.id);

        const deletedAgain = await deleteRoleMapping(pool, mapping.mapping.id, actorId);
        assert.equal(deletedAgain, false);
      }
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

async function assertAudited(pool: import("pg").Pool, action: string, targetId: string): Promise<void> {
  const { rows } = await pool.query(
    `select 1 from audit_log where action = $1 and target_id = $2 order by id desc limit 1`,
    [action, targetId],
  );
  assert.equal(rows.length, 1, `expected an audit_log row for ${action} / ${targetId}`);
}
