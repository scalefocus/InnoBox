// Live-DB integration test (gated) for the database half of the §2.3 bootstrap-admin notice
// (INNOBOX_SPEC.md): `countPlatformAdminMappings` counts only `platform_admin` rows, and combined
// with the environment variable through `bootstrapAdminGroupActive` it flips the flag exactly
// when a platform_admin mapping appears. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "countPlatformAdminMappings counts platform_admin rows only, and the notice flag follows it",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { countPlatformAdminMappings } = await import("./store");
    const { bootstrapAdminGroupActive } = await import("./bootstrap-admin");

    const pool = new Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      // Inside one rolled-back transaction, so the shared test database keeps whatever platform
      // admin mappings it already has — the assertions are relative to the starting count.
      await client.query("begin");
      const before = await countPlatformAdminMappings(client);
      const group = randomUUID();

      // A namespace-scoped mapping is not a platform_admin one.
      const { rows: ns } = await client.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      await client.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, 'namespace_admin', $2)`, [group, ns[0]!.id]);
      assert.equal(await countPlatformAdminMappings(client), before, "a namespace_admin mapping does not count");

      await client.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, 'platform_admin', null)`, [group]);
      const after = await countPlatformAdminMappings(client);
      assert.equal(after, before + 1);

      // The notice flag: set variable + the mapping → active; unset variable → never.
      assert.equal(bootstrapAdminGroupActive(group, after), true);
      assert.equal(bootstrapAdminGroupActive(undefined, after), false);
      assert.equal(bootstrapAdminGroupActive(group, 0), false);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
      await pool.end();
    }
  },
);
