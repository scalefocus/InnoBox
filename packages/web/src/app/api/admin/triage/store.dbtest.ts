// Live-DB integration test (gated) for Phase 4: dashboard KPIs/spotlights (§13.2),
// leaderboard ranking + anonymity exclusion (§13.3), search — FTS + exact number lookup,
// visibility filtering (§13.4), own/public profile (§13.5), admin triage queue + bulk
// actions + CSV export (§14.1), and platform settings — impact areas, attachment limits,
// date format (§14.3). Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "Phase 4: dashboard, leaderboard, search, profile, admin triage, platform settings",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, setChallengeStatus, setSolutionStatus, setChallengeAssignee } = await import(
      "../../challenges/store"
    );
    const { toggleLike } = await import("../../challenges/store");
    const { getDashboard } = await import("../../dashboard/store");
    const { getLeaderboard } = await import("../../leaderboards/store");
    const { search } = await import("../../search/store");
    const { getOwnProfile, getPublicProfile } = await import("../../profile/store");
    const { adminNamespaceIds, listTriageQueue, bulkSetStatus, bulkAssign, exportTriageCsv } = await import("./store");
    const { getAttachmentLimits, setAttachmentLimits, getDateFormat, setDateFormat, createImpactArea, patchImpactArea, listAllImpactAreas, deleteImpactArea } =
      await import("../settings/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;

      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Phase4 NS') returning id`,
        [`dbtest-p4-${stamp}`],
      );
      const nsId = nsRows[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email, department, job_title) values ($1, $2, $3, $4, $5, $6) returning id`,
          [
            `dbtest-p4-${label}-${stamp}`,
            `dbtest-p4-${label}-${stamp}@example.test`,
            `Dbtest P4 ${label} ${stamp}`,
            `${label}-${stamp}@example.test`,
            "Engineering",
            "Tester",
          ],
        );
        return rows[0]!.id;
      };
      const winnerId = await mkUser("winner");
      const anonAuthorId = await mkUser("anonauthor");
      const adminId = await mkUser("admin");
      const likerId = await mkUser("liker");

      const winner = { userId: winnerId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const anonAuthor = { userId: anonAuthorId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const admin = { userId: adminId, roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const liker = { userId: likerId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      // The bulk actions' §12.1 visibility drop: every fixture user is a member of the namespace.
      const resolveRoles = async () => buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId });

      const { rows: areaRows } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const areaId = areaRows[0]!.id;

      // ── Fixtures: two challenges — one from a non-anonymous "winner" (solved via an
      // implemented solution), one from an anonymous author (never counts on the
      // leaderboard while anonymous). ─────────────────────────────────────────────────
      const winnerChallenge = await createChallenge(pool, winner, {
        impactAreaId: areaId,
        namespaceId: nsId,
        title: `P4 winner challenge ${stamp}`,
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(winnerChallenge.status, "ok");
      if (winnerChallenge.status !== "ok") return;
      const winnerNumber = winnerChallenge.challenge.number.replace("CH-", "");

      await setChallengeStatus(pool, admin, winnerNumber, "valid");
      const winnerSolution = await createSolution(pool, winner, winnerNumber, {
        description: `P4 winning solution ${stamp}`,
        costVsBenefits: null,
        isAnonymous: false,
      });
      assert.equal(winnerSolution.status, "ok");
      if (winnerSolution.status !== "ok") return;
      const winnerSolutionNumber = winnerSolution.solution.number.replace("SOL-", "");

      await toggleLike(pool, liker, "challenge", winnerChallenge.challenge.id);
      await setSolutionStatus(pool, admin, winnerSolutionNumber, "accepted_internally");
      await setSolutionStatus(pool, admin, winnerSolutionNumber, "waiting_for_resources");
      await setSolutionStatus(pool, admin, winnerSolutionNumber, "in_implementation");
      const implementedResult = await setSolutionStatus(pool, admin, winnerSolutionNumber, "implemented");
      assert.equal(implementedResult.status, "ok");

      const anonChallenge = await createChallenge(pool, anonAuthor, {
        impactAreaId: areaId,
        namespaceId: nsId,
        title: `P4 anonymous challenge ${stamp}`,
        description: "d2",
        clientName: null,
        visibility: "org",
        isAnonymous: true,
      });
      assert.equal(anonChallenge.status, "ok");
      if (anonChallenge.status !== "ok") return;
      const anonNumber = anonChallenge.challenge.number.replace("CH-", "");
      await setChallengeStatus(pool, admin, anonNumber, "in_review");

      // ── Dashboard (§13.2): KPIs count both challenges (solved + in_review); spotlight
      // picks up the just-implemented solution. ──────────────────────────────────────
      const dashboard = await getDashboard(pool, admin);
      assert.ok((dashboard.kpis.challenges.solved ?? 0) >= 1);
      assert.ok((dashboard.kpis.challenges.in_review ?? 0) >= 1);
      assert.ok((dashboard.kpis.solutions.implemented ?? 0) >= 1);
      assert.ok(dashboard.spotlights.lastImplemented !== null);
      assert.equal(dashboard.spotlights.lastImplemented?.number, winnerSolution.solution.number);

      // ── Leaderboard (§13.3): the non-anonymous winner ranks; the anonymous author's
      // challenge never appears (excluded until self-reveal). ────────────────────────
      const implementedBoard = await getLeaderboard(pool, "solutions_implemented", "all");
      const winnerEntry = implementedBoard.find((e) => e.userId === winnerId);
      assert.ok(winnerEntry, "winner should appear on the solutions_implemented leaderboard");
      assert.ok((winnerEntry?.count ?? 0) >= 1);

      const submittedBoard = await getLeaderboard(pool, "challenges_submitted", "all");
      assert.equal(
        submittedBoard.some((e) => e.userId === anonAuthorId),
        false,
        "an anonymous author's challenge must never count on the leaderboard",
      );

      const likesBoard = await getLeaderboard(pool, "likes_received", "all");
      const winnerLikes = likesBoard.find((e) => e.userId === winnerId);
      assert.ok(winnerLikes && winnerLikes.count >= 1);

      // ── Search (§13.4): exact number lookup, FTS by title, and visibility-safe (the
      // anonymous author's masked identity never leaks through the search author field). ──
      const byNumber = await search(pool, admin, winnerChallenge.challenge.number);
      assert.equal(byNumber.challenges.length, 1);
      assert.equal(byNumber.challenges[0]!.number, winnerChallenge.challenge.number);

      const byText = await search(pool, admin, `P4 winner challenge ${stamp}`);
      assert.ok(byText.challenges.some((c) => c.number === winnerChallenge.challenge.number));

      const anonSearch = await search(pool, liker, `P4 anonymous challenge ${stamp}`);
      const anonHit = anonSearch.challenges.find((c) => c.number === anonChallenge.challenge.number);
      assert.ok(anonHit);
      assert.equal(anonHit!.author.anonymous, true);
      assert.equal(anonHit!.author.displayName, "Anonymous");

      // ── Profile (§13.5): own profile sees full status breakdown; a public profile of
      // the anonymous author shows none of their anonymous work. ─────────────────────
      const ownProfile = await getOwnProfile(pool, winnerId);
      assert.ok(ownProfile);
      assert.ok((ownProfile!.challengesByStatus.solved ?? 0) >= 1);
      assert.ok((ownProfile!.solutionsByStatus.implemented ?? 0) >= 1);
      assert.ok(ownProfile!.likesReceived >= 1);

      const publicOfAnon = await getPublicProfile(pool, anonAuthorId);
      assert.ok(publicOfAnon);
      assert.equal(publicOfAnon!.contributions.challenges.length, 0, "an anonymous author's own contributions are never public");

      // ── Admin triage (§14.1): namespace admin sees the namespace's queue, bulk status
      // + bulk assign each apply and audit individually, CSV export audits row count. ──
      assert.deepEqual(adminNamespaceIds(admin.roles), [nsId]);
      const queue = await listTriageQueue(pool, admin, { namespaceId: nsId });
      assert.ok(queue.total >= 2, "the namespace admin's queue should see both fixture challenges");
      assert.ok(queue.rows.some((r) => r.number === anonChallenge.challenge.number && r.authorAnonymous === true && r.authorDisplayName === "Anonymous"));

      // Pagination: pageSize=1 returns exactly one row per page, but the correct total.
      const page1 = await listTriageQueue(pool, admin, { namespaceId: nsId }, { page: 1, pageSize: 1 });
      assert.equal(page1.rows.length, 1);
      assert.equal(page1.total, queue.total);
      const page2 = await listTriageQueue(pool, admin, { namespaceId: nsId }, { page: 2, pageSize: 1 });
      assert.equal(page2.rows.length, 1);
      assert.notEqual(page1.rows[0]!.number, page2.rows[0]!.number);

      const bulkStatusOutcomes = await bulkSetStatus(pool, admin, [anonNumber], "valid", resolveRoles);
      assert.deepEqual(bulkStatusOutcomes, [{ number: anonChallenge.challenge.number, status: "ok" }]);
      await assertAudited(pool, "challenge.status_changed", anonChallenge.challenge.id);

      const bulkAssignOutcomes = await bulkAssign(pool, admin, [anonNumber], winnerId, resolveRoles);
      assert.deepEqual(bulkAssignOutcomes, [{ number: anonChallenge.challenge.number, status: "ok" }]);
      await assertAudited(pool, "challenge.assigned", anonChallenge.challenge.id);

      const { rows: preExportCount } = await pool.query(`select count(*) from audit_log where action = 'triage.exported'`);
      await exportTriageCsv(pool, admin, { namespaceId: nsId });
      const { rows: postExportCount } = await pool.query(`select count(*) from audit_log where action = 'triage.exported'`);
      assert.equal(Number(postExportCount[0]!.count), Number(preExportCount[0]!.count) + 1);

      // A committee-only (non-admin) viewer has no admin namespaces at all.
      const outsider = { userId: likerId, roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      assert.deepEqual(adminNamespaceIds(outsider.roles), []);

      // ── Platform settings (§14.3): impact area create/rename/retire, attachment
      // limits, date format — all round-trip and audit. ──────────────────────────────
      const created = await createImpactArea(pool, `Dbtest Area ${stamp}`, adminId);
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      await assertAudited(pool, "impact_area.created", created.area.id);

      const renamed = await patchImpactArea(pool, created.area.id, { name: `Dbtest Area Renamed ${stamp}` }, adminId);
      assert.equal(renamed.status, "ok");
      await assertAudited(pool, "impact_area.renamed", created.area.id);

      const retired = await patchImpactArea(pool, created.area.id, { active: false }, adminId);
      assert.equal(retired.status, "ok");
      if (retired.status === "ok") assert.equal(retired.area.active, false);
      await assertAudited(pool, "impact_area.retired", created.area.id);

      const allAreas = await listAllImpactAreas(pool);
      assert.ok(allAreas.some((a) => a.id === created.area.id && a.active === false));

      // ── Impact-area delete (§14.3): only retired; reassign-or-zero-reference; Client excluded. ──
      // An active area cannot be deleted.
      const activeArea = await createImpactArea(pool, `Dbtest Active ${stamp}`, adminId);
      assert.equal(activeArea.status, "ok");
      if (activeArea.status !== "ok") return;
      assert.equal((await deleteImpactArea(pool, activeArea.area.id, null, adminId)).status, "not_retired");

      // The retired, zero-reference `created` area deletes cleanly and is audited + gone from the list.
      assert.equal((await deleteImpactArea(pool, created.area.id, null, adminId)).status, "ok");
      await assertAudited(pool, "impact_area.deleted", created.area.id);
      assert.ok(!(await listAllImpactAreas(pool)).some((a) => a.id === created.area.id));

      // A retired area that still has a challenge (with a client_name) — reassign it to Internal.
      const srcArea = await createImpactArea(pool, `Dbtest Src ${stamp}`, adminId);
      assert.equal(srcArea.status, "ok");
      if (srcArea.status !== "ok") return;
      const { rows: chRows } = await pool.query<{ id: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, client_name, is_anonymous, author_id)
         values ($1, 'org', $2, 'd', $3, 'Acme Corp', false, $4) returning id`,
        [nsId, `Dbtest src challenge ${stamp}`, srcArea.area.id, adminId],
      );
      const movedChallengeId = chRows[0]!.id;
      await patchImpactArea(pool, srcArea.area.id, { active: false }, adminId);

      // listAllImpactAreas surfaces the reference count for the UI tooltip.
      assert.equal((await listAllImpactAreas(pool)).find((a) => a.id === srcArea.area.id)?.challengeCount, 1);

      // Referenced + no target → rejected (never a silent partial delete).
      assert.equal((await deleteImpactArea(pool, srcArea.area.id, null, adminId)).status, "has_references");
      // Invalid targets: self, and Client (a client_name a bulk move can't supply).
      assert.equal((await deleteImpactArea(pool, srcArea.area.id, srcArea.area.id, adminId)).status, "invalid_target");
      const { rows: clientRows } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Client'`);
      assert.equal((await deleteImpactArea(pool, srcArea.area.id, clientRows[0]!.id, adminId)).status, "invalid_target");
      // Invalid target: an inactive area.
      const inactiveTarget = await createImpactArea(pool, `Dbtest InactiveTgt ${stamp}`, adminId);
      if (inactiveTarget.status !== "ok") return;
      await patchImpactArea(pool, inactiveTarget.area.id, { active: false }, adminId);
      assert.equal((await deleteImpactArea(pool, srcArea.area.id, inactiveTarget.area.id, adminId)).status, "invalid_target");
      // Unknown target uuid → target_not_found.
      assert.equal((await deleteImpactArea(pool, srcArea.area.id, randomUUID(), adminId)).status, "target_not_found");

      // Valid reassignment to Internal: challenge moves, client_name is cleared, everything audited.
      assert.equal((await deleteImpactArea(pool, srcArea.area.id, areaId, adminId)).status, "ok");
      const { rows: moved } = await pool.query<{ impact_area_id: string; client_name: string | null }>(
        `select impact_area_id, client_name from challenges where id = $1`,
        [movedChallengeId],
      );
      assert.equal(moved[0]!.impact_area_id, areaId);
      assert.equal(moved[0]!.client_name, null);
      await assertAudited(pool, "challenge.edited", movedChallengeId);
      await assertAudited(pool, "impact_area.deleted", srcArea.area.id);
      assert.ok(!(await listAllImpactAreas(pool)).some((a) => a.id === srcArea.area.id));

      // Attachment limits are a platform-wide setting shared with attachments/store.dbtest.ts
      // (whose cap loop reads it) — restore the original so the change can't leak across suites.
      const originalLimits = await getAttachmentLimits(pool);
      await setAttachmentLimits(pool, { maxPerItem: 3, maxUploadSizeMb: 7, chunkSizeMb: 5 }, adminId);
      const limits = await getAttachmentLimits(pool);
      assert.deepEqual(limits, { maxPerItem: 3, maxUploadSizeMb: 7, chunkSizeMb: 5 });
      await assertAudited(pool, "settings.attachment_limits_changed", "attachment_limits");
      await setAttachmentLimits(pool, originalLimits, adminId);

      await setDateFormat(pool, "us", adminId);
      assert.equal(await getDateFormat(pool), "us");
      await setDateFormat(pool, "eu", adminId);
      assert.equal(await getDateFormat(pool), "eu");
      await assertAudited(pool, "settings.date_format_changed", "date_format");
    } finally {
      await pool.end();
    }
  },
);

test(
  "triage filter by a specific assignee (§14.1): returns only that person's challenges",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, setChallengeAssignee } = await import("../../challenges/store");
    const { listTriageQueue } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsr } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Triage Assignee NS') returning id`,
        [`dbtest-ta-${stamp}`],
      );
      const nsId = nsr[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-ta-${label}-${stamp}`, `dbtest-ta-${label}-${stamp}@example.test`, `Dbtest TA ${label} ${stamp}`],
        );
        return rows[0]!.id;
      };
      const adminId = await mkUser("admin");
      const aliceId = await mkUser("alice");
      const bobId = await mkUser("bob");
      const admin = { userId: adminId, roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const author = { userId: aliceId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const areaId = ia[0]!.id;

      const mk = async (title: string) => {
        const c = await createChallenge(pool, author, { impactAreaId: areaId, namespaceId: nsId, title, description: "d", clientName: null, visibility: "namespace", isAnonymous: false });
        assert.equal(c.status, "ok");
        if (c.status !== "ok") throw new Error("setup failed");
        return c.challenge.number.replace("CH-", "");
      };
      const chAlice = await mk(`TA alice ${stamp}`);
      const chBob = await mk(`TA bob ${stamp}`);
      const chNone = await mk(`TA none ${stamp}`);
      assert.equal((await setChallengeAssignee(pool, admin, chAlice, aliceId)).status, "ok");
      assert.equal((await setChallengeAssignee(pool, admin, chBob, bobId)).status, "ok");

      // Filter by a specific person → only their challenge, with the assignee name populated.
      const byAlice = await listTriageQueue(pool, admin, { namespaceId: nsId, assigneeId: aliceId });
      const aliceNums = byAlice.rows.map((r) => r.number.replace("CH-", ""));
      assert.ok(aliceNums.includes(chAlice), "the alice-assigned challenge is listed");
      assert.ok(!aliceNums.includes(chBob), "the bob-assigned challenge is excluded");
      assert.ok(!aliceNums.includes(chNone), "the unassigned challenge is excluded");
      assert.ok(byAlice.rows.every((r) => r.assigneeDisplayName !== null), "specific-assignee rows carry the assignee name");

      // "Unassigned" still works alongside → includes the unassigned one, excludes the assigned.
      const unassigned = await listTriageQueue(pool, admin, { namespaceId: nsId, assigneeId: "unassigned" });
      const noneNums = unassigned.rows.map((r) => r.number.replace("CH-", ""));
      assert.ok(noneNums.includes(chNone));
      assert.ok(!noneNums.includes(chAlice) && !noneNums.includes(chBob));
    } finally {
      await pool.end();
    }
  },
);

test(
  "§14.4 triage attention + solutions tab: unseen count, mark-seen reset, scoping, anonymity",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, setChallengeStatus } = await import("../../challenges/store");
    const { countTriageAttention, markTriageSeen, listTriageSolutions, adminNamespaceIds } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into namespaces (slug, display_name) values ($1, $2) returning id`,
          [`dbtest-att-${label}-${stamp}`, `Dbtest Attention ${label}`],
        );
        return rows[0]!.id;
      };
      const nsId = await mkNs("main");
      const nsOther = await mkNs("other");

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-att-${label}-${stamp}`, `dbtest-att-${label}-${stamp}@example.test`, `Dbtest Att ${label} ${stamp}`],
        );
        return rows[0]!.id;
      };
      const adminId = await mkUser("admin");
      const authorId = await mkUser("author");
      const otherAdminId = await mkUser("otheradmin");

      const admin = { userId: adminId, roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const author = { userId: authorId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const otherAdmin = { userId: otherAdminId, roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsOther }], { globalNamespaceId: globalId }) };

      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const areaId = ia[0]!.id;

      const mkChallenge = async (title: string) => {
        const c = await createChallenge(pool, author, {
          impactAreaId: areaId,
          namespaceId: nsId,
          title,
          description: "d",
          clientName: null,
          visibility: "namespace",
          isAnonymous: false,
        });
        assert.equal(c.status, "ok");
        if (c.status !== "ok") throw new Error("setup failed");
        return c.challenge.number.replace("CH-", "");
      };
      const mkProposedSolution = async (anonymous: boolean, title: string) => {
        const validNum = await mkChallenge(`${title} parent`);
        await setChallengeStatus(pool, admin, validNum, "valid");
        const sol = await createSolution(pool, author, validNum, { description: title, costVsBenefits: null, isAnonymous: anonymous });
        assert.equal(sol.status, "ok");
        if (sol.status !== "ok") throw new Error("setup failed");
        return { challengeNumber: `CH-${validNum}`, solutionNumber: sol.solution.number };
      };

      // Two awaiting_triage challenges + two proposed solutions (one anonymous) = 4 actionable.
      await mkChallenge(`Att A ${stamp}`);
      await mkChallenge(`Att B ${stamp}`);
      const namedSol = await mkProposedSolution(false, `Att named sol ${stamp}`);
      await mkProposedSolution(true, `Att anon sol ${stamp}`);

      // Fresh admin (null triage_seen_at) counts everything currently actionable in nsId.
      assert.equal(await countTriageAttention(pool, admin), 4);

      // Solutions tab lists both proposed solutions; the anonymous one is masked (§9).
      const sols = await listTriageSolutions(pool, admin, { page: 1, pageSize: 50 });
      assert.equal(sols.total, 2);
      const named = sols.rows.find((r) => r.challengeNumber === namedSol.challengeNumber);
      assert.ok(named && named.authorAnonymous === false && named.authorId !== null);
      const anon = sols.rows.find((r) => r.authorAnonymous === true);
      assert.ok(anon, "the anonymous solution appears masked");
      assert.equal(anon!.authorDisplayName, "Anonymous");
      assert.equal(anon!.authorId, null);

      // Namespace scoping: an admin of a different namespace sees none of nsId's items.
      assert.equal(await countTriageAttention(pool, otherAdmin), 0);
      assert.equal((await listTriageSolutions(pool, otherAdmin, { page: 1, pageSize: 50 })).total, 0);

      // A non-admin viewer has no admin namespaces → zero count, empty tab.
      const outsider = { userId: authorId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      assert.deepEqual(adminNamespaceIds(outsider.roles), []);
      assert.equal(await countTriageAttention(pool, outsider), 0);
      assert.equal((await listTriageSolutions(pool, outsider, { page: 1, pageSize: 50 })).total, 0);

      // Opening the queue clears it (§14.4): triage_seen_at = now() → count 0.
      await markTriageSeen(pool, adminId);
      assert.equal(await countTriageAttention(pool, admin), 0);

      // A newly-submitted challenge (after seen) re-raises the count to 1.
      await mkChallenge(`Att C ${stamp}`);
      assert.equal(await countTriageAttention(pool, admin), 1);
    } finally {
      await pool.end();
    }
  },
);

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  return { Pool, randomUUID };
}

async function assertAudited(pool: import("pg").Pool, action: string, targetId: string): Promise<void> {
  const { rows } = await pool.query(
    `select 1 from audit_log where action = $1 and target_id = $2 order by id desc limit 1`,
    [action, targetId],
  );
  assert.equal(rows.length, 1, `expected an audit_log row for ${action} / ${targetId}`);
}
