// Live-DB integration test (gated) for the §10.4 automatic purge: only items trashed at least 30
// days ago go, each through the §10.3 cascade; the audit row says `trigger: "retention"`, has no
// user actor, and carries the reason given at trash time plus `trashedAt`; a purged implemented
// solution un-solves its challenge exactly as a manual delete would; an item that is no longer in
// the trash when its turn comes is left alone. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test("trash purge: deletes only items past 30 days and audits trigger retention", { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" }, async () => {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const { runTrashPurgeSweep } = await import("./purge.js");
  const { purgeChallenge } = await import("@innobox/shared/item-delete");

  const pool = new Pool({ connectionString: url });
  try {
    const stamp = randomUUID().slice(0, 8);
    const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
    const globalId = g[0]!.id;
    const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active limit 1`);
    const { rows: u } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name) values ($1, $2, 'Dbtest purge') returning id`,
      [`dbtest-purge-${stamp}`, `dbtest-purge-${stamp}@example.test`],
    );
    const userId = u[0]!.id;

    const mkChallenge = async (title: string, status: string, trashedDaysAgo: number | null) =>
      (
        await pool.query<{ id: string; number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, resolved_at,
                                   trashed_at, trashed_by, trash_reason)
           values ($1, 'org', $2, 'd', $3, $4, $5, case when $5 = 'solved' then now() end,
                   case when $6::int is null then null else now() - make_interval(days => $6::int) end,
                   case when $6::int is null then null else $4::uuid end,
                   case when $6::int is null then null else 'trash reason ' || $2 end)
           returning id, number::text`,
          [globalId, `${title} ${stamp}`, ia[0]!.id, userId, status, trashedDaysAgo],
        )
      ).rows[0]!;
    const mkSolution = async (challengeId: string, status: string, trashedDaysAgo: number | null) =>
      (
        await pool.query<{ id: string; number: string }>(
          `insert into solutions (challenge_id, description, author_id, status, trashed_at, trashed_by, trash_reason)
           values ($1, 'd', $2, $3,
                   case when $4::int is null then null else now() - make_interval(days => $4::int) end,
                   case when $4::int is null then null else $2::uuid end,
                   case when $4::int is null then null else 'solution trash reason' end)
           returning id, number::text`,
          [challengeId, userId, status, trashedDaysAgo],
        )
      ).rows[0]!;

    const due = await mkChallenge("Due", "valid", 31);
    const dueChild = await mkSolution(due.id, "valid", null);
    const fresh = await mkChallenge("Fresh", "valid", 29);
    const solved = await mkChallenge("Solved", "solved", null);
    const dueWinner = await mkSolution(solved.id, "implemented", 31);
    const staleListing = await mkChallenge("Restored meanwhile", "valid", 40);

    // An item restored after it was listed: a retention purge whose cut-off predates its (new)
    // trash time must stand down.
    const standDown = await purgeChallenge(
      {
        pool,
        storage: { deleteObject: async () => {}, abortMultipartUpload: async () => {} },
      },
      fresh.number,
      { actorUserId: null, reason: "x", trigger: "retention", trashedNoLaterThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    );
    assert.equal(standDown.status, "not_found", "a purge never touches an item trashed after its cut-off");

    const deleted: string[] = [];
    const summary = await runTrashPurgeSweep(pool, {
      storage: { deleteObject: async (k) => void deleted.push(k), abortMultipartUpload: async () => {} },
      record: async () => assert.fail("no failure is recorded"),
    });
    assert.ok(summary.purged >= 3, `at least my three due items go (got ${summary.purged})`);
    assert.equal(summary.failed, 0);

    const exists = async (table: string, id: string) => (await pool.query(`select 1 from ${table} where id = $1`, [id])).rows.length > 0;
    assert.equal(await exists("challenges", due.id), false, "a challenge 31 days in the trash is purged");
    assert.equal(await exists("solutions", dueChild.id), false, "with every solution under it");
    assert.equal(await exists("challenges", staleListing.id), false);
    assert.equal(await exists("challenges", fresh.id), true, "29 days in the trash: not yet");
    assert.equal(await exists("solutions", dueWinner.id), false, "a solution 31 days in the trash is purged");
    const parent = await pool.query<{ status: string; resolved_at: Date | null }>(`select status, resolved_at from challenges where id = $1`, [solved.id]);
    assert.equal(parent.rows[0]!.status, "valid", "purging the implemented solution un-solves its challenge");
    assert.equal(parent.rows[0]!.resolved_at, null);

    const audit = await pool.query<{ actor_user_id: string | null; after: { reason: string; trigger: string; trashedAt?: string } }>(
      `select actor_user_id, after from audit_log where action = 'challenge.deleted' and target_id = $1`,
      [due.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0]!.actor_user_id, null, "the system is the actor");
    assert.equal(audit.rows[0]!.after.trigger, "retention");
    assert.equal(audit.rows[0]!.after.reason, `trash reason Due ${stamp}`, "the reason given when it was trashed");
    assert.ok(audit.rows[0]!.after.trashedAt, "trashedAt is recorded");
    const solAudit = await pool.query<{ after: { trigger: string; reason: string } }>(
      `select after from audit_log where action = 'solution.deleted' and target_id = $1`,
      [dueWinner.id],
    );
    assert.equal(solAudit.rows[0]!.after.trigger, "retention");
    assert.equal(solAudit.rows[0]!.after.reason, "solution trash reason");

    // Tidy up the one still-trashed fixture so later runs of other suites never purge it mid-test.
    await pool.query(`update challenges set trashed_at = null, trashed_by = null, trash_reason = null where id = $1`, [fresh.id]);
  } finally {
    await pool.end();
  }
});
