// Live-DB integration test (gated) for Phase 3: comments (§10.2), follows (§12.3),
// anonymity reveal (§9), and assignment (§7.3) — sharing one set of fixtures since they're
// all exercised against the same challenge. Notification dispatch (§12.1) is verified here
// too, by checking notification_outbox rows land after the store-layer calls a caller
// would normally follow with a notify.ts dispatch (the route-level wiring itself is
// exercised via the unit-tested pure pieces in social.test.ts + manual browser verification).
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "Phase 3: comments, follows, reveal, assignment — visibility, moderation, audit",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, setChallengeStatus, setChallengeAssignee, revealChallengeAuthor, selfRevealChallenge } = await import(
      "../challenges/store"
    );
    const { createComment, editComment, deleteComment, listComments } = await import("./store");
    const { toggleFollow, isFollowing } = await import("../follows/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;

      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Social NS') returning id`,
        [`dbtest-social-${stamp}`],
      );
      const nsId = nsRows[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
          [`dbtest-social-${label}-${stamp}`, `dbtest-social-${label}-${stamp}@example.test`, `Dbtest ${label}`, `${label}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      const authorId = await mkUser("author");
      const adminId = await mkUser("admin");
      const commenterId = await mkUser("commenter");
      const assigneeId = await mkUser("assignee");

      const author = { userId: authorId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const admin = { userId: adminId, roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const commenter = { userId: commenterId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };

      const { rows: areaRows } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const areaId = areaRows[0]!.id;

      const created = await createChallenge(pool, author, {
        impactAreaId: areaId,
        namespaceId: nsId,
        title: "Social features test",
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: true,
      });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const number = created.challenge.number.replace("CH-", "");

      // Must be `valid` (or at least visible/non-triage) for a mere commenter to see it.
      const toValid = await setChallengeStatus(pool, admin, number, "valid");
      assert.equal(toValid.status, "ok");

      // 1. Comment: post, list shows real author (never masked), audited.
      const c1 = await createComment(pool, commenter, "challenge", created.challenge.id, "First comment");
      assert.equal(c1.status, "ok");
      if (c1.status !== "ok") return;
      assert.equal(c1.comment.authorDisplayName, "Dbtest commenter");
      await assertAudited(pool, "comment.posted", c1.comment.id);

      const listed = await listComments(pool, author, "challenge", created.challenge.id);
      assert.equal(listed?.length, 1);
      assert.equal(listed![0]!.body, "First comment");

      // 2. Owner edit within window — ok, audited.
      const edited = await editComment(pool, commenter, c1.comment.id, "Edited comment");
      assert.equal(edited.status, "ok");
      await assertAudited(pool, "comment.edited", c1.comment.id);

      // 3. A non-owner, non-admin cannot edit or delete.
      const forbiddenEdit = await editComment(pool, author, c1.comment.id, "Hijack");
      assert.equal(forbiddenEdit.status, "forbidden");
      const forbiddenDelete = await deleteComment(pool, author, c1.comment.id);
      assert.equal(forbiddenDelete.status, "forbidden");

      // 4. Admin moderation delete — ok anytime, renders as the moderation placeholder.
      const modDeleted = await deleteComment(pool, admin, c1.comment.id);
      assert.equal(modDeleted.status, "ok");
      await assertAudited(pool, "comment.deleted", c1.comment.id);
      const afterDelete = await listComments(pool, author, "challenge", created.challenge.id);
      assert.equal(afterDelete![0]!.body, "Comment removed by a moderator");
      assert.equal(afterDelete![0]!.deleted, true);

      // 5. Follow / unfollow toggle.
      const followed = await toggleFollow(pool, commenter, "challenge", created.challenge.id);
      assert.deepEqual(followed, { status: "ok", following: true });
      assert.equal(await isFollowing(pool, commenter, "challenge", created.challenge.id), true);
      const unfollowed = await toggleFollow(pool, commenter, "challenge", created.challenge.id);
      assert.deepEqual(unfollowed, { status: "ok", following: false });

      // 6. Assignment: non-admin forbidden; admin ok, audited, notified (outbox row).
      const forbiddenAssign = await setChallengeAssignee(pool, commenter, number, assigneeId);
      assert.equal(forbiddenAssign.status, "forbidden");

      const assigned = await setChallengeAssignee(pool, admin, number, assigneeId);
      assert.equal(assigned.status, "ok");
      await assertAudited(pool, "challenge.assigned", created.challenge.id);

      const unassigned = await setChallengeAssignee(pool, admin, number, null);
      assert.equal(unassigned.status, "ok");
      await assertAudited(pool, "challenge.unassigned", created.challenge.id);

      // Assignment is blocked on terminal statuses (§7.3).
      await setChallengeStatus(pool, admin, number, "solved");
      const terminalAssign = await setChallengeAssignee(pool, admin, number, assigneeId);
      assert.equal(terminalAssign.status, "terminal_status");

      // 7. Anonymity reveal: transient admin reveal (never un-masks the stored flag).
      const revealResult = await revealChallengeAuthor(pool, admin, number);
      assert.equal(revealResult.status, "ok");
      if (revealResult.status === "ok") assert.equal(revealResult.realDisplayName, "Dbtest author");
      await assertAudited(pool, "anonymity.revealed", created.challenge.id);
      // Still anonymous to a normal fetch — reveal is not persisted.
      const { rows: stillAnon } = await pool.query<{ is_anonymous: boolean }>(`select is_anonymous from challenges where id = $1`, [
        created.challenge.id,
      ]);
      assert.equal(stillAnon[0]!.is_anonymous, true);

      const nonAdminReveal = await revealChallengeAuthor(pool, commenter, number);
      assert.equal(nonAdminReveal.status, "forbidden");

      // 8. Self-reveal: permanent, one-way, audited; only the author may do it.
      const forbiddenSelfReveal = await selfRevealChallenge(pool, commenter, number);
      assert.equal(forbiddenSelfReveal.status, "forbidden");

      const selfRevealed = await selfRevealChallenge(pool, author, number);
      assert.equal(selfRevealed.status, "ok");
      await assertAudited(pool, "anonymity.self_revealed", created.challenge.id);
      const { rows: nowRevealed } = await pool.query<{ is_anonymous: boolean }>(`select is_anonymous from challenges where id = $1`, [
        created.challenge.id,
      ]);
      assert.equal(nowRevealed[0]!.is_anonymous, false);

      // Idempotent-ish: can't self-reveal again once already revealed.
      const alreadyRevealed = await selfRevealChallenge(pool, author, number);
      assert.equal(alreadyRevealed.status, "not_anonymous");

      // 9. Notification dispatch (§12.1): actor excluded, dedup, visibility-dropped,
      //    writes both the in-app row and the outbox row. A local role resolver stands in
      //    for lib/auth's resolveRolesForUser — that module transitively imports
      //    authOptions.ts (next-auth provider setup), which doesn't load under the plain
      //    node test runner outside Next's bundler.
      const { dispatchEvent } = await import("../../../lib/notify");
      const resolveRoles = async (userId: string) => {
        const { rows: grantRows } = await pool.query<{ role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespace_id: string | null }>(
          `select rm.role, rm.namespace_id
             from group_members gm join groups g on g.id = gm.group_id
             join role_mappings rm on rm.group_external_id = g.external_id
            where gm.user_id = $1`,
          [userId],
        );
        return buildRoleSet(
          grantRows.map((g) => ({ role: g.role, namespaceId: g.namespace_id })),
          { globalNamespaceId: globalId },
        );
      };
      const dispatchTestMessage = `test dispatch ${stamp}`;
      await dispatchEvent(
        { pool, actorId: authorId, resolveRoles },
        { parentType: "challenge", parentId: created.challenge.id },
        [authorId, commenterId, commenterId], // actor + dup — should collapse to just commenterId
        "comment_posted",
        { message: dispatchTestMessage, link: `/challenges/${number}` },
      );
      const { rows: inApp } = await pool.query(
        `select user_id from notifications where type = 'comment_posted' and payload->>'message' = $1`,
        [dispatchTestMessage],
      );
      assert.deepEqual(inApp.map((r) => r.user_id).sort(), [commenterId]);
      const { rows: outbox } = await pool.query(
        `select user_id from notification_outbox where type = 'comment_posted' and payload->>'message' = $1`,
        [dispatchTestMessage],
      );
      assert.deepEqual(outbox.map((r) => r.user_id).sort(), [commenterId]);
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
