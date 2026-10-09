// Live-DB integration test (gated) for the §16 API-contract additions: GET solution detail
// (visibility-filtered, anonymity-masked, "not found" when not visible — invariant 2, §9) and the
// idempotent DELETE on likes and follows (same visibility gate as the POST toggles; `like.removed`
// audited only when a like really went). Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§16: solution detail read, idempotent unlike / unfollow",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, listActiveImpactAreas, setChallengeStatus, setSolutionStatus, toggleLike } = await import(
      "../challenges/store"
    );
    const { getSolutionByNumber } = await import("./store");
    const { removeLike } = await import("../likes/store");
    const { toggleFollow, unfollow } = await import("../follows/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Sol NS') returning id`, [
        `dbtest-sol-${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-sol-${label}-${stamp}`, `dbtest-sol-${label}-${stamp}@example.test`, `Dbtest Sol ${label} ${stamp}`],
        );
        return rows[0]!.id;
      };
      const member = (userId: string) => ({ userId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) });
      const author = member(await mkUser("author"));
      const proposer = member(await mkUser("proposer"));
      const colleague = member(await mkUser("colleague"));
      const outsider = { userId: await mkUser("outsider"), roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      const admin = { userId: await mkUser("admin"), roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const mkChallenge = async (visibility: "org" | "namespace") => {
        const c = await createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `Sol ${visibility} ${stamp}`,
          description: "d",
          clientName: null,
          visibility,
          isAnonymous: false,
        });
        assert.equal(c.status, "ok");
        if (c.status !== "ok") throw new Error("fixture");
        const num = c.challenge.number.replace("CH-", "");
        await setChallengeStatus(pool, admin, num, "valid");
        return { id: c.challenge.id, num };
      };
      const open = await mkChallenge("org");
      const restricted = await mkChallenge("namespace");

      const anon = await createSolution(pool, proposer, open.num, { description: "anon idea", costVsBenefits: null, isAnonymous: true });
      const hidden = await createSolution(pool, proposer, restricted.num, { description: "ns idea", costVsBenefits: null, isAnonymous: false });
      assert.equal(anon.status, "ok");
      assert.equal(hidden.status, "ok");
      if (anon.status !== "ok" || hidden.status !== "ok") return;
      const anonNum = anon.solution.number.replace("SOL-", "");
      const hiddenNum = hidden.solution.number.replace("SOL-", "");

      // ── GET detail ──────────────────────────────────────────────────────────────────────
      // A `proposed` solution is visible to its author and the namespace admins only (§4.3).
      assert.equal(await getSolutionByNumber(pool, colleague, anonNum), null, "a proposed solution is not visible to a colleague");
      const own = await getSolutionByNumber(pool, proposer, anonNum);
      assert.ok(own, "the author sees their own proposed solution");
      assert.equal(own!.solution.isMine, true);
      assert.equal(own!.challenge.number, `CH-${open.num}`);

      assert.equal((await setSolutionStatus(pool, admin, anonNum, "in_review")).status, "ok");
      const seen = await getSolutionByNumber(pool, colleague, anonNum);
      assert.ok(seen, "once in review, any viewer of the challenge sees it");
      assert.equal(seen!.solution.number, `SOL-${anonNum}`);
      assert.equal(seen!.solution.author.anonymous, true);
      assert.equal(seen!.solution.author.userId, null, "an anonymous author's id never leaves the API");
      assert.equal(seen!.solution.author.displayName, "Anonymous");
      assert.ok(!JSON.stringify(seen).includes(proposer.userId), "nowhere in the payload");

      assert.equal((await setSolutionStatus(pool, admin, hiddenNum, "in_review")).status, "ok");
      assert.ok(await getSolutionByNumber(pool, colleague, hiddenNum), "a namespace member sees a namespace-restricted item");
      assert.equal(await getSolutionByNumber(pool, outsider, hiddenNum), null, "an outsider gets not-found for a namespace-restricted item");
      assert.equal(await getSolutionByNumber(pool, colleague, "99999999"), null);
      assert.equal(await getSolutionByNumber(pool, colleague, "nope"), null);

      // ── DELETE /api/likes: idempotent, audited only when a like went ─────────────────────
      const likeAudits = async () =>
        Number(
          (await pool.query<{ n: string }>(`select count(*) as n from audit_log where action = 'like.removed' and target_id = $1 and actor_user_id = $2`, [
            anon.solution.id,
            colleague.userId,
          ])).rows[0]!.n,
        );
      const liked = await toggleLike(pool, colleague, "solution", anon.solution.id);
      assert.ok(liked.status === "ok" && liked.liked);
      const un1 = await removeLike(pool, colleague, "solution", anon.solution.id);
      assert.deepEqual(un1, { status: "ok", liked: false, count: 0 });
      assert.equal(await likeAudits(), 1);
      const un2 = await removeLike(pool, colleague, "solution", anon.solution.id);
      assert.deepEqual(un2, { status: "ok", liked: false, count: 0 }, "a second unlike is a no-op success");
      assert.equal(await likeAudits(), 1, "and writes no second audit row");
      assert.deepEqual(await removeLike(pool, outsider, "solution", hidden.solution.id), { status: "not_found" }, "invisible → not found");

      // ── DELETE /api/follows: idempotent ────────────────────────────────────────────────
      const followed = await toggleFollow(pool, colleague, "challenge", open.id);
      assert.deepEqual(followed, { status: "ok", following: true });
      assert.deepEqual(await unfollow(pool, colleague, "challenge", open.id), { status: "ok", following: false });
      assert.deepEqual(await unfollow(pool, colleague, "challenge", open.id), { status: "ok", following: false }, "a second unfollow is a no-op success");
      const { rows: f } = await pool.query(`select 1 from follows where user_id = $1 and parent_type = 'challenge' and parent_id = $2`, [colleague.userId, open.id]);
      assert.equal(f.length, 0);
      assert.deepEqual(await unfollow(pool, outsider, "challenge", restricted.id), { status: "not_found" }, "invisible → not found");
    } finally {
      await pool.end();
    }
  },
);
