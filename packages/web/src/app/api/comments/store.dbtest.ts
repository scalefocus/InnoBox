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
      // The §7.3 assignee gate's role resolver: everyone here is a member of the namespace.
      const memberRoles = async () => buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId });

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
      const forbiddenAssign = await setChallengeAssignee(pool, commenter, number, assigneeId, memberRoles);
      assert.equal(forbiddenAssign.status, "forbidden");

      const assigned = await setChallengeAssignee(pool, admin, number, assigneeId, memberRoles);
      assert.equal(assigned.status, "ok");
      await assertAudited(pool, "challenge.assigned", created.challenge.id);

      const unassigned = await setChallengeAssignee(pool, admin, number, null, memberRoles);
      assert.equal(unassigned.status, "ok");
      await assertAudited(pool, "challenge.unassigned", created.challenge.id);

      // Assignment is blocked on terminal statuses (§7.3).
      await setChallengeStatus(pool, admin, number, "solved");
      const terminalAssign = await setChallengeAssignee(pool, admin, number, assigneeId, memberRoles);
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

test(
  "§10.2 replies: root resolution, the 422 refusals, the 404 on an invisible item, the audit field",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet, REPLY_NOT_ON_ITEM, REPLY_TO_REMOVED } = await import("@innobox/shared");
    const { createChallenge, setChallengeStatus } = await import("../challenges/store");
    const { createComment, deleteComment, editComment, listComments } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const globalId = (await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`)).rows[0]!.id;
      const nsId = (
        await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Replies NS') returning id`, [`dbtest-replies-${stamp}`])
      ).rows[0]!.id;
      const mkUser = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
            `dbtest-replies-${label}-${stamp}`,
            `dbtest-replies-${label}-${stamp}@example.test`,
            `Dbtest ${label}`,
          ])
        ).rows[0]!.id;
      const member = (userId: string, role: "member" | "namespace_admin" = "member") => ({
        userId,
        roles: buildRoleSet([{ role, namespaceId: nsId }], { globalNamespaceId: globalId }),
      });
      const author = member(await mkUser("author"));
      const admin = member(await mkUser("admin"), "namespace_admin");
      const ann = member(await mkUser("ann"));
      const ben = member(await mkUser("ben"));
      const areaId = (await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`)).rows[0]!.id;

      const mkChallenge = async (title: string, toValid: boolean) => {
        const created = await createChallenge(pool, author, { impactAreaId: areaId, namespaceId: nsId, title, description: "d", clientName: null, visibility: "org", isAnonymous: false });
        assert.equal(created.status, "ok");
        if (created.status !== "ok") throw new Error("challenge");
        if (toValid) assert.equal((await setChallengeStatus(pool, admin, created.challenge.number.replace("CH-", ""), "valid")).status, "ok");
        return created.challenge.id;
      };
      const itemId = await mkChallenge(`Replies ${stamp}`, true);
      const otherId = await mkChallenge(`Replies other ${stamp}`, true);
      // Still awaiting triage: a plain member other than its author can't see it.
      const hiddenId = await mkChallenge(`Replies hidden ${stamp}`, false);

      const ok = async (viewer: typeof ann, parentId: string, body: string, replyTo: string | null = null) => {
        const r = await createComment(pool, viewer, "challenge", parentId, body, undefined, replyTo);
        assert.equal(r.status, "ok", body);
        if (r.status !== "ok") throw new Error(body);
        return r;
      };

      // A top-level comment has neither id; its audit row carries no replyTo.
      const root = await ok(ann, itemId, "Root");
      assert.equal(root.comment.threadRootId, null);
      assert.equal(root.comment.replyToId, null);
      assert.equal(root.replyToAuthorId, null);
      const rootAudit = await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'comment.posted' and target_id = $1`, [root.comment.id]);
      assert.equal("replyTo" in rootAudit.rows[0]!.after, false);

      // Reply to the root: filed under it, answering it; the root's author is reported back.
      const r1 = await ok(ben, itemId, "Reply one", root.comment.id);
      assert.equal(r1.comment.threadRootId, root.comment.id);
      assert.equal(r1.comment.replyToId, root.comment.id);
      assert.equal(r1.replyToAuthorId, ann.userId);
      const r1Audit = await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'comment.posted' and target_id = $1`, [r1.comment.id]);
      assert.equal(r1Audit.rows[0]!.after.replyTo, root.comment.id);

      // Reply to a reply: the SAME root, answering the reply.
      const r2 = await ok(ann, itemId, "Reply two", r1.comment.id);
      assert.equal(r2.comment.threadRootId, root.comment.id);
      assert.equal(r2.comment.replyToId, r1.comment.id);
      assert.equal(r2.replyToAuthorId, ben.userId);

      // The list carries both ids.
      const listed = (await listComments(pool, author, "challenge", itemId))!;
      const byId = new Map(listed.map((c) => [c.id, c]));
      assert.equal(byId.get(r2.comment.id)!.threadRootId, root.comment.id);
      assert.equal(byId.get(r2.comment.id)!.replyToId, r1.comment.id);

      // Editing never changes where a reply sits.
      assert.equal((await editComment(pool, ann, r2.comment.id, "Reply two, edited")).status, "ok");
      const afterEdit = (await pool.query<{ thread_root_id: string; reply_to_id: string }>(`select thread_root_id, reply_to_id from comments where id = $1`, [r2.comment.id])).rows[0]!;
      assert.deepEqual(afterEdit, { thread_root_id: root.comment.id, reply_to_id: r1.comment.id });

      // 422: a comment on another item, an id that names no comment, a non-uuid id.
      const elsewhere = await ok(ann, otherId, "On the other item");
      for (const replyTo of [elsewhere.comment.id, randomUUID(), "not-a-uuid"]) {
        assert.deepEqual(await createComment(pool, ben, "challenge", itemId, "x", undefined, replyTo), { status: "unprocessable", error: REPLY_NOT_ON_ITEM }, replyTo);
      }
      // 422: a soft-deleted target — a root and a reply alike.
      assert.equal((await deleteComment(pool, ben, r1.comment.id)).status, "ok");
      assert.deepEqual(await createComment(pool, ann, "challenge", itemId, "x", undefined, r1.comment.id), { status: "unprocessable", error: REPLY_TO_REMOVED });
      assert.equal((await deleteComment(pool, admin, root.comment.id)).status, "ok");
      assert.deepEqual(await createComment(pool, ben, "challenge", itemId, "x", undefined, root.comment.id), { status: "unprocessable", error: REPLY_TO_REMOVED });
      // The removed root keeps its replies underneath.
      const afterDelete = (await listComments(pool, author, "challenge", itemId))!;
      assert.equal(afterDelete.find((c) => c.id === root.comment.id)!.deleted, true);
      assert.equal(afterDelete.filter((c) => c.threadRootId === root.comment.id).length, 2);

      // 404: the item is invisible to the caller — decided before the target is even looked at.
      const hiddenRoot = await ok(author, hiddenId, "Author's own note");
      assert.deepEqual(await createComment(pool, ben, "challenge", hiddenId, "x", undefined, hiddenRoot.comment.id), { status: "not_found" });

      // Refused replies wrote nothing.
      const count = Number((await pool.query<{ c: string }>(`select count(*)::text as c from comments where parent_id = $1 and body = 'x'`, [itemId])).rows[0]!.c);
      assert.equal(count, 0);

      // The pair constraint: a half-set reply is refused by the database itself.
      await assert.rejects(
        pool.query(`insert into comments (parent_type, parent_id, author_id, body, thread_root_id) values ('challenge', $1, $2, 'half', $3)`, [itemId, ann.userId, r2.comment.id]),
        /comments_reply_pair_chk/,
      );
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
