// Live-DB integration test (gated) for the two GDPR-erasure refusals added in v1.16 and the
// session stamp the erasure writes (INNOBOX_SPEC.md §3): the acting admin cannot erase their own
// account (`cannot_erase_self`); erasing a platform admin — resolved from role_mappings or the
// bootstrap group, exactly like lib/auth.ts — is refused while no OTHER active, not-erased
// platform admin exists (`last_platform_admin`) and allowed once one does; a refusal changes
// nothing; and a completed erasure stamps `users.sessions_valid_from` so every live session of
// the erased user is refused at its next request. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool as PoolType } from "pg";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { scrubUser } = await import("./store");
  return { Pool, randomUUID, scrubUser };
}

/** The last-admin rule is global by nature, and the DB suite shares one ephemeral database in
 *  which earlier suites seeded their own active platform admins. Deactivate every platform admin
 *  outside `keep` for the duration of `fn` (resolved with the SAME bootstrap-group env the store
 *  will see), then restore them — the suites run one at a time (--test-concurrency=1). */
async function withOnlyTheseAdmins(pool: PoolType, keep: string[], fn: () => Promise<void>): Promise<void> {
  const { getPlatformAdminUserIds } = await import("../../../lib/notify");
  const others = (await getPlatformAdminUserIds(pool)).filter((id) => !keep.includes(id));
  await pool.query(`update users set active = false where id = any($1::uuid[])`, [others]);
  try {
    await fn();
  } finally {
    await pool.query(`update users set active = true where id = any($1::uuid[])`, [others]);
  }
}

async function mkUser(pool: PoolType, label: string, stamp: string, opts: { active?: boolean; scrubbed?: boolean } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into users (external_id, user_name, display_name, email, active, scrubbed_at)
       values ($1, $2, $3, $4, $5, case when $6 then now() else null end) returning id`,
    [`dbtest-refuse-${label}-${stamp}`, `dbtest-refuse-${label}-${stamp}@example.test`, `Dbtest Refuse ${label} ${stamp}`, `refuse-${label}-${stamp}@example.test`, opts.active ?? true, opts.scrubbed ?? false],
  );
  return rows[0]!.id;
}

/** A SCIM-style group holding `members`, optionally mapped to platform_admin in role_mappings. */
async function mkGroup(pool: PoolType, label: string, stamp: string, members: string[], mapPlatformAdmin: boolean): Promise<string> {
  const externalId = `dbtest-refuse-grp-${label}-${stamp}`;
  const { rows } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [externalId]);
  for (const userId of members) await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [rows[0]!.id, userId]);
  if (mapPlatformAdmin) await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, 'platform_admin', null)`, [externalId]);
  return externalId;
}

async function snapshot(pool: PoolType, userId: string) {
  const { rows } = await pool.query<{ display_name: string; email: string | null; active: boolean; scrubbed_at: Date | null; sessions_valid_from: Date | null }>(
    `select display_name, email, active, scrubbed_at, sessions_valid_from from users where id = $1`,
    [userId],
  );
  return rows[0]!;
}

test("§3 cannot_erase_self: the acting admin's own account is refused before anything changes", { skip }, async () => {
  const { Pool, randomUUID, scrubUser } = await importDeps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const adminId = await mkUser(pool, "self", stamp);
    const before = await snapshot(pool, adminId);

    const result = await scrubUser(pool, adminId, adminId);
    assert.equal(result.status, "cannot_erase_self");
    // Case-insensitive on the ids, like the successor check: a route may pass the raw path segment.
    assert.equal((await scrubUser(pool, adminId.toUpperCase(), adminId)).status, "cannot_erase_self");

    assert.deepEqual(await snapshot(pool, adminId), before, "a refusal changes nothing on the row");
    const { rows: audit } = await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where action = 'user.scrubbed' and target_id = $1`, [adminId]);
    assert.equal(audit[0]!.n, "0", "nothing is audited for a refused erasure");
  } finally {
    await pool.end();
  }
});

test("§3 last_platform_admin: refused while no other active, not-erased platform admin exists (role_mappings)", { skip }, async () => {
  const { Pool, randomUUID, scrubUser } = await importDeps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    // The actor is NOT a platform admin here (the store does not gate on the actor's role — the
    // route does), which is the only way to reach the refusal with a consistent role resolver.
    const actorId = await mkUser(pool, "actor", stamp);
    const targetId = await mkUser(pool, "target", stamp);
    // Fellow members who do not count: a deactivated admin and an erased admin.
    const leaverId = await mkUser(pool, "leaver", stamp, { active: false });
    const erasedId = await mkUser(pool, "erased", stamp, { scrubbed: true });
    await mkGroup(pool, "admins", stamp, [targetId, leaverId, erasedId], true);
    const otherId = await mkUser(pool, "other", stamp);
    const memberId = await mkUser(pool, "member", stamp);
    const before = await snapshot(pool, targetId);

    await withOnlyTheseAdmins(pool, [targetId, otherId], async () => {
      const refused = await scrubUser(pool, actorId, targetId);
      assert.equal(refused.status, "last_platform_admin", "a deactivated or erased fellow admin does not count");
      assert.deepEqual(await snapshot(pool, targetId), before, "a refusal changes nothing on the row");

      // Another ACTIVE platform admin appears (a second mapped group) → allowed.
      await mkGroup(pool, "admins2", stamp, [otherId], true);
      const allowed = await scrubUser(pool, actorId, targetId);
      assert.equal(allowed.status, "ok");
      const after = await snapshot(pool, targetId);
      assert.equal(after.display_name, "Deleted User");
      assert.ok(after.scrubbed_at, "the erasure completed");

      // And now `other` is the last one — refused in turn, while a plain member is still erasable.
      assert.equal((await scrubUser(pool, actorId, otherId)).status, "last_platform_admin");
      assert.equal((await scrubUser(pool, actorId, memberId)).status, "ok", "a non-admin is never caught by the admin rule");
    });
  } finally {
    await pool.end();
  }
});

test("§3 last_platform_admin: the bootstrap admin group counts exactly like a platform_admin mapping", { skip }, async () => {
  const { Pool, randomUUID, scrubUser } = await importDeps();
  const pool = new Pool({ connectionString: url });
  const previous = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
  try {
    const stamp = randomUUID().slice(0, 8);
    const actorId = await mkUser(pool, "bactor", stamp);
    const targetId = await mkUser(pool, "btarget", stamp);
    // Membership of the bootstrap group only — no role_mappings row at all.
    process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP = await mkGroup(pool, "bootstrap", stamp, [targetId], false);
    const otherId = await mkUser(pool, "bother", stamp);

    await withOnlyTheseAdmins(pool, [targetId, otherId], async () => {
      assert.equal((await scrubUser(pool, actorId, targetId)).status, "last_platform_admin", "the sole bootstrap admin is the last platform admin");

      // A second active bootstrap member → the first becomes erasable.
      const { rows: g } = await pool.query<{ id: string }>(`select id from groups where external_id = $1`, [process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP]);
      await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [g[0]!.id, otherId]);
      assert.equal((await scrubUser(pool, actorId, targetId)).status, "ok");

      // With the bootstrap group unset the remaining member holds no role: a plain erasure.
      delete process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
      assert.equal((await scrubUser(pool, actorId, otherId)).status, "ok", "no bootstrap group configured → no bootstrap admins");
    });
  } finally {
    if (previous === undefined) delete process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;
    else process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP = previous;
    await pool.end();
  }
});

test("§3 refusal order: self comes before the last-admin rule, and both come before the successor check", { skip }, async () => {
  const { Pool, randomUUID, scrubUser } = await importDeps();
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const soleAdminId = await mkUser(pool, "sole", stamp);
    await mkGroup(pool, "sole", stamp, [soleAdminId], true);
    const actorId = await mkUser(pool, "oactor", stamp);
    const neverResolved = async () => {
      throw new Error("never resolved");
    };
    await withOnlyTheseAdmins(pool, [soleAdminId], async () => {
      // Self AND last admin AND an ineligible successor (the target itself): self wins.
      const self = await scrubUser(pool, soleAdminId, soleAdminId, { successorId: soleAdminId, resolveRoles: neverResolved });
      assert.equal(self.status, "cannot_erase_self");
      // Someone else erasing the sole admin with an ineligible successor: the admin rule wins.
      const last = await scrubUser(pool, actorId, soleAdminId, { successorId: soleAdminId, resolveRoles: neverResolved });
      assert.equal(last.status, "last_platform_admin");
    });
  } finally {
    await pool.end();
  }
});

test("§3 a completed erasure stamps sessions_valid_from, so every live session of the erased user is refused", { skip }, async () => {
  const { Pool, randomUUID, scrubUser } = await importDeps();
  const { isSessionRevoked, nowInSeconds } = await import("../../../lib/session-revocation");
  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const adminId = await mkUser(pool, "sadmin", stamp);
    const victimId = await mkUser(pool, "svictim", stamp);
    assert.equal((await snapshot(pool, victimId)).sessions_valid_from, null, "never stamped before the erasure");
    // A token the victim minted a minute ago, on some other device.
    const issuedAt = nowInSeconds() - 60;

    assert.equal((await scrubUser(pool, adminId, victimId)).status, "ok");

    const after = await snapshot(pool, victimId);
    assert.ok(after.sessions_valid_from instanceof Date, "the erasure stamps sessions_valid_from");
    assert.equal(isSessionRevoked({ issuedAt, sessionsValidFrom: after.sessions_valid_from }), true, "the older token is no session");
    assert.equal(after.active, false, "the active flip still happens — the stamp closes the window to the next request, nothing more");
  } finally {
    await pool.end();
  }
});
