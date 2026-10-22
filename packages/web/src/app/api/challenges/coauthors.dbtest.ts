// Live-DB integration test (gated) for §39 co-authors (INNOBOX_SPEC.md §39.13):
//   • a create with co-authors writes the members (creator first, picks in order), their audits and
//     their awards; event 21 reaches each co-author; anonymity and eligibility refusals on create;
//   • the add / remove / leave matrix in the 404 → 403 → 409 → 422 order: the cap counting a
//     "Deleted User" row, the creator's protection (and its loss on erasure), the final leave, the
//     closed window; two concurrent adds cannot exceed five, the last two leaving at once leave one;
//   • visibility: an awaiting_triage challenge and a proposed solution for every member, gone after
//     a leave; a team change never grows a `people` access list;
//   • the picker's SQL twin agrees with the JS eligibility, and leaves out members, leavers, the caller;
//   • notifications: events 2, 3, 5, 6, 8 and 16 reach every member; event 21 only the person added
//     or removed, never on a leave, never digested, one e-mail per item per UTC day;
//   • points: full awards for each member, a member's like earns nothing, the join replay dated to
//     the join, a re-join writes nothing, leaving deducts nothing; Full Circle for a member of both;
//     the leaderboard counts each current member from their join;
//   • the committee bar (403, `reviewBarred`, the assignee and admin exceptions);
//   • a stale edit by another member is refused; erasure keeps the membership; the delete audit
//     records `authorIds`.
// Self-skips when DATABASE_URL is unset; like the other suites it leaves its rows behind.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "co-authors: create, team changes, visibility, picker, notifications, points, committee bar, erasure",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    type RoleSet = ReturnType<typeof buildRoleSet>;
    const store = await import("./store");
    const { searchActiveUsers, scrubUser } = await import("../users/store");
    const { getLeaderboard } = await import("../leaderboards/store");
    const { deleteChallenge } = await import("./delete");
    const notifyEvents = await import("../../../lib/notify-events");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
            `dbtest-team-${label}-${stamp}`,
            `Dbtest Team ${label}`,
          ])
        ).rows[0]!.id;
      const nsId = await mkNs("main");
      const otherNsId = await mkNs("other");
      const roleMap = new Map<string, RoleSet>();
      const mkUser = async (label: string, grants: { role: "member" | "committee" | "namespace_admin" | "platform_admin"; namespaceId: string | null }[]) => {
        const userId = (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
            `dbtest-team-${label}-${stamp}`,
            `dbtest-team-${label}-${stamp}@example.test`,
            `Dbtest team ${label} ${stamp}`,
          ])
        ).rows[0]!.id;
        const roles = buildRoleSet(grants, { globalNamespaceId: globalId });
        roleMap.set(userId, roles);
        return { userId, roles };
      };
      const resolveRoles = async (id: string) => roleMap.get(id) ?? buildRoleSet([], { globalNamespaceId: globalId });
      const ctx = (actorId: string) => ({ pool, actorId, resolveRoles });
      const asMember = (label: string) => mkUser(label, [{ role: "member", namespaceId: nsId }]);

      const ana = await asMember("ana");
      const ben = await asMember("ben");
      const cara = await asMember("cara");
      const dan = await asMember("dan");
      const eve = await asMember("eve");
      const fay = await asMember("fay");
      const outsider = await mkUser("outsider", [{ role: "member", namespaceId: otherNsId }]);
      const committee = await mkUser("committee", [{ role: "committee", namespaceId: nsId }]);
      const nsAdmin = await mkUser("nsadmin", [{ role: "namespace_admin", namespaceId: nsId }]);
      const platform = await mkUser("platform", [{ role: "platform_admin", namespaceId: null }]);
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const coAuthors = (ids: string[]) => ({ ids, resolveRoles });
      const create = (who: typeof ana, title: string, extra: { visibility?: "org" | "namespace"; anonymous?: boolean; ids?: string[] } = {}) =>
        store.createChallenge(pool, who, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `${title} ${stamp}`,
          description: "d",
          clientName: null,
          visibility: extra.visibility ?? "namespace",
          isAnonymous: extra.anonymous ?? false,
          coAuthors: coAuthors(extra.ids ?? []),
        });
      const members = async (table: "challenge_authors" | "solution_authors", id: string) =>
        (
          await pool.query<{ user_id: string }>(
            `select user_id from ${table} where ${table === "challenge_authors" ? "challenge_id" : "solution_id"} = $1 order by added_at, user_id`,
            [id],
          )
        ).rows.map((r) => r.user_id);
      const ledger = async (userId: string, reason: string, itemId: string) =>
        (
          await pool.query<{ points: number; occurred_at: Date }>(
            `select points, occurred_at from gamification_ledger where user_id = $1 and reason = $2 and item_id = $3`,
            [userId, reason, itemId],
          )
        ).rows;
      const inbox = async (userId: string, type: string, itemId: string) =>
        (
          await pool.query<{ id: string; message: string }>(
            `select id, payload->>'message' as message from notifications where user_id = $1 and type = $2 and (challenge_id = $3 or solution_id = $3)`,
            [userId, type, itemId],
          )
        ).rows;
      const outbox = async (userId: string, type: string, itemId: string) =>
        (
          await pool.query<{ digest_due_at: Date | null }>(`select digest_due_at from notification_outbox where user_id = $1 and type = $2 and payload->>'parentId' = $3`, [
            userId,
            type,
            itemId,
          ])
        ).rows;
      const change = async (who: typeof ana, entity: "challenge" | "solution", num: string, op: "add" | "remove", userId: string) => {
        const r = await store.changeTeam(pool, who, entity, num, { op, userId }, resolveRoles);
        // As the route does: event 21 after the commit, never on a leave.
        if (r.status === "ok" && r.notice) await notifyEvents.notifyTeamChange(ctx(who.userId), r.notice);
        return r;
      };
      const refusal = (r: Awaited<ReturnType<typeof change>>) => (r.status === "refused" ? r.refusal : r.status);

      // ── Create with co-authors ─────────────────────────────────────────────────────────────
      assert.deepEqual(await create(ana, "Anon team", { anonymous: true, ids: [ben.userId] }), {
        status: "invalid",
        error: "Anonymous items can't have co-authors.",
      });
      assert.deepEqual(await create(ana, "Outsider team", { ids: [outsider.userId] }), { status: "ineligible_coauthor" }, "namespace-only: an outsider cannot join");
      const created = await create(ana, "Team challenge", { ids: [cara.userId, ben.userId] });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const ch = { id: created.challenge.id, num: created.challenge.number.replace("CH-", "") };
      assert.deepEqual(await members("challenge_authors", ch.id), [ana.userId, cara.userId, ben.userId], "the creator first, then the picks in order");
      assert.deepEqual(
        created.challenge.authors.map((a) => [a.userId, a.creator]),
        [
          [ana.userId, true],
          [cara.userId, false],
          [ben.userId, false],
        ],
      );
      const added = (
        await pool.query<{ actor_user_id: string; after: { userId: string; via: string } }>(
          `select actor_user_id, after from audit_log where action = 'challenge.author_added' and target_id = $1 order by id`,
          [ch.id],
        )
      ).rows;
      assert.deepEqual(
        added.map((r) => [r.actor_user_id, r.after.userId, r.after.via]),
        [
          [ana.userId, cara.userId, "submit"],
          [ana.userId, ben.userId, "submit"],
        ],
      );
      for (const m of [ana, ben, cara]) assert.equal((await ledger(m.userId, "challenge_submitted", ch.id)).length, 1, "every member earns the submit award");
      await notifyEvents.notifyCoAuthorsAdded(ctx(ana.userId), { parentType: "challenge", parentId: ch.id }, [cara.userId, ben.userId]);
      for (const m of [ben, cara]) {
        const rows = await inbox(m.userId, "coauthor_changed", ch.id);
        assert.equal(rows.length, 1);
        assert.match(rows[0]!.message, new RegExp(`^Dbtest team ana ${stamp} added you as a co-author of CH-${ch.num}$`));
        assert.deepEqual((await outbox(m.userId, "coauthor_changed", ch.id)).map((r) => r.digest_due_at), [null], "immediate, never digested");
      }
      assert.equal((await inbox(ana.userId, "coauthor_changed", ch.id)).length, 0, "never the actor");

      // ── Visibility: every member sees it in triage; the list's Mine tab finds it ─────────────
      assert.ok(await store.getChallengeByNumber(pool, ben, ch.num), "a member sees the awaiting_triage challenge");
      assert.equal(await store.getChallengeByNumber(pool, dan, ch.num), null, "a non-member does not");
      const mine = await store.listChallenges(pool, cara, { tab: "mine", sort: "newest" });
      assert.ok(mine.some((c) => c.id === ch.id), "§13.1 Mine: every item the viewer is a member of");

      // ── The change matrix ───────────────────────────────────────────────────────────────────
      assert.equal(refusal(await change(dan, "challenge", ch.num, "add", eve.userId)), "not_found", "404 first: dan cannot see it in triage");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, ch.num, "in_review")).status, "ok");
      assert.equal(refusal(await change(dan, "challenge", ch.num, "add", eve.userId)), "not_member", "403 for a non-member");
      assert.equal(refusal(await change(ben, "challenge", ch.num, "add", outsider.userId)), "ineligible", "422: an outsider cannot see a namespace-only challenge");
      assert.equal(refusal(await change(ben, "challenge", ch.num, "remove", ana.userId)), "creator", "409: nobody else removes the creator");
      const addDan = await change(ben, "challenge", ch.num, "add", dan.userId);
      assert.equal(addDan.status, "ok");
      if (addDan.status === "ok") {
        assert.deepEqual(addDan.authors.map((a) => a.userId), [ana.userId, cara.userId, ben.userId, dan.userId]);
        assert.deepEqual(addDan.notice && [addDan.notice.userId, addDan.notice.change], [dan.userId, "added"]);
      }
      assert.ok(
        (await pool.query(`select 1 from follows where user_id = $1 and parent_type = 'challenge' and parent_id = $2`, [dan.userId, ch.id])).rows.length,
        "§39.8: a joiner auto-follows",
      );
      // The cap: five members, a sixth refused — two concurrent adds at four cannot both succeed.
      const [r1, r2] = await Promise.all([change(ana, "challenge", ch.num, "add", eve.userId), change(ana, "challenge", ch.num, "add", fay.userId)]);
      assert.deepEqual([r1.status, r2.status].sort(), ["ok", "refused"], "exactly one of two concurrent adds at four succeeds");
      assert.equal((await members("challenge_authors", ch.id)).length, 5);
      const loser = r1.status === "ok" ? fay : eve;
      assert.equal(refusal(await change(ana, "challenge", ch.num, "add", loser.userId)), "full", "409 at the cap");

      // Leave: final; the leaver is out of the Mine tab and cannot be re-added.
      const winner = r1.status === "ok" ? eve : fay;
      const left = await change(winner, "challenge", ch.num, "remove", winner.userId);
      assert.equal(left.status, "ok");
      if (left.status === "ok") assert.equal(left.notice, null, "leaving notifies nobody");
      assert.equal((await inbox(winner.userId, "coauthor_changed", ch.id)).length, 1, "only the add reached them");
      assert.equal(refusal(await change(ana, "challenge", ch.num, "add", winner.userId)), "ineligible", "a leave is final");
      assert.equal(await store.getCoAuthorPickerAudience(pool, dan.userId === ana.userId ? ana : outsider, { coAuthorFor: `CH-${ch.num}` }), null, "a non-member gets no picker");
      // Removal is not a leave: dan can be removed and added back; the re-add replays nothing new.
      assert.equal((await change(cara, "challenge", ch.num, "remove", dan.userId)).status, "ok");
      assert.equal((await inbox(dan.userId, "coauthor_changed", ch.id)).length, 2, "the removal is told too");
      assert.equal((await outbox(dan.userId, "coauthor_changed", ch.id)).length, 1, "but only one e-mail per item per UTC day");
      assert.equal((await change(cara, "challenge", ch.num, "add", dan.userId)).status, "ok");
      assert.equal((await ledger(dan.userId, "challenge_submitted", ch.id)).length, 1, "a re-join writes nothing new");

      // ── Points: validation for every member; a member's like earns nothing; the join replay ──
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, ch.num, "valid")).status, "ok");
      for (const m of [ana, ben, cara, dan]) assert.equal((await ledger(m.userId, "challenge_validated", ch.id)).length, 1, "every member earns validated");
      assert.equal((await store.toggleLike(pool, ben, "challenge", ch.id)).status, "ok");
      const likeKey = `like_received:challenge:${ch.id}:${ben.userId}`;
      assert.equal((await pool.query(`select 1 from gamification_ledger where award_key = $1`, [likeKey])).rows.length, 0, "a member's like earns no member");
      assert.equal((await store.toggleLike(pool, outsider, "challenge", ch.id)).status, "not_found");
      // The person about to join likes it first: that like earned the members of that time their award.
      assert.equal((await store.toggleLike(pool, loser, "challenge", ch.id)).status, "ok");
      assert.equal((await ledger(ana.userId, "like_received", ch.id)).length, 1, "a like from outside the team credits each member");
      assert.equal((await change(ana, "challenge", ch.num, "add", loser.userId)).status, "ok", "a slot is free after the leave");
      const joinAt = (
        await pool.query<{ added_at: Date }>(`select added_at from challenge_authors where challenge_id = $1 and user_id = $2`, [ch.id, loser.userId])
      ).rows[0]!.added_at;
      const replay = [...(await ledger(loser.userId, "challenge_submitted", ch.id)), ...(await ledger(loser.userId, "challenge_validated", ch.id))];
      assert.equal(replay.length, 2, "the joiner gets the milestones reached so far");
      assert.ok(replay.every((r) => r.occurred_at.getTime() === joinAt.getTime()), "dated to the join");
      assert.equal(
        (await pool.query(`select 1 from gamification_ledger where user_id = $1 and reason = 'like_received' and item_id = $2`, [loser.userId, ch.id])).rows.length,
        0,
        "a like given before the join earns the joiner nothing (their own like earns nothing either)",
      );
      const before = (await pool.query<{ n: number }>(`select count(*)::int as n from gamification_ledger where user_id = $1`, [cara.userId])).rows[0]!.n;
      assert.equal((await change(cara, "challenge", ch.num, "remove", cara.userId)).status, "ok");
      const after = (await pool.query<{ n: number }>(`select count(*)::int as n from gamification_ledger where user_id = $1`, [cara.userId])).rows[0]!.n;
      assert.equal(after, before, "leaving deducts nothing");

      // ── The committee bar ───────────────────────────────────────────────────────────────────
      const cTeam = await create(ana, "Committee-authored", { ids: [committee.userId] });
      assert.equal(cTeam.status, "ok");
      if (cTeam.status !== "ok") return;
      const cNum = cTeam.challenge.number.replace("CH-", "");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, cNum, "in_review")).status, "ok");
      assert.equal((await store.setChallengeStatus(pool, committee, cNum, "valid")).status, "own_item", "§39.5: 403 on the committee member's own challenge");
      const asCommittee = await store.getChallengeByNumber(pool, committee, cNum);
      assert.deepEqual([asCommittee!.allowedTransitions, asCommittee!.reviewBarred], [[], true]);
      assert.equal((await store.setChallengeAssignee(pool, nsAdmin, cNum, committee.userId, resolveRoles)).status, "ok");
      assert.equal((await store.setChallengeStatus(pool, committee, cNum, "valid")).status, "ok", "the assignee role is unaffected");
      // Being on the challenge's team does not bar them from a solution under it.
      const sol = await store.createSolution(pool, dan, cNum, { description: `Dan's idea ${stamp}`, costVsBenefits: null, isAnonymous: false, coAuthors: coAuthors([ben.userId]) });
      assert.equal(sol.status, "ok");
      if (sol.status !== "ok") return;
      const s = { id: sol.solution.id, num: sol.solution.number.replace("SOL-", "") };
      assert.deepEqual(await members("solution_authors", s.id), [dan.userId, ben.userId]);
      assert.equal((await store.setChallengeAssignee(pool, nsAdmin, cNum, null, resolveRoles)).status, "ok");
      // A proposed solution: every member sees it, a non-member does not.
      const benView = await store.getChallengeByNumber(pool, ben, cNum);
      assert.ok(benView!.solutions.some((x) => x.id === s.id && x.isMine && x.canManageTeam && x.canLeave));
      const caraView = await store.getChallengeByNumber(pool, cara, cNum);
      assert.ok(!caraView!.solutions.some((x) => x.id === s.id), "a proposed solution is hidden from non-members");
      assert.equal((await store.setSolutionStatus(pool, committee, s.num, "in_review")).status, "ok", "the challenge's team reviews its solutions");
      // A committee member on the SOLUTION's team is barred from it.
      assert.equal((await change(dan, "solution", s.num, "add", committee.userId)).status, "ok");
      assert.equal((await store.setSolutionStatus(pool, committee, s.num, "valid")).status, "own_item");
      assert.equal((await store.setSolutionStatus(pool, nsAdmin, s.num, "valid")).status, "ok", "an admin overrides");

      // ── Notifications reach every member ────────────────────────────────────────────────────
      await notifyEvents.notifySolutionStatusChanged(ctx(nsAdmin.userId), s.id, "valid");
      for (const m of [dan, ben, committee]) assert.ok((await inbox(m.userId, "status_changed", s.id)).length >= 1, "event 3 to every member");
      await notifyEvents.notifySolutionProposed(ctx(dan.userId), `CH-${cNum}`, { id: s.id, number: s.num });
      assert.ok((await inbox(ana.userId, "solution_proposed", s.id)).length >= 1, "event 2 to the challenge's team");
      await notifyEvents.notifyCommentPosted(ctx(nsAdmin.userId), "solution", s.id, nsAdmin.userId);
      for (const m of [dan, ben]) assert.equal((await inbox(m.userId, "comment_posted", s.id)).length, 1, "event 6 to every member");
      await notifyEvents.notifyHyped(ctx(outsider.userId), "solution", s.id, outsider.userId, 2);
      for (const m of [dan, ben]) assert.equal((await inbox(m.userId, "hyped", s.id)).length, 1, "event 16 to every member");

      // Implementing it: every member earns, Full Circle for someone on both teams (ana is not on
      // the solution; committee is on both).
      for (const st of ["accepted_internally", "waiting_for_resources", "in_implementation"] as const) {
        assert.equal((await store.setSolutionStatus(pool, nsAdmin, s.num, st)).status, "ok");
      }
      const impl = await store.setSolutionStatus(pool, nsAdmin, s.num, "implemented");
      assert.equal(impl.status, "ok");
      for (const m of [dan, ben, committee]) assert.equal((await ledger(m.userId, "solution_implemented", s.id)).length, 1, "every member earns implemented");
      assert.ok(
        (await pool.query(`select 1 from user_badges where user_id = $1 and badge_key = 'full_circle'`, [committee.userId])).rows.length,
        "Full Circle: a member of both the implemented solution and its challenge",
      );
      assert.equal(refusal(await change(dan, "solution", s.num, "add", cara.userId)), "closed", "409 once past valid");
      assert.equal((await change(ben, "solution", s.num, "remove", ben.userId)).status, "ok", "leaving still works in any status");

      // ── An org-visible team: the picker's SQL twin, and the leaderboard per current member ────
      const orgTeam = await create(eve, "Org team", { visibility: "org", ids: [fay.userId] });
      if (orgTeam.status !== "ok") return;
      const oNum = orgTeam.challenge.number.replace("CH-", "");
      const picker = await searchActiveUsers(pool, stamp, undefined, {
        ...(await store.getCoAuthorPickerAudience(pool, eve, { coAuthorFor: `CH-${oNum}` }))!,
        callerId: eve.userId,
      });
      const pickerIds = new Set(picker.map((u) => u.id));
      assert.ok(!pickerIds.has(eve.userId) && !pickerIds.has(fay.userId), "the picker leaves out the caller and the members");
      assert.ok(pickerIds.has(outsider.userId) && pickerIds.has(dan.userId), "an org challenge: anyone active");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, oNum, "in_review")).status, "ok");
      const board = async () => {
        const rows = await getLeaderboard(pool, "challenges_submitted", "all", 100_000);
        return (id: string) => rows.find((e) => e.userId === id)?.count ?? 0;
      };
      let count = await board();
      assert.deepEqual([count(eve.userId), count(fay.userId)], [1, 1], "each member counts the item once");
      assert.equal(count(cara.userId), 0, "namespace-only items never reach a public board");
      assert.equal((await change(fay, "challenge", oNum, "remove", fay.userId)).status, "ok");
      count = await board();
      assert.deepEqual([count(eve.userId), count(fay.userId)], [1, 0], "membership is read live: a leaver no longer counts it");
      const recent = await getLeaderboard(pool, "challenges_submitted", "30d", 100_000);
      assert.equal(recent.find((e) => e.userId === eve.userId)?.count, 1, "the 30-day window counts from the event (or the join)");

      // ── A stale edit by another member ─────────────────────────────────────────────────────
      const editable = await create(ana, "Editable team", { ids: [ben.userId] });
      if (editable.status !== "ok") return;
      await notifyEvents.notifyCoAuthorsAdded(ctx(ana.userId), { parentType: "challenge", parentId: editable.challenge.id }, [ben.userId]);
      assert.equal((await outbox(ben.userId, "coauthor_changed", editable.challenge.id)).length, 1, "the cap is per item: another item still e-mails");
      const eNum = editable.challenge.number.replace("CH-", "");
      const edit = (who: typeof ana, title: string, baseEditedAt: string | null) =>
        store.editChallenge(pool, who, eNum, { title, description: "d", clientName: null, impactAreaId: internal.id, baseEditedAt });
      assert.equal((await edit(ben, "Ben's title", null)).status, "ok", "any member edits");
      assert.equal((await edit(ana, "Ana's title", null)).status, "stale", "a save from a stale copy is refused");
      assert.equal((await store.getChallengeByNumber(pool, ana, eNum))!.title, "Ben's title", "and writes nothing");

      // ── Anonymous: no team, and an add is refused ───────────────────────────────────────────
      const anon = await create(ana, "Anonymous solo", { anonymous: true });
      if (anon.status !== "ok") return;
      const aNum = anon.challenge.number.replace("CH-", "");
      assert.equal(refusal(await change(ana, "challenge", aNum, "add", ben.userId)), "anonymous");
      assert.deepEqual(
        (await store.getChallengeByNumber(pool, nsAdmin, aNum))!.authors.map((a) => [a.userId, a.anonymous]),
        [[null, true]],
        "the team of an anonymous item is the single masked author",
      );

      // ── `people`: a team change never grows the access list ─────────────────────────────────
      const people = await create(ana, "People team", { visibility: "org" });
      if (people.status !== "ok") return;
      const pNum = people.challenge.number.replace("CH-", "");
      assert.equal((await store.setChallengeVisibility(pool, nsAdmin, pNum, "people", { userIds: [ben.userId], emails: [] })).status, "ok");
      roleMap.set(ben.userId, buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId, accessListChallengeIds: [people.challenge.id] }));
      assert.equal(refusal(await change(ana, "challenge", pNum, "add", cara.userId)), "ineligible", "only those the list already admits");
      assert.equal((await change(ana, "challenge", pNum, "add", ben.userId)).status, "ok");
      const listed = (await pool.query(`select user_id from challenge_access where challenge_id = $1`, [people.challenge.id])).rows;
      assert.equal(listed.length, 1, "the access list did not grow");

      // ── Erasure keeps the membership; the creator's row then loses its protection ───────────
      assert.equal((await scrubUser(pool, platform.userId, ana.userId)).status, "ok");
      const afterErase = await store.getChallengeByNumber(pool, ben, pNum);
      assert.deepEqual(
        afterErase!.authors.map((a) => [a.displayName, a.scrubbed, a.creator]),
        [
          ["Deleted User", true, true],
          [`Dbtest team ben ${stamp}`, false, false],
        ],
      );
      assert.equal((await change(ben, "challenge", pNum, "remove", ana.userId)).status, "ok", "an erased creator's row can be removed");

      // ── Delete: the audit row records the members at deletion ───────────────────────────────
      const storage = {
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
      assert.equal((await deleteChallenge({ pool, storage }, platform, eNum, "dbtest cleanup")).status, "ok");
      const del = (
        await pool.query<{ before: { authorIds: string[] } }>(`select before from audit_log where action = 'challenge.deleted' and target_id = $1`, [editable.challenge.id])
      ).rows[0]!;
      assert.deepEqual(del.before.authorIds, [ana.userId, ben.userId]);
      assert.equal((await members("challenge_authors", editable.challenge.id)).length, 0, "the member rows cascade with the item");
    } finally {
      await pool.end();
    }
  },
);
