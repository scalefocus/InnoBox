// Live-DB integration test (gated) for the innovation board (INNOBOX_SPEC.md §45):
//  - the roster — add (all-or-nothing, a repeat skipped, an unknown / inactive / erased person
//    refusing the whole call), the 100th member allowed and the 101st refused, remove, the audit
//    rows, and membership arriving through the one role-resolution statement (§4.2);
//  - early read access (§45.3) — a member opens an `awaiting_triage` org challenge and a `proposed`
//    solution and finds the challenge in search and the similarity check, a non-member does not; a
//    member outside a namespace gets nothing of its restricted challenge, a member inside does;
//  - no powers (§45.4) — a member's status change is refused, and the §7.3 assignee gate judges a
//    member without the exemption, so it never tells a namespace admin who is on the board;
//  - events 1 and 2 (§45.5) — the board route's wording, the admin route winning for a member who is
//    also a namespace admin, the submitter and a co-author left out, a deactivated member left out,
//    the hold for a member on a digest, and no mute;
//  - event 28 (§45.6) — on an add, never to the acting admin, never held;
//  - the read-time gate (§45.5) — a removal hides the notice about a challenge still in triage, and
//    it returns once the challenge is triaged;
//  - erasure (§45.8) — the entry goes, `added_by` is nulled, and `user.scrubbed` says so.
// It runs as the least-privilege app role, so the migration's grants are exercised too. The board is
// platform-wide, so the suite takes its own members off again: a leftover member would become a
// recipient in every other suite. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§45 innovation board: roster, early read access, events 1 / 2 / 28, the read-time gate and erasure",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { BOARD_ADDED_SUBJECT, INNOVATION_BOARD_MAX, boardAddedMessage, boardChallengeSubmittedMessage } = await import("@innobox/shared");
    const { addBoardMembers, boardHasActiveMember, listBoardMembers, removeBoardMember } = await import("../app/api/admin/innovation-board/store");
    const { createChallenge, createSolution, findSimilarChallenges, getChallengeByNumber, listActiveImpactAreas, setChallengeAssignee, setChallengeStatus } = await import(
      "../app/api/challenges/store"
    );
    const { getInbox } = await import("../app/api/notifications/store");
    const { search } = await import("../app/api/search/store");
    const { scrubUser } = await import("../app/api/users/store");
    const { notifyBoardMembersAdded, notifyChallengeSubmitted, notifySolutionProposed } = await import("./notify-events");
    const { resolveRoleSets } = await import("./role-resolution");

    const pool = new Pool({ connectionString: url });
    /** Everyone this suite puts on the board — taken off again in `finally`. */
    const onBoard: string[] = [];
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const token = `zb${stamp}`;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Board NS') returning id`, [`dbtest-board-${stamp}`]);
      const nsId = ns[0]!.id;
      const mkUser = async (label: string, emailDelivery = "immediate") => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email, email_delivery) values ($1, $2, $3, $4, $5) returning id`,
          [`dbtest-board-${label}-${stamp}`, `dbtest-board-${label}-${stamp}@example.test`, `Dbtest Board ${label} ${stamp}`, `board-${label}-${stamp}@example.test`, emailDelivery],
        );
        return rows[0]!.id;
      };
      /** A group whose members hold `role` in the suite's namespace, through role_mappings (invariant 1). */
      const mkGroup = async (label: string, members: string[], role: "namespace_admin" | "member") => {
        const externalId = `dbtest-board-grp-${label}-${stamp}`;
        const { rows } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [externalId]);
        for (const userId of members) await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [rows[0]!.id, userId]);
        await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, $2, $3)`, [externalId, role, nsId]);
      };

      const admin = await mkUser("admin"); // the platform admin who keeps the board
      const admin2 = await mkUser("admin2");
      const nsAdmin = await mkUser("nsadmin"); // a namespace admin, not on the board
      const boardAdmin = await mkUser("boardadmin"); // a namespace admin who is also on the board
      const boardA = await mkUser("a"); // on the board, in no namespace but global
      const boardDaily = await mkUser("daily", "daily"); // on the board, on a daily digest
      const insider = await mkUser("insider"); // on the board and a member of the namespace
      const boardAuthor = await mkUser("author"); // on the board, and the submitter
      const boardCo = await mkUser("co"); // on the board, and the submitter's co-author
      const deactivated = await mkUser("deact"); // on the board, deactivated afterwards
      const plain = await mkUser("plain"); // nobody in particular
      const memberPlain = await mkUser("member"); // a member of the namespace, not on the board
      const solver = await mkUser("solver");
      const fanOn = await mkUser("fanon"); // follows the challenge
      const fanOff = await mkUser("fanoff"); // follows it too, with "new solutions" muted
      await mkGroup("admins", [nsAdmin, boardAdmin], "namespace_admin");
      await mkGroup("members", [insider, boardAuthor, boardCo, memberPlain], "member");

      // Roles are resolved for real — the one §4.2 statement, board membership included.
      const resolveRoles = Object.assign(async (userId: string) => (await resolveRoleSets(pool, [userId], null)).get(userId)!, {
        many: (userIds: readonly string[]) => resolveRoleSets(pool, userIds, null),
      });
      const viewerOf = async (userId: string) => ({ userId, roles: await resolveRoles(userId) });
      const ctx = (actorId: string) => ({ pool, actorId, resolveRoles });

      // ── The roster (§45.2, §45.10) ────────────────────────────────────────────────────────
      assert.equal((await viewerOf(boardA)).roles.isInnovationBoardMember, false);
      const members = [boardAdmin, boardA, boardDaily, insider, boardAuthor, boardCo, deactivated];
      const first = await addBoardMembers(pool, admin, members);
      assert.deepEqual(first, { status: "ok", added: members });
      onBoard.push(...members);
      assert.equal(await boardHasActiveMember(pool), true);
      assert.equal((await viewerOf(boardA)).roles.isInnovationBoardMember, true, "membership arrives through role resolution");
      assert.equal((await viewerOf(plain)).roles.isInnovationBoardMember, false);
      const many = await resolveRoles.many([boardA, plain, insider]);
      assert.deepEqual([many.get(boardA)!.isInnovationBoardMember, many.get(plain)!.isInnovationBoardMember, many.get(insider)!.isInnovationBoardMember], [true, false, true]);
      // It is no role: nothing an admin or reviewer check reads changes.
      assert.equal(many.get(boardA)!.isPlatformAdmin, false);
      assert.equal(many.get(boardA)!.isNamespaceAdmin(nsId), false);
      assert.equal(many.get(boardA)!.isMemberOf(nsId), false);

      // A repeat is skipped, not refused.
      assert.deepEqual(await addBoardMembers(pool, admin, [boardA]), { status: "ok", added: [] });
      // One ineligible person refuses the whole call — the eligible one beside them is not added.
      const inactiveUser = await mkUser("inactive");
      await pool.query(`update users set active = false where id = $1`, [inactiveUser]);
      const erasedUser = await mkUser("erased");
      await pool.query(`update users set scrubbed_at = now(), active = false where id = $1`, [erasedUser]);
      for (const bad of [randomUUID(), inactiveUser, erasedUser]) {
        assert.deepEqual(await addBoardMembers(pool, admin, [plain, bad]), { status: "ineligible" }, `ineligible: ${bad}`);
      }
      assert.equal((await viewerOf(plain)).roles.isInnovationBoardMember, false, "a refused add writes nothing");

      const roster = await listBoardMembers(pool);
      const mine = roster.filter((m) => members.includes(m.user.id));
      assert.equal(mine.length, members.length);
      const adminName = `Dbtest Board admin ${stamp}`;
      assert.deepEqual(mine.find((m) => m.user.id === boardA)!.addedBy, { id: admin, displayName: adminName });
      assert.equal(mine.find((m) => m.user.id === boardA)!.user.email, `board-a-${stamp}@example.test`);
      const audited = async (action: string, ids: string[]) =>
        Number((await pool.query<{ n: string }>(`select count(*) as n from audit_log where action = $1 and actor_user_id = $2 and target_id = any($3::text[])`, [action, admin, ids])).rows[0]!.n);
      assert.equal(await audited("innovation_board.member_added", members), members.length, "one audit row per person added");

      // The cap: the 100th member is allowed and the 101st refused; a person already on it is still skipped.
      const { rows: before } = await pool.query<{ n: number }>(`select count(*)::int as n from innovation_board_members`);
      const fillerCount = INNOVATION_BOARD_MAX - before[0]!.n - 1;
      const { rows: fillers } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, active)
         select 'dbtest-board-fill-' || i || '-' || $1::text, 'dbtest-board-fill-' || i || '-' || $1::text || '@example.test', 'Dbtest Board filler ' || i, false
           from generate_series(1, $2::int) as i
         returning id`,
        [stamp, fillerCount],
      );
      const fillerIds = fillers.map((r) => r.id);
      // Deactivated members count toward the cap (§45.2) — these are written straight to the table.
      await pool.query(`insert into innovation_board_members (user_id, added_by) select u, $2 from unnest($1::uuid[]) as u`, [fillerIds, admin]);
      onBoard.push(...fillerIds);
      const hundredth = await mkUser("hundredth");
      const overflow = await mkUser("overflow");
      assert.deepEqual(await addBoardMembers(pool, admin, [hundredth]), { status: "ok", added: [hundredth] });
      onBoard.push(hundredth);
      assert.deepEqual(await addBoardMembers(pool, admin, [overflow]), { status: "full" });
      assert.deepEqual(await addBoardMembers(pool, admin, [hundredth, overflow]), { status: "full" }, "all-or-nothing over the cap");
      assert.deepEqual(await addBoardMembers(pool, admin, [hundredth]), { status: "ok", added: [] }, "already on the board: skipped even at the cap");
      await pool.query(`delete from innovation_board_members where user_id = any($1::uuid[])`, [[...fillerIds, hundredth]]);

      await pool.query(`update users set active = false, deactivated_at = now() where id = $1`, [deactivated]);
      assert.equal((await listBoardMembers(pool)).find((m) => m.user.id === deactivated)!.user.active, false, "a deactivated member stays on the roster, flagged");

      // ── Early read access (§45.3) ─────────────────────────────────────────────────────────
      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const submit = async (title: string, visibility: "org" | "namespace", coAuthorIds: string[] = []) => {
        const created = await createChallenge(pool, await viewerOf(boardAuthor), {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title,
          description: `${token} board fixture`,
          clientName: null,
          visibility,
          isAnonymous: false,
          coAuthors: { ids: coAuthorIds, resolveRoles },
        });
        assert.equal(created.status, "ok");
        if (created.status !== "ok") throw new Error("fixture challenge not created");
        return { id: created.challenge.id, number: created.challenge.number, digits: created.challenge.number.replace(/\D/g, ""), title };
      };
      const orgCh = await submit(`${token}alpha ${token}beta org`, "org", [boardCo]);
      const nsCh = await submit(`${token}gamma ${token}delta restricted`, "namespace");
      const sees = async (userId: string, digits: string) => (await getChallengeByNumber(pool, await viewerOf(userId), digits)) !== null;

      assert.equal(await sees(boardA, orgCh.digits), true, "a member opens an org challenge in triage");
      assert.equal((await getChallengeByNumber(pool, await viewerOf(boardA), orgCh.digits))!.status, "awaiting_triage");
      assert.equal(await sees(plain, orgCh.digits), false, "a non-member still cannot");
      assert.equal(await sees(memberPlain, orgCh.digits), false, "namespace membership alone still waits for triage");
      assert.equal(await sees(boardA, nsCh.digits), false, "a member outside the namespace gets nothing of its restricted challenge");
      assert.equal(await sees(insider, nsCh.digits), true, "a member inside the namespace reads it in triage");
      assert.equal(await sees(memberPlain, nsCh.digits), false);
      assert.equal(await sees(deactivated, orgCh.digits), true, "the predicate is about the roles; a deactivated person simply cannot sign in");

      // The SQL twin agrees with the detail gate: search and the §6.1 similarity check.
      const found = async (userId: string) => (await search(pool, await viewerOf(userId), token)).challenges.map((c) => c.number).sort();
      assert.deepEqual(await found(boardA), [orgCh.number]);
      assert.deepEqual(await found(insider), [orgCh.number, nsCh.number].sort());
      assert.deepEqual(await found(plain), []);
      assert.deepEqual(await found(memberPlain), []);
      const similar = async (userId: string) =>
        (await findSimilarChallenges(pool, await viewerOf(userId), { title: `${token}alpha ${token}beta org`, description: `${token} board fixture` })).map((c) => c.number);
      assert.ok((await similar(boardA)).includes(orgCh.number), "a member's similarity check finds the challenge in triage");
      assert.ok(!(await similar(plain)).includes(orgCh.number));

      // ── No powers (§45.4) ─────────────────────────────────────────────────────────────────
      assert.equal((await setChallengeStatus(pool, await viewerOf(boardA), orgCh.digits, "in_review")).status, "forbidden", "a member moves nothing");
      // The assignee gate ignores the exemption: in triage a member is no more assignable than anyone.
      assert.equal((await setChallengeAssignee(pool, await viewerOf(nsAdmin), orgCh.digits, boardA, resolveRoles)).status, "assignee_cannot_see");
      assert.equal((await setChallengeAssignee(pool, await viewerOf(nsAdmin), orgCh.digits, plain, resolveRoles)).status, "assignee_cannot_see", "the same answer as for a non-member");

      // ── Event 1 (§45.5) ───────────────────────────────────────────────────────────────────
      const cast = [admin, nsAdmin, boardAdmin, boardA, boardDaily, insider, boardAuthor, boardCo, deactivated, plain, memberPlain, solver, fanOn, fanOff];
      /** This suite's people among the recipients of one type about one item: message and hold. */
      const told = async (type: string, parentId: string) => {
        const { rows } = await pool.query<{ user_id: string; message: string; held: boolean; kind: string | null }>(
          `select n.user_id, n.payload->>'message' as message, o.digest_due_at is not null as held, o.payload->'digest'->>'kind' as kind
             from notifications n
             join notification_outbox o on (o.payload->>'notificationId')::uuid = n.id
            where n.type = $1 and n.payload->>'parentId' = $2 and n.user_id = any($3::uuid[])`,
          [type, parentId, cast],
        );
        return new Map(rows.map((r) => [r.user_id, r]));
      };
      const needsTriage = (c: { number: string; title: string }) => `New challenge ${c.number} "${c.title}" needs triage.`;

      await notifyChallengeSubmitted(ctx(boardAuthor), { id: orgCh.id, number: orgCh.number, title: orgCh.title, namespaceId: nsId });
      const e1 = await told("challenge_submitted", orgCh.id);
      assert.deepEqual([...e1.keys()].sort(), [nsAdmin, boardAdmin, boardA, boardDaily, insider].sort(), "admins and the board — not the submitter, the co-author, the deactivated member or anyone else");
      assert.equal(e1.get(nsAdmin)!.message, needsTriage(orgCh));
      assert.equal(e1.get(boardAdmin)!.message, needsTriage(orgCh), "a member who is also a namespace admin gets the admin wording, once");
      assert.equal(e1.get(boardAdmin)!.held, false);
      assert.equal(e1.get(boardA)!.message, boardChallengeSubmittedMessage(orgCh.digits, orgCh.title));
      assert.equal(e1.get(boardA)!.message, `New challenge ${orgCh.number} "${orgCh.title}" was submitted.`);
      assert.equal(e1.get(boardA)!.held, false, "immediate for a member on immediate delivery");
      assert.deepEqual([e1.get(boardDaily)!.held, e1.get(boardDaily)!.kind], [true, "challenge"], "held for a member on a digest");
      assert.equal(e1.get(insider)!.message, boardChallengeSubmittedMessage(orgCh.digits, orgCh.title));

      await notifyChallengeSubmitted(ctx(boardAuthor), { id: nsCh.id, number: nsCh.number, title: nsCh.title, namespaceId: nsId });
      const e1ns = await told("challenge_submitted", nsCh.id);
      // boardCo is on the board and in the namespace, and this time not on the challenge's team.
      assert.deepEqual([...e1ns.keys()].sort(), [nsAdmin, boardAdmin, insider, boardCo].sort(), "a restricted challenge reaches only the board members who can see it");
      assert.equal(e1ns.has(boardA), false, "a member outside the namespace is told nothing about it");
      assert.equal(e1ns.get(insider)!.message, boardChallengeSubmittedMessage(nsCh.digits, nsCh.title));

      // ── A proposed solution, and event 2 (§45.3, §45.5) ───────────────────────────────────
      assert.equal((await setChallengeStatus(pool, await viewerOf(nsAdmin), orgCh.digits, "valid")).status, "ok");
      for (const fan of [fanOn, fanOff]) await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, 'challenge', $2)`, [fan, orgCh.id]);
      await pool.query(`update users set notify_followed_solutions = false where id = any($1::uuid[])`, [[fanOff, boardA]]);
      const proposed = await createSolution(pool, await viewerOf(solver), orgCh.digits, { description: `${token} a solution`, costVsBenefits: null, isAnonymous: false });
      assert.equal(proposed.status, "ok");
      if (proposed.status !== "ok") return;
      const solutionsSeenBy = async (userId: string) => (await getChallengeByNumber(pool, await viewerOf(userId), orgCh.digits))!.solutions.map((s) => s.id);
      assert.ok((await solutionsSeenBy(boardA)).includes(proposed.solution.id), "a member reads the proposed solution");
      assert.ok(!(await solutionsSeenBy(plain)).includes(proposed.solution.id), "a non-member does not");
      assert.ok((await search(pool, await viewerOf(boardA), token)).solutions.some((s) => s.number === proposed.solution.number), "and finds it in search");
      assert.ok(!(await search(pool, await viewerOf(plain), token)).solutions.some((s) => s.number === proposed.solution.number));

      await notifySolutionProposed(ctx(solver), orgCh.digits, proposed.solution);
      const e2 = await told("solution_proposed", proposed.solution.id);
      assert.deepEqual(
        [...e2.keys()].sort(),
        [nsAdmin, boardAdmin, boardA, boardDaily, insider, boardAuthor, boardCo, fanOn].sort(),
        "admins, the challenge's team, its followers and the board — not the proposer, the muted follower or the deactivated member",
      );
      assert.ok(e2.has(boardA), "the board route has no mute: 'New solutions on challenges I follow' off changes nothing for a member");
      assert.equal(e2.has(fanOff), false, "the same switch still mutes an ordinary follower");
      assert.equal(e2.get(boardDaily)!.held, true, "held for a member on a digest");
      assert.equal(e2.get(boardAdmin)!.held, false, "the admin route stays immediate");
      assert.equal(e2.get(boardA)!.message, `A new solution was proposed on ${orgCh.number} "${orgCh.title}".`);

      // ── Event 28 (§45.6) ──────────────────────────────────────────────────────────────────
      await notifyBoardMembersAdded(ctx(admin), [boardA, boardDaily, admin]);
      const { rows: added } = await pool.query<{ user_id: string; message: string; subject: string; link: string; item: string | null; held: boolean }>(
        `select n.user_id, n.payload->>'message' as message, o.payload->>'subject' as subject, n.payload->>'link' as link,
                n.payload->>'parentId' as item, o.digest_due_at is not null as held
           from notifications n join notification_outbox o on (o.payload->>'notificationId')::uuid = n.id
          where n.type = 'innovation_board_added' and n.user_id = any($1::uuid[])`,
        [cast],
      );
      assert.deepEqual(added.map((r) => r.user_id).sort(), [boardA, boardDaily].sort(), "the people added — never the acting admin");
      for (const row of added) {
        assert.equal(row.message, boardAddedMessage(adminName));
        assert.equal(row.subject, BOARD_ADDED_SUBJECT);
        assert.equal(row.link, "/profile");
        assert.equal(row.item, null, "it names no item");
        assert.equal(row.held, false, "actionable: never held, whatever the delivery choice");
      }

      // ── The read-time gate after a removal (§45.5, §45.8) ─────────────────────────────────
      const later = await submit(`${token}epsilon later`, "org");
      await notifyChallengeSubmitted(ctx(boardAuthor), { id: later.id, number: later.number, title: later.title, namespaceId: nsId });
      const inboxHas = async (userId: string, message: string) => (await getInbox(pool, await viewerOf(userId))).notifications.some((n) => n.message === message);
      const laterNotice = boardChallengeSubmittedMessage(later.digits, later.title);
      assert.equal(await inboxHas(boardA, laterNotice), true);
      assert.equal(await inboxHas(boardA, boardAddedMessage(adminName)), true);

      const rowsFor = async (userId: string) => Number((await pool.query<{ n: string }>(`select count(*) as n from notifications where user_id = $1`, [userId])).rows[0]!.n);
      const beforeRemoval = await rowsFor(boardA);
      assert.equal(await removeBoardMember(pool, admin, boardA), "ok");
      assert.equal(await rowsFor(boardA), beforeRemoval, "a removal is silent: it writes no notification");
      assert.equal(await removeBoardMember(pool, admin, boardA), "not_found");
      assert.equal(await audited("innovation_board.member_removed", [boardA]), 1);
      assert.equal((await viewerOf(boardA)).roles.isInnovationBoardMember, false, "effective at the next resolution");
      assert.equal(await sees(boardA, later.digits), false, "the early access is gone");
      assert.equal(await inboxHas(boardA, laterNotice), false, "the notice about a challenge still in triage is hidden");
      assert.equal(await inboxHas(boardA, boardAddedMessage(adminName)), true, "a row that names no item is untouched");
      assert.equal((await setChallengeStatus(pool, await viewerOf(nsAdmin), later.digits, "in_review")).status, "ok");
      assert.equal(await inboxHas(boardA, laterNotice), true, "and it returns once the challenge is triaged");

      // ── Erasure (§45.8) ───────────────────────────────────────────────────────────────────
      const erasedMember = await scrubUser(pool, admin, insider);
      assert.equal(erasedMember.status, "ok");
      const { rows: gone } = await pool.query(`select 1 from innovation_board_members where user_id = $1`, [insider]);
      assert.equal(gone.length, 0, "the erased person's entry is deleted");
      const scrubRow = async (userId: string) =>
        (await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'user.scrubbed' and target_id = $1`, [userId])).rows[0]!.after;
      assert.equal((await scrubRow(insider)).boardMember, true);
      // Erasing the admin who added people nulls who added them; the entries stay.
      assert.equal((await scrubUser(pool, admin2, admin)).status, "ok");
      assert.equal("boardMember" in (await scrubRow(admin)), false, "absent when the erased person was not on the board");
      const afterAdmin = (await listBoardMembers(pool)).filter((m) => [boardDaily, boardAdmin].includes(m.user.id));
      assert.equal(afterAdmin.length, 2);
      for (const m of afterAdmin) assert.equal(m.addedBy, null);
    } finally {
      if (onBoard.length > 0) await pool.query(`delete from innovation_board_members where user_id = any($1::uuid[])`, [onBoard]).catch(() => {});
      await pool.end();
    }
  },
);
