// Live-DB integration test (gated) for the challenge-detail flags and the §8.3 like freeze:
//   • likes toggle (on/off, audited) on an open challenge and on its solutions;
//   • once the challenge is `solved`, neither a like nor an unlike (POST toggle or DELETE) lands — on the challenge or
//     on any of its solutions — and the existing counts stay displayed (`likesFrozen`);
//   • a solved → valid revert unfreezes them;
//   • the per-viewer RBAC flags the detail page renders from: `canReveal` (namespace admin,
//     anonymous item — challenge AND solution), `canSelfReveal` (the anonymous author only),
//     `canAssign` (admin, non-terminal), `canPropose` (valid only).
// Self-skips when DATABASE_URL is unset. Mirrors challenges/store.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "challenge detail: §8.3 likes frozen on solved (challenge + solutions), reveal/self-reveal/assign/propose flags",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, getChallengeByNumber, listActiveImpactAreas, setChallengeStatus, setSolutionStatus, toggleLike } =
      await import("./store");
    const { removeLike } = await import("../likes/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Likes NS') returning id`,
        [`dbtest-likes-${stamp}`],
      );
      const nsId = nsRows[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-likes-${label}-${stamp}`, `dbtest-likes-${label}-${stamp}@example.test`, `Dbtest likes ${label}`],
        );
        return rows[0]!.id;
      };
      const member = (id: string) => ({ userId: id, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) });
      const author = member(await mkUser("author"));
      const proposer = member(await mkUser("proposer"));
      const liker = member(await mkUser("liker"));
      const committee = {
        userId: await mkUser("committee"),
        roles: buildRoleSet([{ role: "committee", namespaceId: nsId }], { globalNamespaceId: globalId }),
      };
      const admin = {
        userId: await mkUser("admin"),
        roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }),
      };

      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const created = await createChallenge(pool, author, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: `Likes freeze ${stamp}`,
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: true,
      });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const chId = created.challenge.id;
      const chNum = created.challenge.number.replace("CH-", "");

      // ── Flags before validation: Propose is not yet enabled; admin may assign + reveal. ────
      const triage = (await getChallengeByNumber(pool, admin, chNum))!;
      assert.equal(triage.canPropose, false, "awaiting_triage: no proposals yet");
      assert.equal(triage.canAssign, true, "assignment is possible from awaiting_triage");
      assert.equal(triage.canReveal, true, "a namespace admin may reveal an anonymous challenge");
      assert.equal(triage.canSelfReveal, false, "the admin is not the author");

      assert.equal((await setChallengeStatus(pool, admin, chNum, "valid")).status, "ok");

      const asAuthor = (await getChallengeByNumber(pool, author, chNum))!;
      assert.equal(asAuthor.canSelfReveal, true, "the anonymous author may self-reveal");
      assert.equal(asAuthor.canReveal, false, "the author is not an admin");
      assert.equal(asAuthor.canAssign, false);
      assert.equal(asAuthor.canPropose, true);
      assert.equal(asAuthor.likesFrozen, false);

      const asCommittee = (await getChallengeByNumber(pool, committee, chNum))!;
      assert.equal(asCommittee.canReveal, false, "committee members cannot reveal");
      assert.equal(asCommittee.canAssign, false, "committee members cannot assign");

      // ── An anonymous solution: the same reveal split, per solution. ───────────────────────
      const sol = await createSolution(pool, proposer, chNum, { description: "anon fix", costVsBenefits: null, isAnonymous: true });
      assert.equal(sol.status, "ok");
      if (sol.status !== "ok") return;
      const solId = sol.solution.id;
      const solNum = sol.solution.number.replace("SOL-", "");
      const solFor = async (viewer: typeof admin) => (await getChallengeByNumber(pool, viewer, chNum))!.solutions.find((s) => s.id === solId)!;
      assert.equal((await solFor(admin)).canReveal, true, "a namespace admin may reveal an anonymous solution");
      assert.equal((await solFor(admin)).canSelfReveal, false);
      assert.equal((await solFor(proposer)).canSelfReveal, true, "the anonymous proposer may self-reveal");
      assert.equal((await solFor(proposer)).canReveal, false);

      // Advance the solution out of `proposed` so the liker can see it.
      for (const st of ["in_review", "valid", "accepted_internally", "waiting_for_resources", "in_implementation"]) {
        assert.equal((await setSolutionStatus(pool, admin, solNum, st)).status, "ok", `solution → ${st}`);
      }
      assert.equal((await solFor(committee)).canReveal, false, "committee members cannot reveal a solution");

      // ── Open challenge: likes toggle normally, audited both ways. ──────────────────────────
      assert.deepEqual(await toggleLike(pool, liker, "challenge", chId), { status: "ok", liked: true, count: 1 });
      await assertAudited(pool, "like.added", chId);
      assert.deepEqual(await toggleLike(pool, liker, "challenge", chId), { status: "ok", liked: false, count: 0 });
      await assertAudited(pool, "like.removed", chId);
      assert.deepEqual(await toggleLike(pool, liker, "challenge", chId), { status: "ok", liked: true, count: 1 });
      assert.deepEqual(await toggleLike(pool, liker, "solution", solId), { status: "ok", liked: true, count: 1 });

      // ── Implemented → challenge solved: likes freeze on the challenge AND its solutions. ───
      assert.equal((await setSolutionStatus(pool, admin, solNum, "implemented")).status, "ok");
      const likeAuditBefore = await countLikeAudit(pool, [chId, solId]);

      assert.deepEqual(await toggleLike(pool, liker, "challenge", chId), { status: "frozen" }, "an unlike on a solved challenge is refused");
      assert.deepEqual(await toggleLike(pool, author, "challenge", chId), { status: "frozen" }, "a new like on a solved challenge is refused");
      assert.deepEqual(await toggleLike(pool, liker, "solution", solId), { status: "frozen" }, "an unlike on a solution of a solved challenge is refused");
      assert.deepEqual(await toggleLike(pool, author, "solution", solId), { status: "frozen" }, "a new like on a solution of a solved challenge is refused");
      assert.deepEqual(await removeLike(pool, liker, "challenge", chId), { status: "frozen" }, "the DELETE unlike is refused on a solved challenge");
      assert.deepEqual(await removeLike(pool, liker, "solution", solId), { status: "frozen" }, "the DELETE unlike is refused on a solution of a solved challenge");
      assert.equal(await countLikeAudit(pool, [chId, solId]), likeAuditBefore, "a refused toggle or unlike writes no audit row");

      const solved = (await getChallengeByNumber(pool, liker, chNum))!;
      assert.equal(solved.status, "solved");
      assert.equal(solved.likesFrozen, true);
      assert.equal(solved.likeCount, 1, "existing counts remain displayed");
      assert.equal(solved.likedByViewer, true);
      assert.equal(solved.solutions.find((s) => s.id === solId)!.likeCount, 1);
      assert.equal(solved.canPropose, false, "a solved challenge accepts no new solutions");
      assert.equal((await getChallengeByNumber(pool, admin, chNum))!.canAssign, false, "no assignment on a terminal status");

      // A hidden challenge still answers not_found before the freeze is consulted.
      assert.deepEqual(await toggleLike(pool, liker, "challenge", randomUUID()), { status: "not_found" });

      // ── solved → valid (admin override) unfreezes. ────────────────────────────────────────
      assert.equal((await setChallengeStatus(pool, admin, chNum, "valid")).status, "ok");
      assert.equal((await getChallengeByNumber(pool, liker, chNum))!.likesFrozen, false);
      assert.deepEqual(await toggleLike(pool, liker, "challenge", chId), { status: "ok", liked: false, count: 0 });
    } finally {
      await pool.end();
    }
  },
);

async function countLikeAudit(pool: import("pg").Pool, targetIds: string[]): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from audit_log where action in ('like.added','like.removed') and target_id = any($1::text[])`,
    [targetIds],
  );
  return Number(rows[0]!.n);
}

async function assertAudited(pool: import("pg").Pool, action: string, targetId: string): Promise<void> {
  const { rows } = await pool.query(`select 1 from audit_log where action = $1 and target_id = $2 limit 1`, [action, targetId]);
  assert.equal(rows.length, 1, `expected an audit_log row for ${action} / ${targetId}`);
}
