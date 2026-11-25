// Live-DB integration test (gated) for the implementation board (INNOBOX_SPEC.md §46): the read — the
// on-board rule, visibility and masking, both orders, the 90-day window, the counts and the cap, the
// filters and the namespace options, `moves`/`moveMode` per role, hype on and off — and the status
// PATCH's §46.8 base statuses, order of checks and row lock (stale moves, simultaneous moves, a
// withdraw crossing an implementation, a move into `implemented` under an already-solved challenge).
// Self-skips when DATABASE_URL is unset. Mirrors featured.dbtest.ts.
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
  "§46 implementation board: the read per viewer, and the status PATCH's base statuses and lock",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("../challenges/store");
    const { getImplementationBoard } = await import("./store");
    const { trashSolution, restoreSolution } = await import("../challenges/trash");
    const { setHypeEnabled } = await import("../admin/settings/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const opts = { globalNamespaceId: globalRows[0]!.id };
      const mkNs = async (label: string, archived = false) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into namespaces (slug, display_name, archived_at) values ($1, $2, ${archived ? "now()" : "null"}) returning id`,
          [`dbtest-ib-${label}-${stamp}`, `Dbtest Board ${label}`],
        );
        return rows[0]!.id;
      };
      const nsA = await mkNs("a");
      const nsB = await mkNs("b");
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-ib-${label}-${stamp}`, `dbtest-ib-${label}-${stamp}@example.test`, `Dbtest Board ${label}`],
        );
        return rows[0]!.id;
      };
      const viewer = async (label: string, grants: { role: string; namespaceId: string | null }[]) => ({
        userId: await mkUser(label),
        roles: buildRoleSet(grants as never, opts),
      });
      const author = await viewer("author", [{ role: "member", namespaceId: nsA }]);
      const member = await viewer("member", [{ role: "member", namespaceId: nsA }]);
      const outsider = await viewer("outsider", [{ role: "member", namespaceId: nsB }]);
      const committee = await viewer("committee", [{ role: "committee", namespaceId: nsA }]);
      const otherCommittee = await viewer("othercommittee", [{ role: "committee", namespaceId: nsB }]);
      const nsAdmin = await viewer("nsadmin", [{ role: "namespace_admin", namespaceId: nsA }]);
      const adminCommittee = await viewer("admincommittee", [
        { role: "namespace_admin", namespaceId: nsA },
        { role: "committee", namespaceId: nsA },
      ]);
      const platform = await viewer("platform", [{ role: "platform_admin", namespaceId: null }]);
      const assignee = await viewer("assignee", [{ role: "member", namespaceId: nsA }]);

      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const mkChallenge = async (title: string, visibility: "org" | "namespace" = "org", by = author) => {
        const created = await store.createChallenge(pool, by, {
          impactAreaId: internal.id,
          namespaceId: nsA,
          title: `${title} ${stamp}`,
          description: "Body",
          clientName: null,
          visibility,
          isAnonymous: false,
        });
        assert.equal(created.status, "ok");
        if (created.status !== "ok") throw new Error("fixture");
        const num = created.challenge.number.replace("CH-", "");
        assert.equal((await store.setChallengeStatus(pool, platform, num, "valid")).status, "ok");
        return { id: created.challenge.id, num };
      };
      const mkSolution = async (chNum: string, opts2: { anonymous?: boolean; by?: typeof author } = {}) => {
        const created = await store.createSolution(pool, opts2.by ?? author, chNum, {
          description: "A way",
          costVsBenefits: null,
          isAnonymous: opts2.anonymous ?? false,
        });
        assert.equal(created.status, "ok");
        if (created.status !== "ok") throw new Error("fixture");
        const { rows } = await pool.query<{ id: string }>(`select id from solutions where number = $1`, [created.solution.number.replace("SOL-", "")]);
        return { id: rows[0]!.id, num: created.solution.number.replace("SOL-", ""), number: created.solution.number };
      };
      const move = (who: typeof author, num: string, to: string, base?: { status?: string; challengeStatus?: string }) =>
        store.setSolutionStatus(pool, who, num, to, undefined, base);
      const toColumn = async (num: string, to: string) => assert.equal((await move(platform, num, to)).status, "ok", `→ ${to}`);
      const board = (who: typeof author, filters: Record<string, unknown> = {}) =>
        getImplementationBoard(pool, who, { involving: false, following: false, ...filters });
      const card = async (who: typeof author, number: string) =>
        (await board(who)).columns.flatMap((c) => c.cards).find((c) => c.number === number);
      const auditCount = async (solutionId: string) =>
        Number((await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where target_id = $1 and action = 'solution.status_changed'`, [solutionId])).rows[0]!.n);

      // ── An org card: on the board in its column, author masked, team shape, moves per role ──
      const orgCh = await mkChallenge("Org");
      await pool.query(`update challenges set assignee_id = $2 where id = $1`, [orgCh.id, assignee.userId]);
      const orgSol = await mkSolution(orgCh.num, { anonymous: true });
      assert.equal(await card(member, orgSol.number), undefined, "proposed: no card");
      await toColumn(orgSol.num, "accepted_internally");
      const seen = await card(member, orgSol.number);
      assert.ok(seen, "an org card is on a member's board");
      assert.equal(seen!.status, "accepted_internally");
      assert.equal(seen!.author.anonymous, true, "an anonymous author is masked");
      assert.equal(seen!.author.userId, null);
      assert.equal(seen!.assigneeId, assignee.userId);
      assert.equal(seen!.challengeStatus, "valid");
      assert.equal("hype" in seen!, false, "no hype while hype is off");
      assert.deepEqual(seen!.moves, [], "a plain viewer has no moves");
      assert.equal(seen!.moveMode, undefined);
      assert.deepEqual((await card(committee, orgSol.number))!.moves, ["waiting_for_resources"]);
      assert.equal((await card(committee, orgSol.number))!.moveMode, "enforced");
      assert.equal((await card(assignee, orgSol.number))!.moveMode, "enforced");
      assert.deepEqual((await card(otherCommittee, orgSol.number))!.moves, [], "committee of another namespace");
      assert.equal((await card(nsAdmin, orgSol.number))!.moves.length, 4);
      assert.equal((await card(nsAdmin, orgSol.number))!.moveMode, "override");
      assert.equal((await card(adminCommittee, orgSol.number))!.moveMode, "override", "admin and committee: the admin's list");
      assert.equal((await card(platform, orgSol.number))!.moveMode, "override");

      // A committee member who is an author of the solution has none; the assignee who is one keeps theirs.
      const ownCh = await mkChallenge("Own");
      const ownSol = await mkSolution(ownCh.num, { by: committee });
      await toColumn(ownSol.num, "in_implementation");
      assert.deepEqual((await card(committee, ownSol.number))!.moves, [], "barred as author");
      await pool.query(`update challenges set assignee_id = $2 where id = $1`, [ownCh.id, committee.userId]);
      assert.deepEqual((await card(committee, ownSol.number))!.moves, ["external_acceptance", "implemented"], "the assignee keeps theirs");

      // ── Restricted: an outsider gets no card, and neither the totals nor the options count it ──
      const nsCh = await mkChallenge("Restricted", "namespace");
      const nsSol = await mkSolution(nsCh.num);
      await toColumn(nsSol.num, "waiting_for_resources");
      assert.ok(await card(member, nsSol.number), "a member of the namespace sees it");
      const outsiderBoard = await board(outsider);
      assert.equal(outsiderBoard.columns.flatMap((c) => c.cards).some((c) => c.number === nsSol.number), false);
      assert.equal(outsiderBoard.namespaces.some((n) => n.id === nsA), true, "the org cards name the namespace");
      const memberWaiting = (await board(member, { namespaceId: nsA })).columns.find((c) => c.status === "waiting_for_resources")!.total;
      const outsiderWaiting = (await board(outsider, { namespaceId: nsA })).columns.find((c) => c.status === "waiting_for_resources")!.total;
      assert.equal(memberWaiting - outsiderWaiting, 1, "the restricted card is counted only for those who can see it");

      // ── The on-board rule: the challenge's status decides presence, the solution's the column ──
      const solvedCh = await mkChallenge("Solved by hand");
      const solvedSol = await mkSolution(solvedCh.num);
      await toColumn(solvedSol.num, "in_implementation");
      assert.equal((await store.setChallengeStatus(pool, platform, solvedCh.num, "solved")).status, "ok");
      assert.equal((await card(member, solvedSol.number))?.status, "in_implementation", "in progress under a solved challenge");
      assert.equal((await store.setChallengeStatus(pool, platform, solvedCh.num, "rejected")).status, "ok");
      assert.equal(await card(member, solvedSol.number), undefined, "a rejected challenge takes the card off");
      assert.equal((await store.setChallengeStatus(pool, platform, solvedCh.num, "in_review")).status, "ok");
      assert.equal(await card(member, solvedSol.number), undefined, "sent back to review");
      assert.equal((await store.setChallengeStatus(pool, platform, solvedCh.num, "valid")).status, "ok");
      assert.ok(await card(member, solvedSol.number), "and it comes back");

      // ── Trash: no card, for a platform admin too; it returns on restore ──
      assert.equal((await trashSolution({ pool, storage: fakeStorage as never }, platform, solvedSol.num, "dbtest")).status, "ok");
      assert.equal(await card(platform, solvedSol.number), undefined, "trashed: no card for a platform admin");
      assert.equal((await restoreSolution(pool, platform, solvedSol.num)).status, "ok");
      assert.equal((await card(platform, solvedSol.number))?.status, "in_implementation", "back in the column it kept");

      // ── The 90-day window and both orders ──
      const implA = await mkSolution((await mkChallenge("Impl A")).num);
      const implB = await mkSolution((await mkChallenge("Impl B")).num);
      await toColumn(implA.num, "implemented");
      await toColumn(implB.num, "implemented");
      await pool.query(`update solutions set status_changed_at = now() - interval '89 days' where id = $1`, [implA.id]);
      await pool.query(`update solutions set status_changed_at = now() - interval '91 days' where id = $1`, [implB.id]);
      assert.equal((await card(member, implA.number))?.status, "implemented", "at 89 days");
      assert.equal(await card(member, implB.number), undefined, "gone at 91 days");
      await pool.query(`update solutions set status_changed_at = now() - interval '1 day' where id = $1`, [implB.id]);
      const implemented = (await board(member, { namespaceId: nsA })).columns.find((c) => c.status === "implemented")!.cards.map((c) => c.number);
      assert.ok(implemented.indexOf(implB.number) < implemented.indexOf(implA.number), "Implemented: newest first");
      await pool.query(`update solutions set status_changed_at = now() - interval '2 days' where id = $1`, [ownSol.id]);
      const inProgress = (await board(member, { namespaceId: nsA })).columns.find((c) => c.status === "in_implementation")!.cards.map((c) => c.number);
      assert.ok(inProgress.indexOf(ownSol.number) > -1 && inProgress.indexOf(ownSol.number) < inProgress.indexOf(solvedSol.number), "in progress: the longest wait first");

      // ── Filters: involving, following, a malformed-free unknown id, hidden equals unknown ──
      const involving = (await board(assignee, { involving: true })).columns.flatMap((c) => c.cards).map((c) => c.number);
      assert.ok(involving.includes(orgSol.number), "the assignee is involved");
      assert.equal(involving.includes(nsSol.number), false);
      const authorInvolving = (await board(author, { involving: true })).columns.flatMap((c) => c.cards).map((c) => c.number);
      assert.ok(authorInvolving.includes(orgSol.number), "the author of an anonymous solution, in their own view");
      await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, 'challenge', $2) on conflict do nothing`, [member.userId, nsCh.id]);
      const following = (await board(member, { following: true })).columns.flatMap((c) => c.cards).map((c) => c.number);
      assert.deepEqual(following, [nsSol.number], "a follow of the challenge");
      const unknown = await board(member, { namespaceId: randomUUID() });
      const hidden = await board(member, { namespaceId: nsB });
      assert.equal(unknown.columns.every((c) => c.total === 0 && c.cards.length === 0), true);
      assert.deepEqual(unknown, hidden, "a hidden namespace answers exactly as one that does not exist");
      assert.deepEqual((await board(member)).namespaces, (await board(member, { involving: true })).namespaces, "options before any filter");

      // ── Hype on: the solution's own number, 0 shown ──
      await setHypeEnabled(pool, true, platform.userId);
      try {
        assert.equal((await card(member, orgSol.number))!.hype, 0);
      } finally {
        await setHypeEnabled(pool, false, platform.userId);
      }

      // ── The PATCH: base statuses, order of checks, nothing written on a refusal ──
      const before = await auditCount(orgSol.id);
      assert.equal((await move(committee, orgSol.num, "waiting_for_resources", { status: "in_implementation", challengeStatus: "valid" })).status, "stale");
      assert.equal(
        (await move(committee, orgSol.num, "accepted_internally", { status: "waiting_for_resources", challengeStatus: "valid" })).status,
        "stale",
        "a stale base refuses even when the target is the current status",
      );
      assert.equal((await move(committee, orgSol.num, "waiting_for_resources", { status: "accepted_internally", challengeStatus: "solved" })).status, "stale");
      assert.equal(await auditCount(orgSol.id), before, "a stale move writes nothing");
      assert.equal((await move(outsider, nsSol.num, "in_implementation", { status: "accepted_internally" })).status, "not_found", "404 whatever the base");
      assert.equal((await move(member, orgSol.num, "waiting_for_resources", { status: "in_implementation" })).status, "forbidden", "403 before the stale 409");
      assert.equal((await move(committee, orgSol.num, "implemented", { status: "waiting_for_resources" })).status, "stale", "the stale 409 before the 422");
      assert.equal((await move(committee, orgSol.num, "implemented", { status: "accepted_internally" })).status, "illegal_transition");
      assert.equal((await move(committee, orgSol.num, "waiting_for_resources", { status: "accepted_internally", challengeStatus: "valid" })).status, "ok");
      assert.equal(await auditCount(orgSol.id), before + 1);

      // A platform admin's move on a trashed solution is the trash's 409, never stale.
      assert.equal((await trashSolution({ pool, storage: fakeStorage as never }, platform, nsSol.num, "dbtest")).status, "ok");
      assert.equal((await move(platform, nsSol.num, "in_implementation", { status: "proposed" })).status, "trashed");
      assert.equal((await restoreSolution(pool, platform, nsSol.num)).status, "ok");

      // A challenge rejected a moment earlier stays rejected: the board's move carries its status.
      const rejCh = await mkChallenge("Rejected meanwhile");
      const rejSol = await mkSolution(rejCh.num);
      await toColumn(rejSol.num, "external_acceptance");
      assert.equal((await store.setChallengeStatus(pool, platform, rejCh.num, "rejected")).status, "ok");
      assert.equal((await move(platform, rejSol.num, "implemented", { status: "external_acceptance", challengeStatus: "valid" })).status, "stale");
      assert.equal((await pool.query<{ status: string }>(`select status from challenges where id = $1`, [rejCh.id])).rows[0]!.status, "rejected");

      // ── Simultaneous moves: one lands, the other is stale; without the base, both `before`s are true ──
      const raceCh = await mkChallenge("Race");
      const raceSol = await mkSolution(raceCh.num);
      await toColumn(raceSol.num, "accepted_internally");
      const raced = await Promise.all([
        move(nsAdmin, raceSol.num, "in_implementation", { status: "accepted_internally", challengeStatus: "valid" }),
        move(platform, raceSol.num, "waiting_for_resources", { status: "accepted_internally", challengeStatus: "valid" }),
      ]);
      assert.deepEqual(raced.map((r) => r.status).sort(), ["ok", "stale"]);
      await Promise.all([move(nsAdmin, raceSol.num, "external_acceptance"), move(platform, raceSol.num, "accepted_internally")]);
      const { rows: chain } = await pool.query<{ before: { status: string }; after: { status: string } }>(
        `select before, after from audit_log where target_id = $1 and action = 'solution.status_changed' order by id`,
        [raceSol.id],
      );
      for (let i = 1; i < chain.length; i += 1) assert.equal(chain[i]!.before.status, chain[i - 1]!.after.status, "each before is the status replaced");

      // A move into implemented and a sibling's change at the same moment: no 5xx, the sibling ends not_selected.
      const sibCh = await mkChallenge("Siblings");
      const winner = await mkSolution(sibCh.num);
      const sibling = await mkSolution(sibCh.num, { by: member });
      await toColumn(winner.num, "external_acceptance");
      const both = await Promise.allSettled([
        move(platform, winner.num, "implemented", { status: "external_acceptance", challengeStatus: "valid" }),
        move(nsAdmin, sibling.num, "in_review", { status: "proposed", challengeStatus: "valid" }),
      ]);
      assert.equal(both.every((r) => r.status === "fulfilled"), true, "neither request fails");
      assert.equal((await pool.query<{ status: string }>(`select status from solutions where id = $1`, [sibling.id])).rows[0]!.status, "not_selected");

      // An author's withdraw crossing a move into implemented: never both.
      const wCh = await mkChallenge("Withdraw race");
      const wSol = await mkSolution(wCh.num);
      await toColumn(wSol.num, "in_implementation");
      const [moved, withdrawn] = await Promise.all([
        move(platform, wSol.num, "implemented", { status: "in_implementation", challengeStatus: "valid" }),
        store.withdrawSolution(pool, author, wSol.num),
      ]);
      assert.notDeepEqual([moved.status, withdrawn.status], ["ok", "ok"], "one of them is refused");

      // ── Implementing under an already-solved challenge: no challenge.solved webhook, no second points ──
      const reCh = await mkChallenge("Re-implemented");
      const reSol = await mkSolution(reCh.num);
      await toColumn(reSol.num, "implemented");
      await toColumn(reSol.num, "in_implementation");
      assert.equal((await pool.query<{ status: string }>(`select status from challenges where id = $1`, [reCh.id])).rows[0]!.status, "solved");
      const again = await move(platform, reSol.num, "implemented", { status: "in_implementation", challengeStatus: "solved" });
      assert.equal(again.status, "ok");
      if (again.status === "ok") assert.ok(again.autoClose, "the cascade runs again (events 3 and 8)");
      const { rows: points } = await pool.query<{ n: string }>(
        `select count(*)::text as n from gamification_ledger where user_id = $1 and award_key = $2`,
        [author.userId, `solution_implemented:${reSol.id}`],
      );
      assert.ok(Number(points[0]!.n) <= 1, "no second award for the same implementation");
      const { rows: solvedRows } = await pool.query<{ before: { status: string } }>(
        `select before from audit_log where target_id = $1 and action = 'challenge.status_changed' order by id desc limit 1`,
        [reCh.id],
      );
      assert.equal(solvedRows[0]!.before.status, "solved", "the cascade's row reads solved → solved");
    } finally {
      await pool.end();
    }
  },
);
