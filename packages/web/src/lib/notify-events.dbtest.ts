// Live-DB integration test (gated) for the shared §12.1 status/assignment events
// (INNOBOX_SPEC.md §7.2, §7.3, §8.3, §12.1, §14.1):
//  - the triage BULK actions fire the same notifications as the single-item path — event 3 to
//    author + assignee + followers (never the actor), events 4/5 author-only, nothing on a no-op;
//  - bulk assign notifies the assignee and auto-follows them; a reassignment tells the previous
//    assignee they were unassigned and the new one they were assigned; same person → nothing;
//  - a solution's event 3 reaches the PARENT challenge's assignee, deep-linked to `#SOL-<m>`;
//  - event 8 (auto-close) reaches the CHALLENGE author, the not_selected authors and the
//    followers of the challenge and its solutions — and never names an anonymous author;
//  - the auto-close cascade's audit rows carry `before` and the `override` flag.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§12.1 events: bulk triage notifications, reassignment, solution assignee, event 8 recipients, auto-close audit",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, createSolution, listActiveImpactAreas, setSolutionStatus } = await import("../app/api/challenges/store");
    const { bulkAssign, bulkSetStatus } = await import("../app/api/admin/triage/store");
    const { notifySolutionStatusChanged } = await import("./notify-events");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Events NS') returning id`, [
        `dbtest-ev-${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-ev-${label}-${stamp}`, `dbtest-ev-${label}-${stamp}@example.test`, `Dbtest Ev ${label} ${stamp}`],
        );
        return rows[0]!.id;
      };
      const [authorId, solAuthorId, rivalId, followerId, solFollowerId, assigneeA, assigneeB, adminId] = await Promise.all(
        ["author", "solauthor", "rival", "follower", "solfollower", "assigneea", "assigneeb", "admin"].map(mkUser),
      );
      const member = (userId: string) => ({ userId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) });
      const admin = { userId: adminId!, roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const resolveRoles = async () => member("x").roles;
      const ctx = { pool, actorId: adminId!, resolveRoles };

      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const created = await createChallenge(pool, member(authorId!), {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: `Events ${stamp}`,
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const challengeId = created.challenge.id;
      const chNum = created.challenge.number.replace("CH-", "");
      await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, 'challenge', $2)`, [followerId, challengeId]);

      /** Inbox rows of one type for this challenge's subtree, per recipient (each paired with an outbox row). */
      const inbox = async (type: string, messageLike = "%") => {
        const { rows } = await pool.query<{ user_id: string; message: string; link: string }>(
          `select user_id, payload->>'message' as message, payload->>'link' as link from notifications
            where type = $1 and (payload->>'link' = $2 or payload->>'link' like $2 || '#%') and payload->>'message' like $3
            order by created_at, id`,
          [type, `/challenges/${chNum}`, messageLike],
        );
        const { rows: out } = await pool.query<{ n: string }>(
          `select count(*) as n from notification_outbox
            where type = $1 and (payload->>'link' = $2 or payload->>'link' like $2 || '#%') and payload->>'message' like $3`,
          [type, `/challenges/${chNum}`, messageLike],
        );
        assert.equal(Number(out[0]!.n), rows.length, `every ${type} inbox row has its outbox row`);
        return rows;
      };
      const usersOf = (rows: { user_id: string }[]) => rows.map((r) => r.user_id).sort();

      // ── Event 7 via bulk assign: assigned → auto-follow; reassigned → both told; same → nothing ──
      assert.deepEqual(await bulkAssign(pool, admin, [chNum], assigneeA!, resolveRoles), [{ number: `CH-${chNum}`, status: "ok" }]);
      assert.deepEqual(usersOf(await inbox("challenge_assigned", "You were assigned%")), [assigneeA]);
      const { rows: autoFollow } = await pool.query(`select 1 from follows where user_id = $1 and parent_type = 'challenge' and parent_id = $2`, [
        assigneeA,
        challengeId,
      ]);
      assert.equal(autoFollow.length, 1, "bulk assign auto-follows the assignee, like the detail-page assignment");

      await bulkAssign(pool, admin, [chNum], assigneeB!, resolveRoles);
      assert.deepEqual(usersOf(await inbox("challenge_assigned", "You were unassigned%")), [assigneeA], "the previous assignee is told");
      assert.deepEqual(usersOf(await inbox("challenge_assigned", "You were assigned%")), [assigneeA, assigneeB].sort(), "the new one too");

      await bulkAssign(pool, admin, [chNum], assigneeB!, resolveRoles);
      assert.equal((await inbox("challenge_assigned")).length, 3, "re-assigning the same person is no change and notifies nobody");

      await bulkAssign(pool, admin, [chNum], null, resolveRoles);
      assert.deepEqual(usersOf(await inbox("challenge_assigned", "You were unassigned%")), [assigneeA, assigneeB].sort(), "unassigning tells the assignee");
      await bulkAssign(pool, admin, [chNum], assigneeA!, resolveRoles);

      // ── Events 3/4/5 via bulk status ────────────────────────────────────────────────────
      await bulkSetStatus(pool, admin, [chNum], "in_review", resolveRoles);
      const moved = await inbox("status_changed", "%moved to in review%");
      // assigneeB still follows from their auto-follow (unassignment does not unfollow, §12.3).
      assert.deepEqual(usersOf(moved), [authorId, followerId, assigneeA, assigneeB].sort(), "event 3: author + assignee + followers, never the acting admin");
      assert.ok(moved.every((r) => r.link === `/challenges/${chNum}`));

      await bulkSetStatus(pool, admin, [chNum], "in_review", resolveRoles);
      assert.equal((await inbox("status_changed", "%moved to in review%")).length, moved.length, "a no-op bulk status fires nothing");

      await bulkSetStatus(pool, admin, [chNum], "needs_improvement", resolveRoles);
      assert.deepEqual(usersOf(await inbox("needs_improvement")), [authorId], "event 5 is author-only");
      await bulkSetStatus(pool, admin, [chNum], "valid", resolveRoles);

      // ── Solutions: event 3 reaches the parent's assignee, anchored to the solution ─────────
      const winner = await createSolution(pool, member(solAuthorId!), chNum, { description: "winner", costVsBenefits: null, isAnonymous: true });
      const other = await createSolution(pool, member(rivalId!), chNum, { description: "other", costVsBenefits: null, isAnonymous: false });
      assert.equal(winner.status, "ok");
      assert.equal(other.status, "ok");
      if (winner.status !== "ok" || other.status !== "ok") return;
      const winnerNum = winner.solution.number.replace("SOL-", "");
      await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, 'solution', $2)`, [solFollowerId, other.solution.id]);

      const toReview = await setSolutionStatus(pool, admin, winnerNum, "in_review");
      assert.equal(toReview.status, "ok");
      await notifySolutionStatusChanged(ctx, winner.solution.id, "in_review");
      const solMoved = (await inbox("status_changed", `Solution SOL-${winnerNum}%`)).filter((r) => r.link === `/challenges/${chNum}#SOL-${winnerNum}`);
      assert.ok(usersOf(solMoved).includes(assigneeA!), "the parent challenge's assignee hears about a solution status change");
      assert.ok(usersOf(solMoved).includes(solAuthorId!), "and the solution author");

      // ── Event 8: drive the winner to implemented (admin override) and dispatch ────────────
      let last: Awaited<ReturnType<typeof setSolutionStatus>> | undefined;
      for (const st of ["valid", "accepted_internally", "waiting_for_resources", "in_implementation", "implemented"]) {
        last = await setSolutionStatus(pool, admin, winnerNum, st);
        assert.equal(last.status, "ok", `winner → ${st}`);
      }
      assert.ok(last && last.status === "ok" && last.autoClose, "implemented triggers the auto-close");
      if (!last || last.status !== "ok" || !last.autoClose) return;
      await notifySolutionStatusChanged(ctx, winner.solution.id, "implemented", last.autoClose);

      const closed = await inbox("solution_implemented");
      const got = new Set(usersOf(closed));
      assert.ok(got.has(authorId!), "the CHALLENGE author is told (not the solution author in their place)");
      assert.ok(got.has(rivalId!), "the not_selected sibling's author is told");
      assert.ok(got.has(followerId!), "challenge followers are told");
      assert.ok(got.has(solFollowerId!), "followers of the challenge's solutions are told");
      assert.ok(!got.has(adminId!), "the actor never notifies themselves");
      assert.equal(got.size, closed.length, "recipients are deduplicated");
      assert.ok(closed.every((r) => !r.message.includes("solauthor")), "an anonymous solution author is never named");

      // ── Auto-close audit rows: from → to, and the override flag of the triggering action ──
      const { rows: cascade } = await pool.query<{ before: { status: string } | null; after: { status: string; override: boolean; trigger: string } }>(
        `select before, after from audit_log where action = 'challenge.status_changed' and target_id = $1 and after->>'trigger' = 'auto_close'`,
        [challengeId],
      );
      assert.equal(cascade.length, 1);
      assert.deepEqual(cascade[0]!.before, { status: "valid" });
      assert.equal(cascade[0]!.after.status, "solved");
      assert.equal(cascade[0]!.after.override, true, "an admin override that set implemented makes the cascade an override too");
      const { rows: sibling } = await pool.query<{ before: { status: string }; after: { override: boolean } }>(
        `select before, after from audit_log where action = 'solution.status_changed' and target_id = $1 and after->>'trigger' = 'auto_close'`,
        [other.solution.id],
      );
      assert.equal(sibling[0]!.before.status, "proposed");
      assert.equal(sibling[0]!.after.override, true);
    } finally {
      await pool.end();
    }
  },
);
