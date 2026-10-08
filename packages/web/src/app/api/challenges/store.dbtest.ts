// Live-DB integration test (gated) for the challenges/solutions/likes data layer
// (INNOBOX_SPEC.md §13.1). Exercises real SQL visibility filtering, the §8.3 single-winner
// gate + implemented auto-close cascade, anonymity masking, and the audit trail — the parts
// too DB-dependent for the hermetic @innobox/shared unit tests. Self-skips when
// DATABASE_URL is unset. Namespaces/users/challenges/solutions are never hard-deleted by
// the app, so this test leaves its rows behind (routine for a throwaway/dev database).
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "challenges/solutions/likes: visibility, §8.3 gate + auto-close, masking, audit",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const {
      createChallenge,
      createSolution,
      getChallengeByNumber,
      listActiveImpactAreas,
      listChallenges,
      setChallengeStatus,
      setSolutionStatus,
      toggleLike,
    } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);

      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;

      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Challenges NS') returning id`,
        [`dbtest-ch-${stamp}`],
      );
      const nsId = nsRows[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-ch-${label}-${stamp}`, `dbtest-ch-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const authorId = await mkUser("author");
      const adminId = await mkUser("admin");
      const outsiderId = await mkUser("outsider");
      const memberId = await mkUser("member");

      const author = {
        userId: authorId,
        roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }),
      };
      const admin = {
        userId: adminId,
        roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }),
      };
      const outsider = { userId: outsiderId, roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      const member = {
        userId: memberId,
        roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }),
      };

      const impactAreas = await listActiveImpactAreas(pool);
      const client = impactAreas.find((a) => a.name === "Client")!;
      const internal = impactAreas.find((a) => a.name === "Internal")!;
      assert.ok(client && internal, "seeded impact areas present");

      // 1. clientName required iff impact area is Client.
      const missingClientName = await createChallenge(pool, author, {
        impactAreaId: client.id,
        namespaceId: nsId,
        title: "Needs a client",
        description: "d",
        clientName: "",
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(missingClientName.status, "invalid");

      // 2. Submitting into a namespace you're not a member of is refused.
      const forbiddenNs = await createChallenge(pool, outsider, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: "Not my namespace",
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(forbiddenNs.status, "forbidden_namespace");

      // 3. Happy path: namespace-visible challenge, starts at awaiting_triage.
      const created = await createChallenge(pool, author, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: "A namespace-restricted idea",
        description: "Details",
        clientName: null,
        visibility: "namespace",
        isAnonymous: false,
      });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const challengeNumber = created.challenge.number.replace("CH-", "");
      assert.equal(created.challenge.status, "awaiting_triage");
      await assertAudited(pool, "challenge.created", created.challenge.id);

      // 4. awaiting_triage: outsider and mere namespace member cannot see it; author and
      //    namespace admin can.
      assert.equal(await getChallengeByNumber(pool, outsider, challengeNumber), null);
      assert.equal(await getChallengeByNumber(pool, member, challengeNumber), null);
      assert.ok(await getChallengeByNumber(pool, author, challengeNumber));
      assert.ok(await getChallengeByNumber(pool, admin, challengeNumber));

      // 5. Non-admin cannot override status — and since an awaiting_triage challenge is invisible
      //    to a mere member, the refusal is "not found", never "forbidden" (§2.4).
      const forbiddenOverride = await setChallengeStatus(pool, member, challengeNumber, "valid");
      assert.equal(forbiddenOverride.status, "not_found");

      // 6. Admin override to valid — audited, and now namespace members (not just the
      //    author/admin) can see it since it's no longer awaiting_triage.
      const toValid = await setChallengeStatus(pool, admin, challengeNumber, "valid");
      assert.equal(toValid.status, "ok");
      await assertAudited(pool, "challenge.status_changed", created.challenge.id);
      assert.ok(await getChallengeByNumber(pool, member, challengeNumber));
      assert.equal(await getChallengeByNumber(pool, outsider, challengeNumber), null); // still namespace-only

      // 7. Propose a solution while valid — ok, audited, visible only to author/committee/
      //    admins while `proposed` (a mere namespace member cannot see it yet).
      const sol1 = await createSolution(pool, author, challengeNumber, {
        description: "Solution one",
        costVsBenefits: null,
        isAnonymous: false,
      });
      assert.equal(sol1.status, "ok");
      if (sol1.status !== "ok") return;
      await assertAudited(pool, "solution.created", sol1.solution.id);
      const detailForMember = await getChallengeByNumber(pool, member, challengeNumber);
      assert.equal(detailForMember!.solutions.length, 0, "proposed solution hidden from a mere member");
      // §13.6 avatar key: a NON-anonymous author exposes their real userId (the anonymous case
      // asserts userId:null below) — so the client can render their photo bubble.
      assert.equal(detailForMember!.author.userId, authorId, "non-anonymous author exposes userId for the avatar");
      const detailForAdmin = await getChallengeByNumber(pool, admin, challengeNumber);
      assert.equal(detailForAdmin!.solutions.length, 1, "proposed solution visible to namespace admin");

      // 8. A second solution on the same (still valid) challenge.
      const sol2 = await createSolution(pool, member, challengeNumber, {
        description: "Solution two",
        costVsBenefits: "cheap",
        isAnonymous: false,
      });
      assert.equal(sol2.status, "ok");
      if (sol2.status !== "ok") return;

      // 9. §8.3 single-winner gate: accept solution one, then try to accept solution two.
      const sol1Number = sol1.solution.number.replace("SOL-", "");
      const sol2Number = sol2.solution.number.replace("SOL-", "");
      const accept1 = await setSolutionStatus(pool, admin, sol1Number, "accepted_internally");
      assert.equal(accept1.status, "ok");
      const accept2Blocked = await setSolutionStatus(pool, admin, sol2Number, "accepted_internally");
      assert.equal(accept2Blocked.status, "blocked_single_winner");

      // 10. Implementing solution one auto-closes the challenge and solution two.
      const implemented = await setSolutionStatus(pool, admin, sol1Number, "implemented");
      assert.equal(implemented.status, "ok");
      const finalChallenge = await getChallengeByNumber(pool, admin, challengeNumber);
      assert.equal(finalChallenge!.status, "solved");
      assert.ok(finalChallenge!.resolvedAt);
      const sol2Final = finalChallenge!.solutions.find((s) => s.number === sol2.solution.number);
      assert.equal(sol2Final!.status, "not_selected");
      await assertAudited(pool, "challenge.status_changed", created.challenge.id); // the auto-close row
      await assertAudited(pool, "solution.status_changed", sol2.solution.id); // the auto-closed sibling

      // 11. Likes are frozen on the now-solved challenge (§8.3) — the full toggle is covered on
      //     an open challenge in likes-frozen.dbtest.ts.
      assert.deepEqual(await toggleLike(pool, member, "challenge", created.challenge.id), { status: "frozen" });

      // 12. Anonymity masking is total — even the author's own view shows "Anonymous".
      const anon = await createChallenge(pool, author, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: "An anonymous idea",
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: true,
      });
      assert.equal(anon.status, "ok");
      if (anon.status !== "ok") return;
      assert.deepEqual(anon.challenge.author, { userId: null, displayName: "Anonymous", anonymous: true });
      const anonNumber = anon.challenge.number.replace("CH-", "");
      const anonForAuthor = await getChallengeByNumber(pool, author, anonNumber);
      assert.deepEqual(anonForAuthor!.author, { userId: null, displayName: "Anonymous", anonymous: true });
      // Still awaiting_triage, so only the author/namespace-admin can see it at all (§4.3) —
      // masking is checked against the admin here, not a random outsider who'd get null
      // regardless of anonymity.
      const anonForAdmin = await getChallengeByNumber(pool, admin, anonNumber);
      assert.deepEqual(anonForAdmin!.author, { userId: null, displayName: "Anonymous", anonymous: true });

      // 13. List filtering: the anonymous org-visible challenge appears in "open"... it's
      //     still awaiting_triage though, so it only shows on "mine" for its author.
      const mine = await listChallenges(pool, author, { tab: "mine", sort: "newest" });
      assert.ok(mine.some((c) => c.id === anon.challenge.id));
      const openForOutsider = await listChallenges(pool, outsider, { tab: "open", sort: "newest" });
      assert.ok(!openForOutsider.some((c) => c.id === anon.challenge.id), "awaiting_triage excluded from Open");
    } finally {
      await pool.end();
    }
  },
);

test(
  "enforced committee/assignee state machine (§7.2/§8.2): role gating, legal arrows, audit override flag",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, getChallengeByNumber, listActiveImpactAreas, setChallengeAssignee, setChallengeStatus, setSolutionStatus } =
      await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest SM NS') returning id`,
        [`dbtest-sm-${stamp}`],
      );
      const nsId = nsRows[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-sm-${label}-${stamp}`, `dbtest-sm-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });

      const author = { userId: await mkUser("sm-author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const admin = { userId: await mkUser("sm-admin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const committee = { userId: await mkUser("sm-committee"), roles: roles([{ role: "committee", namespaceId: nsId }]) };
      const assignee = { userId: await mkUser("sm-assignee"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const member = { userId: await mkUser("sm-member"), roles: roles([{ role: "member", namespaceId: nsId }]) };

      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const mkChallenge = async (title: string) => {
        const c = await createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title,
          description: "d",
          clientName: null,
          visibility: "namespace",
          isAnonymous: false,
        });
        assert.equal(c.status, "ok");
        if (c.status !== "ok") throw new Error("setup failed");
        return { id: c.challenge.id, number: c.challenge.number.replace("CH-", "") };
      };

      // ── Part A: committee on a challenge ──────────────────────────────────────────────
      const ch1 = await mkChallenge("SM committee challenge");

      // Triage (leaving awaiting_triage) is admin-only. The committee cannot even SEE an
      // awaiting_triage challenge (§4.3), so the attempt is not_found rather than an illegal
      // arrow (§2.4); the illegal-arrow refusal is pinned below on a visible challenge.
      assert.equal((await setChallengeStatus(pool, committee, ch1.number, "in_review")).status, "not_found");
      // A mere member cannot even see an awaiting_triage challenge → not_found (§2.4), not forbidden.
      assert.equal((await setChallengeStatus(pool, member, ch1.number, "in_review")).status, "not_found");
      // Admin triages via free-set override.
      assert.equal((await setChallengeStatus(pool, admin, ch1.number, "in_review")).status, "ok");
      await assertAuditOverride(pool, "challenge.status_changed", ch1.id, true);

      // At in_review the committee's allowedTransitions are exactly the §7.2 arrows; the admin
      // gets none (they use the free-set override instead).
      const committeeView = await getChallengeByNumber(pool, committee, ch1.number);
      assert.deepEqual(new Set(committeeView!.allowedTransitions), new Set(["valid", "needs_improvement", "meeting_scheduled", "rejected"]));
      const adminView = await getChallengeByNumber(pool, admin, ch1.number);
      assert.deepEqual(adminView!.allowedTransitions, []);
      assert.equal(adminView!.canOverrideStatus, true);

      // Committee makes a legal enforced transition — audited override:false.
      assert.equal((await setChallengeStatus(pool, committee, ch1.number, "valid")).status, "ok");
      await assertAuditOverride(pool, "challenge.status_changed", ch1.id, false);
      // valid → solved is automatic/admin-only, so it is NOT a legal committee arrow.
      assert.equal((await setChallengeStatus(pool, committee, ch1.number, "solved")).status, "illegal_transition");

      // ── Part B: assignee on their assigned challenge (but not others) ─────────────────
      const ch2 = await mkChallenge("SM assignee challenge");
      assert.equal((await setChallengeAssignee(pool, admin, ch2.number, assignee.userId)).status, "ok");
      assert.equal((await setChallengeStatus(pool, admin, ch2.number, "in_review")).status, "ok");
      // The assignee may traverse the enforced graph on ch2 (their challenge)…
      assert.equal((await setChallengeStatus(pool, assignee, ch2.number, "meeting_scheduled")).status, "ok");
      await assertAuditOverride(pool, "challenge.status_changed", ch2.id, false);
      // …but has no power on ch1 (not their assignment, not committee) → forbidden.
      assert.equal((await setChallengeStatus(pool, assignee, ch1.number, "needs_improvement")).status, "forbidden");

      // ── Part C: committee on a solution (§8.2 — no admin-only triage step) ────────────
      const sol = await createSolution(pool, author, ch1.number, { description: "SM solution", costVsBenefits: null, isAnonymous: false });
      assert.equal(sol.status, "ok");
      if (sol.status !== "ok") return;
      const solNumber = sol.solution.number.replace("SOL-", "");
      // proposed → in_review is a legal committee arrow for solutions (unlike challenge triage).
      assert.equal((await setSolutionStatus(pool, committee, solNumber, "in_review")).status, "ok");
      await assertAuditOverride(pool, "solution.status_changed", sol.solution.id, false);
      // in_review → implemented is NOT a legal arrow.
      assert.equal((await setSolutionStatus(pool, committee, solNumber, "implemented")).status, "illegal_transition");
      // A mere member cannot transition a solution at all.
      assert.equal((await setSolutionStatus(pool, member, solNumber, "valid")).status, "forbidden");
    } finally {
      await pool.end();
    }
  },
);

test(
  "author edit / withdraw / resubmit (§10.1): windows, ownership, edited_at + diff audit, triggers",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const {
      createChallenge,
      createSolution,
      editChallenge,
      editSolution,
      getChallengeByNumber,
      listActiveImpactAreas,
      resubmitChallenge,
      resubmitSolution,
      setChallengeStatus,
      setSolutionStatus,
      withdrawChallenge,
      withdrawSolution,
    } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Edit NS') returning id`,
        [`dbtest-edit-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-edit-${label}-${stamp}`, `dbtest-edit-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[]) => buildRoleSet(grants, { globalNamespaceId: globalId });
      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const admin = { userId: await mkUser("admin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const other = { userId: await mkUser("other"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const created = await createChallenge(pool, author, { impactAreaId: internal.id, namespaceId: nsId, title: "Original title", description: "Original body", clientName: null, visibility: "namespace", isAnonymous: false });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const num = created.challenge.number.replace("CH-", "");
      const chId = created.challenge.id;

      // Only the author may edit; edit allowed while awaiting_triage. (Another member cannot see
      // an awaiting_triage challenge at all, so they get not_found — §2.4.)
      assert.equal((await editChallenge(pool, other, num, { title: "Hijack", description: "x", clientName: null, impactAreaId: internal.id })).status, "not_found");
      const edited = await editChallenge(pool, author, num, { title: "Edited title", description: "Original body", clientName: null, impactAreaId: internal.id });
      assert.equal(edited.status, "ok");
      // edited_at stamped, and a field-level diff audited (only the changed field).
      const { rows: er } = await pool.query<{ edited_at: Date | null }>(`select edited_at from challenges where id = $1`, [chId]);
      assert.ok(er[0]!.edited_at, "edited_at is stamped");
      const { rows: ea } = await pool.query<{ before: { title?: string }; after: { title?: string; description?: string } }>(
        `select before, after from audit_log where action = 'challenge.edited' and target_id = $1 order by id desc limit 1`,
        [chId],
      );
      assert.equal(ea[0]!.before.title, "Original title");
      assert.equal(ea[0]!.after.title, "Edited title");
      assert.equal(ea[0]!.after.description, undefined, "unchanged description is not in the diff");

      // Once in_review the author can no longer edit.
      assert.equal((await setChallengeStatus(pool, admin, num, "in_review")).status, "ok");
      assert.equal((await editChallenge(pool, author, num, { title: "Nope", description: "x", clientName: null, impactAreaId: internal.id })).status, "not_editable");

      // needs_improvement re-unlocks editing, and resubmit moves it back to in_review.
      assert.equal((await setChallengeStatus(pool, admin, num, "needs_improvement")).status, "ok");
      assert.equal((await editChallenge(pool, author, num, { title: "Improved", description: "better body", clientName: null, impactAreaId: internal.id })).status, "ok");
      assert.equal((await resubmitChallenge(pool, author, num)).status, "ok");
      const { rows: rr } = await pool.query<{ status: string }>(`select status from challenges where id = $1`, [chId]);
      assert.equal(rr[0]!.status, "in_review");
      await assertAuditOverride(pool, "challenge.status_changed", chId, false); // resubmit is an enforced-style transition
      // resubmit only from needs_improvement.
      assert.equal((await resubmitChallenge(pool, author, num)).status, "not_resubmittable");

      // Author withdraw from a non-terminal status; then it is terminal.
      const withdrawn = await withdrawChallenge(pool, author, num);
      assert.equal(withdrawn.status, "ok");
      const afterWithdraw = await getChallengeByNumber(pool, author, num);
      assert.equal(afterWithdraw!.status, "withdrawn");
      assert.equal((await withdrawChallenge(pool, author, num)).status, "not_withdrawable");

      // ── Solution edit / resubmit / withdraw ──────────────────────────────────────────
      const ch2 = await createChallenge(pool, author, { impactAreaId: internal.id, namespaceId: nsId, title: "Solvable", description: "d", clientName: null, visibility: "namespace", isAnonymous: false });
      if (ch2.status !== "ok") return;
      const ch2Num = ch2.challenge.number.replace("CH-", "");
      assert.equal((await setChallengeStatus(pool, admin, ch2Num, "valid")).status, "ok");
      const sol = await createSolution(pool, author, ch2Num, { description: "First draft", costVsBenefits: null, isAnonymous: false });
      if (sol.status !== "ok") return;
      const solNum = sol.solution.number.replace("SOL-", "");
      const solId = sol.solution.id;

      // A `proposed` solution is invisible to another member → not_found (§2.4).
      assert.equal((await editSolution(pool, other, solNum, { description: "hijack", costVsBenefits: null })).status, "not_found");
      assert.equal((await editSolution(pool, author, solNum, { description: "Second draft", costVsBenefits: "cheap" })).status, "ok");
      const { rows: se } = await pool.query<{ after: { description?: string; costVsBenefits?: string } }>(
        `select after from audit_log where action = 'solution.edited' and target_id = $1 order by id desc limit 1`,
        [solId],
      );
      assert.equal(se[0]!.after.description, "Second draft");
      assert.equal(se[0]!.after.costVsBenefits, "cheap");

      assert.equal((await setSolutionStatus(pool, admin, solNum, "in_review")).status, "ok");
      assert.equal((await editSolution(pool, author, solNum, { description: "no", costVsBenefits: null })).status, "not_editable");
      assert.equal((await setSolutionStatus(pool, admin, solNum, "needs_improvement")).status, "ok");
      assert.equal((await resubmitSolution(pool, author, solNum)).status, "ok");
      await assertAuditOverride(pool, "solution.status_changed", solId, false);
      const wd = await withdrawSolution(pool, author, solNum);
      assert.equal(wd.status, "ok");
      const { rows: sw } = await pool.query<{ status: string }>(`select status from solutions where id = $1`, [solId]);
      assert.equal(sw[0]!.status, "withdrawn");
      assert.equal((await withdrawSolution(pool, author, solNum)).status, "not_withdrawable");
    } finally {
      await pool.end();
    }
  },
);

test(
  "setChallengeVisibility (§4.3): admin-only, audited before→after, idempotent, validated",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, listActiveImpactAreas, setChallengeVisibility } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Vis NS') returning id`,
        [`dbtest-vis-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-vis-${label}-${stamp}`, `dbtest-vis-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[]) => buildRoleSet(grants, { globalNamespaceId: globalId });
      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const admin = { userId: await mkUser("admin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const member = { userId: await mkUser("member"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const created = await createChallenge(pool, author, { impactAreaId: internal.id, namespaceId: nsId, title: "Visibility subject", description: "d", clientName: null, visibility: "namespace", isAnonymous: false });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const num = created.challenge.number.replace("CH-", "");
      const chId = created.challenge.id;

      // An invalid value is rejected before any lookup/mutation.
      assert.equal((await setChallengeVisibility(pool, admin, num, "public")).status, "invalid");
      // A non-existent challenge → not_found.
      assert.equal((await setChallengeVisibility(pool, admin, "999999", "org")).status, "not_found");
      // A mere member (not the namespace admin) cannot change visibility — even the author. At
      // awaiting_triage the member cannot see the challenge, so it is not_found for them (§2.4).
      assert.equal((await setChallengeVisibility(pool, member, num, "org")).status, "not_found");
      assert.equal((await setChallengeVisibility(pool, author, num, "org")).status, "forbidden");

      // Admin flips namespace → org: ok, reflected in the returned detail, audited before→after.
      const changed = await setChallengeVisibility(pool, admin, num, "org");
      assert.equal(changed.status, "ok");
      if (changed.status !== "ok") return;
      assert.equal(changed.challenge.visibility, "org");
      const { rows: aud } = await pool.query<{ before: { visibility?: string }; after: { visibility?: string } }>(
        `select before, after from audit_log where action = 'challenge.visibility_changed' and target_id = $1 order by id desc limit 1`,
        [chId],
      );
      assert.equal(aud.length, 1, "the visibility change is audited");
      assert.equal(aud[0]!.before.visibility, "namespace");
      assert.equal(aud[0]!.after.visibility, "org");

      // Setting the same value is a no-op success and writes NO second audit row.
      const noop = await setChallengeVisibility(pool, admin, num, "org");
      assert.equal(noop.status, "ok");
      const { rows: cnt } = await pool.query<{ n: string }>(
        `select count(*)::text as n from audit_log where action = 'challenge.visibility_changed' and target_id = $1`,
        [chId],
      );
      assert.equal(cnt[0]!.n, "1", "a no-op visibility set must not append a second audit row");
    } finally {
      await pool.end();
    }
  },
);

test(
  "existence is not disclosed (§2.4): hidden items answer not_found before any forbidden/conflict; malformed numbers too",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("./store");
    const { createComment, deleteComment, editComment } = await import("../comments/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into namespaces (slug, display_name) values ($1, 'Dbtest Hidden NS') returning id`,
          [`dbtest-hidden-${label}-${stamp}`],
        );
        return rows[0]!.id;
      };
      const nsId = await mkNs("a");
      const otherNsId = await mkNs("b");
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-hidden-${label}-${stamp}`, `dbtest-hidden-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });
      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const admin = { userId: await mkUser("admin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const member = { userId: await mkUser("member"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const outsider = { userId: await mkUser("outsider"), roles: roles([]) };
      // An admin of a DIFFERENT namespace: admin powers, but none over (or visibility into) namespace A.
      const foreignAdmin = { userId: await mkUser("foreign-admin"), roles: roles([{ role: "namespace_admin", namespaceId: otherNsId }]) };
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const mk = async (title: string, visibility: "org" | "namespace", isAnonymous: boolean) => {
        const c = await store.createChallenge(pool, author, { impactAreaId: internal.id, namespaceId: nsId, title, description: "d", clientName: null, visibility, isAnonymous });
        if (c.status !== "ok") throw new Error("setup failed");
        const num = c.challenge.number.replace("CH-", "");
        assert.equal((await store.setChallengeStatus(pool, admin, num, "valid")).status, "ok");
        return { id: c.challenge.id, num };
      };
      // Namespace-restricted, anonymous, valid, with an anonymous solution moved past `proposed`.
      const hidden = await mk("Hidden from outsiders", "namespace", true);
      const sol = await store.createSolution(pool, author, hidden.num, { description: "hidden sol", costVsBenefits: null, isAnonymous: true });
      if (sol.status !== "ok") throw new Error("setup failed");
      const solNum = sol.solution.number.replace("SOL-", "");
      assert.equal((await store.setSolutionStatus(pool, admin, solNum, "in_review")).status, "ok");

      // Every by-number action: a viewer who cannot see the item gets not_found, never the
      // forbidden / not_anonymous / conflict answer that would confirm the item exists.
      type V = typeof author;
      const actions = (v: V, chNum: string, sNum: string): Record<string, () => Promise<{ status: string }>> => ({
        revealChallenge: () => store.revealChallengeAuthor(pool, v, chNum),
        selfRevealChallenge: () => store.selfRevealChallenge(pool, v, chNum),
        withdrawChallenge: () => store.withdrawChallenge(pool, v, chNum),
        resubmitChallenge: () => store.resubmitChallenge(pool, v, chNum),
        assign: () => store.setChallengeAssignee(pool, v, chNum, v.userId),
        visibility: () => store.setChallengeVisibility(pool, v, chNum, "org"),
        transition: () => store.setChallengeStatus(pool, v, chNum, "rejected"),
        edit: () => store.editChallenge(pool, v, chNum, { title: "x", description: "x", clientName: null, impactAreaId: internal.id }),
        propose: () => store.createSolution(pool, v, chNum, { description: "x", costVsBenefits: null, isAnonymous: false }),
        solutionTransition: () => store.setSolutionStatus(pool, v, sNum, "rejected"),
        editSolution: () => store.editSolution(pool, v, sNum, { description: "x", costVsBenefits: null }),
        withdrawSolution: () => store.withdrawSolution(pool, v, sNum),
        resubmitSolution: () => store.resubmitSolution(pool, v, sNum),
        revealSolution: () => store.revealSolutionAuthor(pool, v, sNum),
        selfRevealSolution: () => store.selfRevealSolution(pool, v, sNum),
      });
      const probers: [string, V][] = [
        ["foreign admin", foreignAdmin],
        ["outsider", outsider],
      ];
      for (const [viewerName, viewer] of probers) {
        for (const [name, run] of Object.entries(actions(viewer, hidden.num, solNum))) {
          assert.equal((await run()).status, "not_found", `${name} by ${viewerName} on a hidden item`);
        }
      }
      // …indistinguishable from a number that does not exist, or is not a well-formed number at all.
      const badNumbers: [string, string][] = [
        ["999999999", "999999999"],
        ["abc", "1.5"],
        ["-1", "0"],
        ["01", "1e3"],
      ];
      for (const [badCh, badSol] of badNumbers) {
        for (const [name, run] of Object.entries(actions(admin, badCh, badSol))) {
          assert.equal((await run()).status, "not_found", `${name} with ${badCh}/${badSol}`);
        }
      }
      assert.equal(await store.getChallengeByNumber(pool, admin, "abc"), null);

      // Nothing was mutated or revealed by the probes above.
      const { rows: unchanged } = await pool.query<{ status: string; visibility: string; is_anonymous: boolean; assignee_id: string | null }>(
        `select status, visibility, is_anonymous, assignee_id from challenges where id = $1`,
        [hidden.id],
      );
      assert.deepEqual({ ...unchanged[0] }, { status: "valid", visibility: "namespace", is_anonymous: true, assignee_id: null });
      const { rows: reveals } = await pool.query(`select 1 from audit_log where action = 'anonymity.revealed' and target_id = $1`, [hidden.id]);
      assert.equal(reveals.length, 0, "no reveal was audited for a hidden probe");

      // Once the item IS visible, the permission check answers as before: 403 for a viewer who
      // can see it but lacks the role. (Org-visible now, so the foreign admin sees it too.)
      assert.equal((await store.setChallengeVisibility(pool, admin, hidden.num, "org")).status, "ok");
      assert.equal((await store.revealChallengeAuthor(pool, foreignAdmin, hidden.num)).status, "forbidden");
      assert.equal((await store.setChallengeAssignee(pool, foreignAdmin, hidden.num, member.userId)).status, "forbidden");
      assert.equal((await store.revealSolutionAuthor(pool, member, solNum)).status, "forbidden");
      assert.equal((await store.withdrawChallenge(pool, member, hidden.num)).status, "forbidden");
      assert.equal((await store.selfRevealSolution(pool, member, solNum)).status, "forbidden");
      // A `proposed` solution stays hidden from a mere member even on a visible challenge.
      const proposed = await store.createSolution(pool, author, hidden.num, { description: "still proposed", costVsBenefits: null, isAnonymous: true });
      if (proposed.status !== "ok") throw new Error("setup failed");
      const proposedNum = proposed.solution.number.replace("SOL-", "");
      assert.equal((await store.revealSolutionAuthor(pool, member, proposedNum)).status, "not_found");
      assert.equal((await store.withdrawSolution(pool, member, proposedNum)).status, "not_found");

      // Comments: edit/delete of a comment under an item the caller cannot see → not_found.
      const restricted = await mk("Restricted thread", "namespace", false);
      const comment = await createComment(pool, member, "challenge", restricted.id, "members only");
      if (comment.status !== "ok") throw new Error("setup failed");
      assert.equal((await editComment(pool, foreignAdmin, comment.comment.id, "probe")).status, "not_found");
      assert.equal((await deleteComment(pool, foreignAdmin, comment.comment.id)).status, "not_found");
      assert.equal((await editComment(pool, foreignAdmin, "not-a-uuid", "probe")).status, "not_found");
      assert.equal((await deleteComment(pool, foreignAdmin, "not-a-uuid")).status, "not_found");
      // A visible comment that is not yours still answers forbidden.
      assert.equal((await editComment(pool, author, comment.comment.id, "hijack")).status, "forbidden");
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

async function assertAuditOverride(pool: import("pg").Pool, action: string, targetId: string, expected: boolean): Promise<void> {
  const { rows } = await pool.query<{ override: string | null }>(
    `select after->>'override' as override from audit_log where action = $1 and target_id = $2 order by id desc limit 1`,
    [action, targetId],
  );
  assert.equal(rows.length, 1, `expected an audit_log row for ${action} / ${targetId}`);
  assert.equal(rows[0]!.override, String(expected), `expected override=${expected} on the latest ${action} row`);
}

async function assertAudited(pool: import("pg").Pool, action: string, targetId: string): Promise<void> {
  const { rows } = await pool.query(
    `select 1 from audit_log where action = $1 and target_id = $2 order by id desc limit 1`,
    [action, targetId],
  );
  assert.equal(rows.length, 1, `expected an audit_log row for ${action} / ${targetId}`);
}
