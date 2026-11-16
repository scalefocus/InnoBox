// Live-DB integration test (gated) of the first directory sync (INNOBOX_SPEC.md §3) against a
// stubbed Graph client: a new row gets its directory profile and photo and is stamped; stamped,
// inactive, scrubbed and older-than-the-window rows are not taken; a missing or disabled account
// is left active, unchanged and unstamped; a Graph failure leaves the row pending, writes no audit
// row and does not stop the next row; a pending row is retried on the next sweep; and one sweep
// takes the newest FIRST_SYNC_BATCH rows. Self-skips when DATABASE_URL is unset.
//
// The suites share one database and the sweep takes the NEWEST pending rows, so every row here is
// given an explicit `created_at` ahead of the clock — this test's rows are then always the newest,
// whatever another suite inserted moments ago. Rows this test does not own are answered by echoing
// their local state back, so the sweep is a no-op for them (it only stamps the marker). Users are
// never hard-deleted by the app role, so every key is minted per run and the rows left pending are
// stamped at the end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool as PgPool } from "pg";
import type { GraphClient, GraphUser, PhotoResult } from "./graph.js";

const url = process.env.DATABASE_URL;

test(
  "first directory sync: new rows are completed early, and only new rows",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const [{ Pool }, { runFirstSync, FIRST_SYNC_BATCH, FIRST_SYNC_WINDOW_MINUTES }, { GraphRequestError }] = await Promise.all([
      import("pg"),
      import("./reconcile.js"),
      import("./graph.js"),
    ]);
    const pool: PgPool = new Pool({ connectionString: url });
    const run = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;
    const oid = (name: string) => `fstest-${run}-${name}`;

    /** `atSeconds` is the row's `created_at` relative to now — positive is ahead of the clock. */
    const insertUser = async (
      name: string,
      atSeconds: number,
      cols: { active?: boolean; scrubbed?: boolean; stamped?: boolean } = {},
    ): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, active, scrubbed_at, first_synced_at, created_at)
         values ($1, $2, $3, $2, $4,
                 case when $5::boolean then now() end,
                 case when $6::boolean then now() end,
                 now() + ($7::int * interval '1 second'))
         returning id`,
        [oid(name), `${oid(name)}@example.com`, `User ${name}`, cols.active ?? true, cols.scrubbed ?? false, cols.stamped ?? false, atSeconds],
      );
      return rows[0]!.id;
    };
    const user = async (id: string) =>
      (
        await pool.query(
          `select active, scim_synced, department, job_title, office_location, photo, photo_etag, first_synced_at
             from users where id = $1`,
          [id],
        )
      ).rows[0];
    /** Every audit row about a user — by its id (refresh, deactivation) or its oid (an anomaly). */
    const auditFor = async (id: string, name: string) =>
      (
        await pool.query<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
          `select action, before, after from audit_log where target_id = any($1) order by id`,
          [[id, oid(name)]],
        )
      ).rows;

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
    const tenant = new Map<string, GraphUser | "fail">();
    const photos = new Map<string, PhotoResult | "fail">();
    const reads: string[] = [];
    const readsOf = (name: string) => reads.filter((id) => id === oid(name)).length;

    const graph: GraphClient = {
      async getUser(id) {
        reads.push(id);
        const known = tenant.get(id);
        if (known === "fail") throw new GraphRequestError(503, "stub: graph unavailable");
        if (known) return known;
        // Not a row this test scripted: echo the local state back so the sweep changes nothing.
        const { rows } = await pool.query(
          `select user_name, display_name, email, department, job_title, office_location from users where external_id = $1`,
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
      async getGroup() {
        throw new Error("stub: the first sync reads no groups");
      },
      async listGroupMembers() {
        throw new Error("stub: the first sync reads no groups");
      },
      async getUserPhoto240(id): Promise<PhotoResult> {
        const p = photos.get(id);
        if (p === "fail") throw new GraphRequestError(503, "stub: photo unavailable");
        return p ?? { changed: false };
      },
    };

    try {
      // ── fixtures: newest first is userFail → photoFail → missing → disabled → fresh ───────
      const userFail = await insertUser("user-fail", 69);
      const photoFail = await insertUser("photo-fail", 68);
      const missing = await insertUser("missing", 67);
      const disabled = await insertUser("disabled", 66);
      const fresh = await insertUser("fresh", 65);
      const stamped = await insertUser("stamped", 64, { stamped: true });
      const inactive = await insertUser("inactive", 63, { active: false });
      const scrubbed = await insertUser("scrubbed", 62, { scrubbed: true });
      const old = await insertUser("old", -(FIRST_SYNC_WINDOW_MINUTES * 60 + 60));

      const profile = { department: "Engineering", jobTitle: "Engineer", officeLocation: "Sofia" };
      tenant.set(oid("user-fail"), "fail");
      tenant.set(oid("photo-fail"), enabled("photo-fail", { department: "Ops" }));
      photos.set(oid("photo-fail"), "fail");
      tenant.set(oid("missing"), { exists: false });
      tenant.set(oid("disabled"), enabled("disabled", { accountEnabled: false, department: "Ghost" }));
      tenant.set(oid("fresh"), enabled("fresh", profile));
      photos.set(oid("fresh"), { changed: true, bytes: Buffer.from("fresh-photo"), etag: "etag-fresh" });
      for (const name of ["stamped", "inactive", "scrubbed", "old"]) tenant.set(oid(name), enabled(name, { department: "Must not land" }));

      // ── sweep 1 ──────────────────────────────────────────────────────────────────────────
      const first = await runFirstSync(pool, graph);
      assert.equal(first.errors, 2, "the failed user read and the failed photo read");
      assert.equal(first.absent, 2, "the missing and the disabled account");
      assert.ok(first.synced >= 1);

      // A new row: directory profile and photo stored, stamped, audited as the hourly pass would.
      const freshRow = await user(fresh);
      assert.equal(freshRow.department, "Engineering");
      assert.equal(freshRow.job_title, "Engineer");
      assert.equal(freshRow.office_location, "Sofia");
      assert.deepEqual(freshRow.photo, Buffer.from("fresh-photo"));
      assert.equal(freshRow.photo_etag, "etag-fresh");
      assert.ok(freshRow.first_synced_at, "a completed first sync stamps the marker");
      assert.equal(freshRow.scim_synced, false, "the first sync never claims SCIM ownership");
      const freshAudit = await auditFor(fresh, "fresh");
      assert.deepEqual(
        freshAudit.map((a) => a.action),
        ["recon.user_refreshed"],
      );
      assert.equal(freshAudit[0]!.before?.department, null);
      assert.equal(freshAudit[0]!.after?.office_location, "Sofia");
      assert.equal(freshAudit[0]!.after?.photo, "updated");

      // A failure ahead of it in the queue did not stop it.
      assert.ok(reads.indexOf(oid("user-fail")) < reads.indexOf(oid("fresh")), "newest first: the failing row was tried before it");

      // Not taken: already stamped, inactive, scrubbed, older than the window.
      for (const [name, id] of [
        ["stamped", stamped],
        ["inactive", inactive],
        ["scrubbed", scrubbed],
        ["old", old],
      ] as const) {
        assert.equal(readsOf(name), 0, `${name}: never read from Graph`);
        assert.equal((await user(id)).department, null, `${name}: untouched`);
      }
      for (const id of [inactive, scrubbed, old]) assert.equal((await user(id)).first_synced_at, null);

      // Missing or disabled in the tenant: NEVER deactivated here — unchanged, unstamped, unaudited.
      for (const [name, id] of [
        ["missing", missing],
        ["disabled", disabled],
      ] as const) {
        const row = await user(id);
        assert.equal(row.active, true, `${name}: the first sync never deactivates`);
        assert.equal(row.department, null, `${name}: nothing is written`);
        assert.equal(row.first_synced_at, null, `${name}: left pending for the hourly pass`);
        assert.deepEqual(await auditFor(id, name), [], `${name}: no audit row`);
      }

      // A failed user read: pending, and NOT audited (no scim.anomaly from this sweep).
      assert.equal((await user(userFail)).first_synced_at, null);
      assert.deepEqual(await auditFor(userFail, "user-fail"), []);

      // A failed photo read: the attribute refresh stands and is audited; the row stays pending.
      const photoFailRow = await user(photoFail);
      assert.equal(photoFailRow.department, "Ops");
      assert.equal(photoFailRow.photo, null);
      assert.equal(photoFailRow.first_synced_at, null);
      const photoFailAudit = await auditFor(photoFail, "photo-fail");
      assert.deepEqual(
        photoFailAudit.map((a) => a.action),
        ["recon.user_refreshed"],
      );
      assert.deepEqual(photoFailAudit[0]!.after, { department: "Ops" });

      // ── sweep 2: Graph has recovered — pending rows are retried, completed ones are not ───
      tenant.set(oid("user-fail"), enabled("user-fail", { department: "Late" }));
      photos.set(oid("photo-fail"), { changed: true, bytes: Buffer.from("late-photo"), etag: "etag-late" });
      const second = await runFirstSync(pool, graph);
      assert.equal(second.errors, 0);
      assert.equal(second.absent, 2, "still missing and disabled: retried, still left alone");

      const userFailRow = await user(userFail);
      assert.equal(userFailRow.department, "Late");
      assert.ok(userFailRow.first_synced_at);
      const photoRetried = await user(photoFail);
      assert.deepEqual(photoRetried.photo, Buffer.from("late-photo"));
      assert.ok(photoRetried.first_synced_at);
      const photoRetriedAudit = await auditFor(photoFail, "photo-fail");
      assert.equal(photoRetriedAudit.length, 2);
      assert.deepEqual(photoRetriedAudit[1]!.after, { photo: "updated" }, "only the photo was left to do");

      assert.equal(readsOf("fresh"), 1, "a stamped row is never read again");
      assert.equal(readsOf("missing"), 2, "a pending row is retried on the next sweep");
      assert.equal((await user(missing)).active, true);

      // ── sweep 3: one sweep takes the newest FIRST_SYNC_BATCH pending rows ─────────────────
      const cap: string[] = [];
      for (let k = 1; k <= FIRST_SYNC_BATCH + 1; k++) cap.push(await insertUser(`cap-${k}`, 120 + k));
      const before = reads.length;
      const third = await runFirstSync(pool, graph);
      assert.equal(third.taken, FIRST_SYNC_BATCH);
      const expected: string[] = [];
      for (let k = FIRST_SYNC_BATCH + 1; k >= 2; k--) expected.push(oid(`cap-${k}`));
      assert.deepEqual(reads.slice(before), expected, "newest first, and no more than the batch");
      assert.equal((await user(cap[0]!)).first_synced_at, null, "the oldest of the 21 waits for the next sweep");
      assert.ok((await user(cap[1]!)).first_synced_at);
      assert.ok((await user(cap[FIRST_SYNC_BATCH]!)).first_synced_at);
    } finally {
      // Nothing this run left pending may be picked up by a later run's sweep.
      await pool.query(`update users set first_synced_at = now() where external_id like $1 and first_synced_at is null`, [
        `fstest-${run}-%`,
      ]);
      await pool.end();
    }
  },
);
