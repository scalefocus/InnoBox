// Live-DB integration test (gated) for Home "Featured" pins (INNOBOX_SPEC.md §13.2 *Featured
// challenges*, §14.3, §15, §10.3). Proves at the SQL level: the §2.4 order of checks (404 before
// 403 before 409), idempotence, the cap (incl. two concurrent features racing for the last slot,
// and a lowered limit that unpins nothing), the per-viewer visibility of the Home section with
// author masking, that curation never bumps updated_at, the automatic unpin on every status-write
// path (override, enforced, withdraw, solution-delete revert, hard delete) with its audit rows,
// that a cleared pin is never restored, and the DB CHECK backstop.
// Self-skips when DATABASE_URL is unset. Mirrors delete.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

const fakeStorage = {
  putObject: async () => {},
  getObject: async () => new Uint8Array(),
  getObjectStream: async () => ({ body: new Blob([]).stream(), contentLength: 0 }),
  deleteObject: async () => {},
  createMultipartUpload: async () => "mpu-1",
  uploadPart: async () => {},
  listParts: async () => [],
  completeMultipartUpload: async () => {},
  abortMultipartUpload: async () => {},
};

test(
  "§13.2 featured challenges: checks order, cap under concurrency, per-viewer Home visibility, auto-unpin with audit",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("./store");
    const { featureChallenge, unfeatureChallenge, getFeaturedLimit, setFeaturedLimit, listFeaturedForViewer } = await import("./featured");
    const { deleteChallenge, deleteSolution } = await import("./delete");
    const { getDashboard } = await import("../dashboard/store");

    const pool = new Pool({ connectionString: url });
    try {
      // The cap is global: start from a clean slate so earlier suites can never skew the count.
      await pool.query(`update challenges set featured_at = null, featured_by = null where featured_at is not null`);
      const stamp = randomUUID().slice(0, 8);

      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;
      const mkNs = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
          `dbtest-feat-${label}-${stamp}`,
          `Dbtest Featured ${label}`,
        ]);
        return rows[0]!.id;
      };
      const nsId = await mkNs("ns");
      const otherNsId = await mkNs("other");
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-feat-${label}-${stamp}`, `dbtest-feat-${label}-${stamp}@example.test`, `Dbtest Feat ${label}`],
        );
        return rows[0]!.id;
      };
      const opts = { globalNamespaceId: globalId };
      const author = { userId: await mkUser("author"), roles: buildRoleSet([{ role: "member", namespaceId: nsId }], opts) };
      const outsider = { userId: await mkUser("outsider"), roles: buildRoleSet([{ role: "member", namespaceId: otherNsId }], opts) };
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], opts) };
      const adminName = `Dbtest Feat admin`;
      const admin = { userId: await mkUser("admin"), roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], opts) };
      assert.equal(admin.roles.isPlatformAdmin, true);
      assert.equal(nsAdmin.roles.isPlatformAdmin, false);

      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const mkChallenge = async (title: string, visibility: "org" | "namespace", isAnonymous = false) => {
        const created = await store.createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `${title} ${stamp}`,
          description: "Body",
          clientName: null,
          visibility,
          isAnonymous,
        });
        assert.equal(created.status, "ok");
        if (created.status !== "ok") throw new Error("fixture");
        return { id: created.challenge.id, num: created.challenge.number.replace("CH-", ""), number: created.challenge.number };
      };
      const toValid = async (num: string) => assert.equal((await store.setChallengeStatus(pool, admin, num, "valid")).status, "ok");

      const orgCh = await mkChallenge("Org pin", "org");
      const nsCh = await mkChallenge("Namespace pin", "namespace", true);
      const reviewCh = await mkChallenge("Still in review", "org");
      await toValid(orgCh.num);
      await toValid(nsCh.num);
      await store.setChallengeStatus(pool, admin, reviewCh.num, "in_review");

      // ── §2.4 order of checks ──
      assert.equal((await featureChallenge(pool, admin, "abc")).status, "not_found", "malformed number");
      assert.equal((await featureChallenge(pool, admin, "999999999")).status, "not_found", "missing challenge");
      assert.equal((await featureChallenge(pool, outsider, nsCh.num)).status, "not_found", "invisible → 404 before 403");
      assert.equal((await unfeatureChallenge(pool, outsider, nsCh.num)).status, "not_found");
      assert.equal((await featureChallenge(pool, outsider, orgCh.num)).status, "forbidden", "visible, not a platform admin → 403");
      assert.equal((await featureChallenge(pool, nsAdmin, orgCh.num)).status, "forbidden", "namespace admins cannot feature");
      assert.equal((await featureChallenge(pool, author, orgCh.num)).status, "forbidden", "authors cannot feature");
      assert.equal((await featureChallenge(pool, admin, reviewCh.num)).status, "ineligible");

      // ── Feature: audited, idempotent, updated_at untouched ──
      const updatedBefore = await updatedAt(pool, orgCh.id);
      const first = await featureChallenge(pool, admin, orgCh.num);
      assert.equal(first.status, "ok");
      if (first.status !== "ok") return;
      assert.equal(first.featured, true);
      assert.ok(first.featuredAt);
      assert.equal((await updatedAt(pool, orgCh.id)).getTime(), updatedBefore.getTime(), "featuring must not bump updated_at");
      const featuredAudits = await auditRows(pool, orgCh.id, "challenge.featured");
      assert.equal(featuredAudits.length, 1);
      assert.equal(featuredAudits[0]!.actor_user_id, admin.userId);
      assert.deepEqual(featuredAudits[0]!.after, { featuredAt: first.featuredAt });

      const again = await featureChallenge(pool, admin, orgCh.num);
      assert.deepEqual(again, { status: "ok", featured: true, featuredAt: first.featuredAt }, "re-feature keeps the original featured_at");
      assert.equal((await auditRows(pool, orgCh.id, "challenge.featured")).length, 1, "a no-op writes no audit row");

      assert.equal((await featureChallenge(pool, admin, nsCh.num)).status, "ok");

      // ── Detail payload ──
      const adminDetail = await store.getChallengeByNumber(pool, admin, orgCh.num);
      assert.equal(adminDetail?.featured, true);
      assert.equal(adminDetail?.canFeature, true);
      assert.equal(adminDetail?.featuredAt, first.featuredAt);
      assert.equal(adminDetail?.featuredBy, adminName);
      const memberDetail = await store.getChallengeByNumber(pool, outsider, orgCh.num);
      assert.equal(memberDetail?.featured, true);
      assert.equal(memberDetail?.canFeature, false);
      assert.equal("featuredBy" in (memberDetail ?? {}), false, "no provenance for non-admins");
      assert.equal("featuredAt" in (memberDetail ?? {}), false, "no provenance for non-admins");

      // ── Home section: per-viewer visibility, newest pin first, masked authors ──
      const outsiderHome = await getDashboard(pool, outsider);
      assert.deepEqual(
        outsiderHome.featured.map((c) => c.number),
        [orgCh.number],
        "a namespace-restricted pin is invisible to a non-member",
      );
      assert.ok(!JSON.stringify(outsiderHome).includes(nsCh.number), "no trace of the hidden pin anywhere in the payload");
      const memberHome = await listFeaturedForViewer(pool, author);
      assert.deepEqual(memberHome.map((c) => c.number), [nsCh.number, orgCh.number], "newest pin first");
      const maskedCard = memberHome.find((c) => c.number === nsCh.number)!;
      assert.deepEqual(maskedCard.author, { userId: null, displayName: "Anonymous", anonymous: true }, "anonymity unchanged on Home");
      assert.deepEqual((await listFeaturedForViewer(pool, admin)).map((c) => c.number), [nsCh.number, orgCh.number]);

      // ── Cap: default 3, concurrent features cannot both take the last slot ──
      assert.equal(await getFeaturedLimit(pool), 3, "default limit");
      const c3 = await mkChallenge("Third", "org");
      const c4 = await mkChallenge("Fourth", "org");
      await toValid(c3.num);
      await toValid(c4.num);
      const raced = await Promise.all([featureChallenge(pool, admin, c3.num), featureChallenge(pool, admin, c4.num)]);
      const statuses = raced.map((r) => r.status).sort();
      assert.deepEqual(statuses, ["at_cap", "ok"], "exactly one racer takes the last slot");
      assert.equal(await pinCount(pool), 3);
      const capped = raced.find((r) => r.status === "at_cap");
      assert.deepEqual(capped, { status: "at_cap", limit: 3 });
      const winner = raced[0]!.status === "ok" ? c3 : c4;
      const loser = winner === c3 ? c4 : c3;

      // Lowering the limit unpins nothing; new pins stay refused until below the new cap.
      await setFeaturedLimit(pool, 2, admin.userId);
      assert.equal(await getFeaturedLimit(pool), 2);
      assert.equal(await pinCount(pool), 3, "lowering the cap keeps every pin");
      assert.deepEqual(await featureChallenge(pool, admin, loser.num), { status: "at_cap", limit: 2 });
      const limitAudit = await pool.query<{ after: unknown }>(
        `select after from audit_log where action = 'settings.featured_limit_changed' and actor_user_id = $1`,
        [admin.userId],
      );
      assert.deepEqual(limitAudit.rows.map((r) => r.after), [{ limit: 2 }]);
      await setFeaturedLimit(pool, 6, admin.userId);

      // ── Auto-unpin on status transitions ──
      // valid → solved keeps the pin.
      assert.equal((await store.setChallengeStatus(pool, admin, orgCh.num, "solved")).status, "ok");
      assert.notEqual(await featuredAtOf(pool, orgCh.id), null, "valid → solved keeps the pin");
      // An override to rejected (namespace admin) clears it, actor = the transition's actor.
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, orgCh.num, "rejected")).status, "ok");
      assert.equal(await featuredAtOf(pool, orgCh.id), null);
      let unfeatured = await auditRows(pool, orgCh.id, "challenge.unfeatured");
      assert.equal(unfeatured.length, 1);
      assert.equal(unfeatured[0]!.actor_user_id, nsAdmin.userId);
      assert.deepEqual(unfeatured[0]!.after, { trigger: "status_changed", status: "rejected" });
      // Back to valid: the pin is NOT restored.
      assert.equal((await store.setChallengeStatus(pool, admin, orgCh.num, "valid")).status, "ok");
      assert.equal(await featuredAtOf(pool, orgCh.id), null, "a cleared pin is never restored");

      // The §14.1 bulk status set (the lean variant) clears it too. (No enforced committee arrow
      // leaves valid/solved, §7.2, so an override/bulk/withdraw is the only way out.)
      assert.equal((await featureChallenge(pool, admin, orgCh.num)).status, "ok");
      assert.equal((await store.setChallengeStatusLean(pool, admin, orgCh.num, "needs_improvement")).status, "ok");
      assert.equal(await featuredAtOf(pool, orgCh.id), null, "bulk/lean status set clears the pin");
      unfeatured = await auditRows(pool, orgCh.id, "challenge.unfeatured");
      assert.equal(unfeatured.at(-1)!.actor_user_id, admin.userId);
      assert.deepEqual(unfeatured.at(-1)!.after, { trigger: "status_changed", status: "needs_improvement" });

      // The author's Withdraw clears it, actor = the author.
      assert.equal((await store.withdrawChallenge(pool, author, nsCh.num)).status, "ok");
      assert.equal(await featuredAtOf(pool, nsCh.id), null);
      const withdrawAudit = await auditRows(pool, nsCh.id, "challenge.unfeatured");
      assert.equal(withdrawAudit.length, 1);
      assert.equal(withdrawAudit[0]!.actor_user_id, author.userId);
      assert.deepEqual(withdrawAudit[0]!.after, { trigger: "status_changed", status: "withdrawn" });

      // Unfeature (manual) and its idempotent no-op.
      assert.deepEqual(await unfeatureChallenge(pool, admin, winner.num), { status: "ok", featured: false, featuredAt: null });
      const manual = await auditRows(pool, winner.id, "challenge.unfeatured");
      assert.equal(manual.length, 1);
      assert.deepEqual(manual[0]!.after, { trigger: "manual" });
      assert.deepEqual(await unfeatureChallenge(pool, admin, winner.num), { status: "ok", featured: false, featuredAt: null });
      assert.equal((await auditRows(pool, winner.id, "challenge.unfeatured")).length, 1, "unfeaturing an unpinned challenge is a no-op");
      assert.equal((await unfeatureChallenge(pool, author, winner.num)).status, "forbidden");

      // §10.3 solution-delete revert (solved → valid) keeps the pin.
      assert.equal((await featureChallenge(pool, admin, winner.num)).status, "ok");
      const sol = await store.createSolution(pool, outsider, winner.num, { description: "Fix", costVsBenefits: null, isAnonymous: false });
      assert.equal(sol.status, "ok");
      if (sol.status !== "ok") return;
      const solNum = sol.solution.number.replace("SOL-", "");
      for (const s of ["in_review", "valid", "implemented"]) {
        assert.equal((await store.setSolutionStatus(pool, admin, solNum, s)).status, "ok", s);
      }
      assert.equal(await statusOf(pool, winner.id), "solved");
      assert.notEqual(await featuredAtOf(pool, winner.id), null, "the §8.3 auto-solve keeps the pin");
      const solDelete = await deleteSolution({ pool, storage: fakeStorage }, admin, solNum, "cleanup");
      assert.equal(solDelete.status, "ok");
      assert.equal(await statusOf(pool, winner.id), "valid");
      assert.notEqual(await featuredAtOf(pool, winner.id), null, "solved → valid revert keeps the pin");

      // §10.3 hard delete of a featured challenge: unfeatured with trigger "deleted", actor = admin.
      assert.equal((await deleteChallenge({ pool, storage: fakeStorage }, admin, winner.num, "cleanup")).status, "ok");
      const deletedAudit = await auditRows(pool, winner.id, "challenge.unfeatured");
      assert.equal(deletedAudit.at(-1)!.actor_user_id, admin.userId);
      assert.deepEqual(deletedAudit.at(-1)!.after, { trigger: "deleted" });

      // DB backstop: a pinned row cannot leave valid/solved without clearing the pin.
      assert.equal((await featureChallenge(pool, admin, loser.num)).status, "ok");
      await assert.rejects(
        pool.query(`update challenges set status = 'rejected' where id = $1`, [loser.id]),
        /challenges_featured_status_chk/,
      );
      await assert.rejects(
        pool.query(`update challenges set featured_by = null where id = $1`, [loser.id]),
        /challenges_featured_pair_chk/,
      );
      await unfeatureChallenge(pool, admin, loser.num);
      await setFeaturedLimit(pool, 3, admin.userId);
    } finally {
      await pool.end();
    }
  },
);

async function updatedAt(pool: import("pg").Pool, id: string): Promise<Date> {
  const { rows } = await pool.query<{ updated_at: Date }>(`select updated_at from challenges where id = $1`, [id]);
  return rows[0]!.updated_at;
}

async function featuredAtOf(pool: import("pg").Pool, id: string): Promise<Date | null> {
  const { rows } = await pool.query<{ featured_at: Date | null }>(`select featured_at from challenges where id = $1`, [id]);
  return rows[0]!.featured_at;
}

async function statusOf(pool: import("pg").Pool, id: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(`select status from challenges where id = $1`, [id]);
  return rows[0]!.status;
}

async function pinCount(pool: import("pg").Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from challenges where featured_at is not null`);
  return rows[0]!.n;
}

async function auditRows(pool: import("pg").Pool, targetId: string, action: string) {
  const { rows } = await pool.query<{ actor_user_id: string | null; after: unknown }>(
    `select actor_user_id, after from audit_log where target_id = $1 and action = $2 order by id`,
    [targetId, action],
  );
  return rows;
}
