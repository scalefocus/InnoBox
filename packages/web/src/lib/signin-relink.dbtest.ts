// Live-DB integration test (gated) for the §3 sign-in relink (INNOBOX_SPEC.md): a never-used
// SCIM row with a mismatched external id is re-keyed to the oid (audited `user.relinked`, no
// JIT stub, roles/ownership kept); every holder the relink does not cover (used, deactivated,
// JIT stub, erased) refuses the sign-in with a §14.7 `signin_upn_conflict` row naming ids only;
// a later SCIM PUT that rewrites the external id back makes the next sign-in refuse, not
// relink again. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "sign-in relink: relink success, refusals with a system-log row, no duplicate stub",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { resolveEntraSignIn } = await import("./signin-relink");
    const { recordSystemEvent } = await import("../app/api/admin/system-log/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const deps = { recordConflict: (event: Parameters<typeof recordSystemEvent>[1]) => recordSystemEvent(pool, event) };

      type Seed = { scimSynced: boolean; active?: boolean; used?: boolean; scrubbed?: boolean };
      const seed = async (label: string, s: Seed) => {
        const upn = `dbtest-relink-${label}-${stamp}@example.test`;
        const { rows } = await pool.query<{ id: string; external_id: string }>(
          `insert into users (external_id, user_name, email, display_name, scim_synced, active, last_seen_at, scrubbed_at)
           values ($1, $2, $2, $3, $4, $5, case when $6 then now() else null end, case when $7 then now() else null end)
           returning id, external_id`,
          [`scim-mismatch-${label}-${stamp}`, upn, `Dbtest Relink ${label}`, s.scimSynced, s.active ?? true, Boolean(s.used), Boolean(s.scrubbed)],
        );
        return { id: rows[0]!.id, externalId: rows[0]!.external_id, upn };
      };
      const usersHolding = async (upn: string) =>
        (await pool.query<{ id: string; external_id: string }>(`select id, external_id from users where lower(user_name) = lower($1)`, [upn])).rows;
      const usersWithOid = async (oid: string) =>
        (await pool.query<{ id: string }>(`select id from users where external_id = $1`, [oid])).rows;
      const conflictRows = async (needle: string) =>
        (
          await pool.query<{ status: number; route: string; path: string; user_id: string | null; actor_name: string | null; actor_email: string | null; message: string }>(
            `select status, route, path, user_id, actor_name, actor_email, message
               from system_events where error_code = 'signin_upn_conflict' and message like '%' || $1 || '%'`,
            [needle],
          )
        ).rows;

      // ── Relink success ────────────────────────────────────────────────────────────────
      const target = await seed("ok", { scimSynced: true });
      // Give the SCIM row something it must keep: a group membership (roles come from groups).
      const { rows: g } = await pool.query<{ id: string }>(
        `insert into groups (external_id, display_name) values ($1, $2) returning id`,
        [`dbtest-relink-group-${stamp}`, `Dbtest Relink ${stamp}`],
      );
      await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [g[0]!.id, target.id]);
      const oid = randomUUID();
      const r1 = await resolveEntraSignIn(
        pool,
        { oid, preferredUsername: target.upn.toUpperCase(), email: "claims@example.test", name: "Claims Name" },
        deps,
      );
      assert.equal(r1.ok, true);
      assert.ok(r1.ok && r1.relinked, "relinked");
      assert.equal(r1.ok && r1.user.id, target.id, "the SCIM row is the signed-in user");
      assert.deepEqual(await usersWithOid(oid), [{ id: target.id }], "no JIT stub — one row per oid");
      assert.equal((await usersHolding(target.upn)).length, 1, "one row per UPN");
      const { rows: after } = await pool.query<{ display_name: string; email: string; scim_synced: boolean }>(
        `select display_name, email, scim_synced from users where id = $1`,
        [target.id],
      );
      assert.deepEqual(after[0], { display_name: "Dbtest Relink ok", email: target.upn, scim_synced: true }, "claims never overwrite a SCIM row");
      const { rows: gm } = await pool.query(`select 1 from group_members where user_id = $1`, [target.id]);
      assert.equal(gm.length, 1, "memberships (roles) kept");
      const { rows: audit } = await pool.query<{ actor_user_id: string; target_id: string; before: unknown; after: unknown }>(
        `select actor_user_id, target_id, before, after from audit_log where action = 'user.relinked' and target_id = $1`,
        [target.id],
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actor_user_id, target.id, "actor = the relinked user");
      assert.deepEqual(audit[0]!.before, { externalId: target.externalId });
      assert.deepEqual(audit[0]!.after, { externalId: oid });
      const { rows: jit } = await pool.query(`select 1 from audit_log where action = 'user.jit_created' and target_id = $1`, [target.id]);
      assert.equal(jit.length, 0, "no user.jit_created");

      // A second sign-in finds the row by oid: no second relink, no new audit row.
      const r1b = await resolveEntraSignIn(pool, { oid, preferredUsername: target.upn }, deps);
      assert.ok(r1b.ok && !r1b.relinked && r1b.user.id === target.id);
      const { rows: audit2 } = await pool.query(`select 1 from audit_log where action = 'user.relinked' and target_id = $1`, [target.id]);
      assert.equal(audit2.length, 1);

      // ── Refusals: holders the relink does not cover ───────────────────────────────────
      const refusals: Array<[string, Seed]> = [
        ["used", { scimSynced: true, used: true }], // UPN reuse guard
        ["inactive", { scimSynced: true, active: false }],
        ["stub", { scimSynced: false }], // JIT / reconciliation-created
        ["scrubbed", { scimSynced: true, scrubbed: true }],
      ];
      for (const [label, s] of refusals) {
        const holder = await seed(label, s);
        const newOid = randomUUID();
        const r = await resolveEntraSignIn(pool, { oid: newOid, preferredUsername: holder.upn, email: holder.upn, name: "New Hire" }, deps);
        assert.deepEqual(r, { ok: false, reason: "upn_conflict" }, `${label}: refused`);
        assert.deepEqual(await usersWithOid(newOid), [], `${label}: no stub for the oid`);
        assert.deepEqual(await usersHolding(holder.upn), [{ id: holder.id, external_id: holder.externalId }], `${label}: holder untouched`);
        const rows = await conflictRows(holder.id);
        assert.equal(rows.length, 1, `${label}: one system-log row`);
        const row = rows[0]!;
        assert.equal(row.status, 409);
        assert.equal(row.route, "/api/auth/callback/[provider]");
        assert.equal(row.path, "/api/auth/callback/azure-ad");
        assert.equal(row.user_id, null);
        assert.equal(row.actor_name, null);
        assert.equal(row.actor_email, null);
        assert.ok(!row.message.includes(holder.upn) && !row.message.includes(newOid), `${label}: ids only — no UPN, no oid`);
      }

      // ── No UPN claim: no relink attempt; JIT keys the stub on the e-mail fallback ────
      const noClaim = await seed("noclaim", { scimSynced: true });
      const oidNoClaim = randomUUID();
      const rNo = await resolveEntraSignIn(pool, { oid: oidNoClaim, email: `other-${stamp}@example.test`, name: "Other" }, deps);
      assert.ok(rNo.ok && !rNo.relinked && rNo.user.id !== noClaim.id, "a fresh JIT stub, the SCIM row untouched");
      assert.equal((await usersHolding(noClaim.upn))[0]!.external_id, noClaim.externalId);

      // ── SCIM undoes the relink: the next sign-in is refused, never relinked again ────
      await pool.query(`update users set external_id = $1, last_seen_at = now() where id = $2`, [target.externalId, target.id]);
      const rUndone = await resolveEntraSignIn(pool, { oid, preferredUsername: target.upn }, deps);
      assert.deepEqual(rUndone, { ok: false, reason: "upn_conflict" });
      assert.deepEqual(await usersWithOid(oid), []);
      assert.equal((await conflictRows(target.id)).length, 1);

      // ── A deactivated row matched by oid is refused as before (leaver semantics) ─────
      const leaverOid = randomUUID();
      await pool.query(
        `insert into users (external_id, user_name, display_name, scim_synced, active) values ($1, $2, 'Leaver', true, false)`,
        [leaverOid, `dbtest-relink-leaver-${stamp}@example.test`],
      );
      assert.deepEqual(await resolveEntraSignIn(pool, { oid: leaverOid, preferredUsername: `dbtest-relink-leaver-${stamp}@example.test` }, deps), {
        ok: false,
        reason: "inactive",
      });
    } finally {
      await pool.end();
    }
  },
);
