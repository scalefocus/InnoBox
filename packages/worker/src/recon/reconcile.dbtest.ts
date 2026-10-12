// Live-DB integration test (gated) of one full reconciliation pass (ENTRA_AUTH_SPEC.md §5, §8
// "Reconciliation") against a stubbed Graph client: deactivation of a missing and of a disabled
// user, attribute refresh including empty → NULL (the three directory fields and mail), the
// photo ETag skip, membership replacement with a JIT stub for an unknown member, a group gone in
// Entra, and the bootstrap group mirrored from worker boot. Self-skips when DATABASE_URL is unset.
//
// The pass walks EVERY active user and EVERY local group, and the suites share one database, so
// the stub answers for rows this test does not own by echoing their local state back — the pass
// is then a no-op for them, and nothing another suite wrote is deactivated or re-membered. Users
// are never hard-deleted by the app role, so every key is minted per run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool as PgPool } from "pg";
import type { GraphClient, GraphUser, PhotoResult } from "./graph.js";

const url = process.env.DATABASE_URL;

test(
  "reconciliation: one full pass against a stubbed Graph client",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const [{ Pool }, { runReconciliation }, { GraphRequestError }] = await Promise.all([
      import("pg"),
      import("./reconcile.js"),
      import("./graph.js"),
    ]);
    const pool: PgPool = new Pool({ connectionString: url });
    const run = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const oid = (name: string) => `recontest-${run}-${name}`;

    const insertUser = async (
      name: string,
      cols: { email?: string | null; department?: string | null; job_title?: string | null; office_location?: string | null; photo_etag?: string | null } = {},
    ): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, department, job_title, office_location, photo, photo_etag)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [
          oid(name),
          `${oid(name)}@example.com`,
          `User ${name}`,
          cols.email === undefined ? `${oid(name)}@example.com` : cols.email,
          cols.department ?? null,
          cols.job_title ?? null,
          cols.office_location ?? null,
          cols.photo_etag ? Buffer.from("old-photo") : null,
          cols.photo_etag ?? null,
        ],
      );
      return rows[0]!.id;
    };
    const insertGroup = async (name: string): Promise<string> =>
      (
        await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $2) returning id`, [
          oid(name),
          `Group ${name}`,
        ])
      ).rows[0]!.id;
    const user = async (id: string) =>
      (
        await pool.query(
          `select active, deactivated_at, email, department, job_title, office_location, display_name, photo, photo_etag
             from users where id = $1`,
          [id],
        )
      ).rows[0];
    const auditFor = async (targetId: string, action: string) =>
      (await pool.query(`select before, after from audit_log where target_id = $1 and action = $2 order by id`, [targetId, action]))
        .rows;
    const members = async (groupId: string) =>
      (
        await pool.query<{ external_id: string }>(
          `select u.external_id from group_members gm join users u on u.id = gm.user_id where gm.group_id = $1 order by u.external_id`,
          [groupId],
        )
      ).rows.map((r) => r.external_id);

    // ── fixtures ──────────────────────────────────────────────────────────────────────────
    const gone = await insertUser("gone", { photo_etag: "etag-gone" });
    const disabled = await insertUser("disabled");
    const cleared = await insertUser("cleared", {
      department: "R&D",
      job_title: "Engineer",
      office_location: "Sofia",
      photo_etag: "etag-same",
    });
    const renamed = await insertUser("renamed", { photo_etag: "etag-old" });
    const stayer = await insertUser("stayer");
    const leaver = await insertUser("leaver");

    const team = await insertGroup("team");
    await pool.query(`insert into group_members (group_id, user_id) values ($1, $2), ($1, $3)`, [team, stayer, leaver]);
    const vanished = await insertGroup("vanished");
    await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [vanished, stayer]);

    // ── the stubbed tenant ───────────────────────────────────────────────────────────────
    const enabled = (name: string, extra: Partial<Extract<GraphUser, { exists: true }>> = {}): GraphUser => ({
      exists: true,
      accountEnabled: true,
      displayName: `User ${name}`,
      userPrincipalName: `${oid(name)}@example.com`,
      mail: `${oid(name)}@example.com`,
      department: null,
      jobTitle: null,
      officeLocation: null,
      ...extra,
    });
    const tenantUsers = new Map<string, GraphUser>([
      [oid("gone"), { exists: false }],
      [oid("disabled"), enabled("disabled", { accountEnabled: false })],
      // Cleared upstream: the directory fields arrive empty or blank, mail as null (graph.ts's
      // normalization of an absent value) — all four must land as NULL.
      [oid("cleared"), enabled("cleared", { mail: null, department: "", jobTitle: "   ", officeLocation: "" })],
      [oid("renamed"), enabled("renamed", { displayName: "User renamed (new)" })],
      [oid("stayer"), enabled("stayer")],
      [oid("leaver"), enabled("leaver")],
      [oid("joiner"), enabled("joiner", { department: "Ops" })],
      [oid("disabled-joiner"), enabled("disabled-joiner", { accountEnabled: false })],
    ]);
    const tenantGroups = new Map<string, { displayName: string; members: string[] }>([
      [oid("team"), { displayName: "Group team", members: [oid("stayer"), oid("joiner"), oid("disabled-joiner")] }],
      [oid("bootstrap"), { displayName: "Bootstrap admins", members: [oid("stayer")] }],
    ]);
    const photoCalls = new Map<string, string | null>();

    const graphClient: GraphClient = {
      async getUser(id) {
        const known = tenantUsers.get(id);
        if (known) return known;
        // Not this test's row: echo the local state back so the pass changes nothing.
        const { rows } = await pool.query(
          `select user_name, display_name, email, department, job_title, office_location, active from users where external_id = $1`,
          [id],
        );
        const r = rows[0];
        if (!r) throw new Error(`stub: unexpected user ${id}`);
        return {
          exists: true,
          accountEnabled: true,
          displayName: r.display_name,
          userPrincipalName: r.user_name,
          mail: r.email,
          department: r.department,
          jobTitle: r.job_title,
          officeLocation: r.office_location,
        };
      },
      async getGroup(id) {
        const g = tenantGroups.get(id);
        return g ? { exists: true, displayName: g.displayName } : { exists: false };
      },
      async listGroupMembers(id) {
        const g = tenantGroups.get(id);
        if (g) return g.members;
        if (id.startsWith(`recontest-${run}-`)) throw new GraphRequestError(404, "stub: group gone");
        // Not this test's group: report its current local roster.
        const { rows } = await pool.query<{ external_id: string }>(
          `select u.external_id from group_members gm join groups g on g.id = gm.group_id join users u on u.id = gm.user_id
            where g.external_id = $1`,
          [id],
        );
        if (rows.length === 0) {
          const exists = await pool.query(`select 1 from groups where external_id = $1`, [id]);
          if (exists.rows.length === 0) throw new GraphRequestError(404, "stub: unknown group");
        }
        return rows.map((r) => r.external_id);
      },
      async getUserPhoto240(id, currentEtag): Promise<PhotoResult> {
        photoCalls.set(id, currentEtag);
        if (id === oid("cleared")) return currentEtag === "etag-same" ? { changed: false } : { changed: true };
        if (id === oid("renamed")) {
          return currentEtag === "etag-new" ? { changed: false } : { changed: true, bytes: Buffer.from("new-photo"), etag: "etag-new" };
        }
        return { changed: false };
      },
    };

    try {
      const summary = await runReconciliation(
        pool,
        { tenantId: "stub", clientId: "stub", clientSecret: "stub" },
        { graphClient, bootstrapAdminGroup: oid("bootstrap") },
      );
      assert.equal(summary.errors, 0, "no Graph failures in this pass");
      assert.ok(summary.deactivated >= 2);

      // ── missing in the tenant / disabled → deactivated, photo dropped, audited ───────────
      const goneRow = await user(gone);
      assert.equal(goneRow.active, false);
      assert.ok(goneRow.deactivated_at);
      assert.equal(goneRow.photo, null, "the cached photo is dropped on deactivation");
      assert.equal(goneRow.photo_etag, null);
      assert.equal((await auditFor(gone, "recon.user_deactivated"))[0]?.after.reason, "missingInTenant");
      assert.equal((await user(disabled)).active, false);
      assert.equal((await auditFor(disabled, "recon.user_deactivated"))[0]?.after.reason, "accountDisabled");
      assert.ok(!photoCalls.has(oid("gone")), "no photo fetch for a deactivated user");

      // ── cleared upstream → NULL locally (three directory fields and mail) ────────────────
      const clearedRow = await user(cleared);
      assert.equal(clearedRow.active, true);
      assert.equal(clearedRow.email, null);
      assert.equal(clearedRow.department, null);
      assert.equal(clearedRow.job_title, null);
      assert.equal(clearedRow.office_location, null);
      const clearedAudit = await auditFor(cleared, "recon.user_refreshed");
      assert.equal(clearedAudit.length, 1);
      assert.equal(clearedAudit[0].before.department, "R&D");
      assert.equal(clearedAudit[0].after.office_location, null);
      assert.equal(clearedAudit[0].after.photo, undefined, "an unchanged photo is not reported");

      // ── photo: the stored ETag is sent, an unchanged one skips the bytes, a new one is stored ──
      assert.equal(photoCalls.get(oid("cleared")), "etag-same");
      assert.deepEqual(clearedRow.photo, Buffer.from("old-photo"), "ETag unchanged → photo untouched");
      assert.equal(clearedRow.photo_etag, "etag-same");
      const renamedRow = await user(renamed);
      assert.equal(renamedRow.display_name, "User renamed (new)");
      assert.deepEqual(renamedRow.photo, Buffer.from("new-photo"));
      assert.equal(renamedRow.photo_etag, "etag-new");
      assert.equal((await auditFor(renamed, "recon.user_refreshed"))[0]?.after.photo, "updated");

      // ── nothing drifted → no write, no audit ─────────────────────────────────────────────
      assert.equal((await auditFor(stayer, "recon.user_refreshed")).length, 0);

      // ── membership replaced: leaver out, joiner in as a JIT stub, disabled joiner skipped ──
      assert.deepEqual(await members(team), [oid("joiner"), oid("stayer")].sort());
      const { rows: joiner } = await pool.query(
        `select id, active, scim_synced, department from users where external_id = $1`,
        [oid("joiner")],
      );
      assert.equal(joiner.length, 1);
      assert.equal(joiner[0].scim_synced, false, "a reconciliation stub stays JIT-grade");
      assert.equal(joiner[0].department, "Ops");
      assert.equal((await auditFor(joiner[0].id, "user.jit_created"))[0]?.after.via, "reconciliation");
      const { rows: disabledJoiner } = await pool.query(`select 1 from users where external_id = $1`, [oid("disabled-joiner")]);
      assert.equal(disabledJoiner.length, 0, "a disabled account never enters via a membership race");
      const healed = await auditFor(team, "recon.membership_healed");
      assert.equal(healed.length, 1);
      assert.equal(healed[0].after.adds, 1);
      assert.equal(healed[0].after.removes, 1);

      // ── a group gone in Entra is dropped with its memberships ────────────────────────────
      const { rows: vanishedRows } = await pool.query(`select 1 from groups where id = $1`, [vanished]);
      assert.equal(vanishedRows.length, 0);
      assert.equal((await auditFor(vanished, "recon.group_deleted")).length, 1);

      // ── the bootstrap group is mirrored locally with its members ─────────────────────────
      const { rows: bootstrap } = await pool.query<{ id: string; display_name: string; scim_synced: boolean }>(
        `select id, display_name, scim_synced from groups where external_id = $1`,
        [oid("bootstrap")],
      );
      assert.equal(bootstrap.length, 1);
      assert.equal(bootstrap[0]!.display_name, "Bootstrap admins");
      assert.equal(bootstrap[0]!.scim_synced, false, "reconciliation's mirror never claims SCIM provisioning");
      assert.deepEqual(await members(bootstrap[0]!.id), [oid("stayer")]);

      // ── a second pass is a no-op for everything this test owns ───────────────────────────
      const again = await runReconciliation(
        pool,
        { tenantId: "stub", clientId: "stub", clientSecret: "stub" },
        { graphClient, bootstrapAdminGroup: oid("bootstrap") },
      );
      assert.equal(again.errors, 0);
      assert.equal(again.deactivated, 0);
      assert.equal(again.membershipAdds, 0);
      assert.equal(again.membershipRemoves, 0);
      assert.equal((await auditFor(cleared, "recon.user_refreshed")).length, 1, "no repeat refresh");
      assert.equal((await auditFor(renamed, "recon.user_refreshed")).length, 1, "a stored ETag skips the photo next time");
    } finally {
      await pool.query(`delete from groups where external_id like $1`, [`recontest-${run}-%`]);
      await pool.end();
    }
  },
);
