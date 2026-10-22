// Live-DB integration test (gated) for §34 topics (INNOBOX_SPEC.md §34.9):
//   • curation: add (audited), a case-insensitive duplicate refused, edit, retire, reactivate, a
//     delete refused while active and, once retired, removing the tags (one audit row per challenge)
//     and the follows;
//   • following: set the wanted state; a retired topic refuses a follow; an unknown one is 404;
//   • tagging: the author on submit and in the edit window (diffed, edited_at stamped), the rules
//     (the cap, a retired topic refused); an admin's re-tag (audited, no edited_at, committee and
//     other viewers refused); bulk add/remove with ok / unchanged / topic_limit;
//   • event 18: the first entry into `valid` tells the followers who can see it and writes their
//     markers; never the author or the actor, nor a deactivated follower; nothing twice, nothing on a
//     second entry into `valid`; a topic added while valid reaches only its own untold followers; a
//     namespace-restricted challenge reaches members only and its widening the rest; event 15 counts
//     as being told; a retired topic and an archived namespace send nothing; the digest hold; opening
//     the detail page reads the row;
//   • the per-viewer open count, the gallery filter and the search filter;
//   • the §10.3 cascade and the §3 erasure remove the rows.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "topics: curation, following, tagging, event 18, open counts, filters, cascade, erasure",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, topicNoticeMessage, topicNoticeSubject } = await import("@innobox/shared");
    const store = await import("../challenges/store");
    const topics = await import("./store");
    const { deleteChallenge } = await import("../challenges/delete");
    const { scrubUser } = await import("../users/store");
    const { searchChallengePage } = await import("../search/store");
    const { notifyTopicFollowers } = await import("../../../lib/notify-events");
    const { markCommentNotificationsReadForChallenge } = await import("../../../lib/notify");
    type RoleSet = ReturnType<typeof buildRoleSet>;

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
            `dbtest-topics-${label}-${stamp}`,
            `Dbtest Topics ${label}`,
          ])
        ).rows[0]!.id;
      const nsId = await mkNs("main");
      const otherNsId = await mkNs("other");
      const archNsId = await mkNs("arch");
      const mkUser = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
            `dbtest-topics-${label}-${stamp}`,
            `dbtest-topics-${label}-${stamp}@example.test`,
            `Dbtest topics ${label} ${stamp}`,
          ])
        ).rows[0]!.id;
      const rolesById = new Map<string, RoleSet>();
      const person = async (label: string, grants: Parameters<typeof buildRoleSet>[0]) => {
        const userId = await mkUser(label);
        const roles = buildRoleSet(grants, { globalNamespaceId: globalId });
        rolesById.set(userId, roles);
        return { userId, roles };
      };
      const author = await person("author", [
        { role: "member", namespaceId: nsId },
        { role: "member", namespaceId: archNsId },
      ]);
      const fan1 = await person("fan1", [{ role: "member", namespaceId: nsId }]);
      const fan2 = await person("fan2", [{ role: "member", namespaceId: nsId }]);
      const bFan = await person("bfan", [{ role: "member", namespaceId: nsId }]);
      const daily = await person("daily", [{ role: "member", namespaceId: nsId }]);
      const leaver = await person("leaver", [{ role: "member", namespaceId: nsId }]);
      const outsider = await person("outsider", [{ role: "member", namespaceId: otherNsId }]);
      const committee = await person("committee", [{ role: "committee", namespaceId: nsId }]);
      const nsAdmin = await person("nsadmin", [
        { role: "namespace_admin", namespaceId: nsId },
        { role: "namespace_admin", namespaceId: archNsId },
      ]);
      const platform = await person("platform", [{ role: "platform_admin", namespaceId: null }]);
      const resolveRoles = async (userId: string) => rolesById.get(userId) ?? buildRoleSet([], { globalNamespaceId: globalId });
      const ctx = { pool, actorId: nsAdmin.userId, resolveRoles };
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const storage = { deleteObject: async () => {}, abortMultipartUpload: async () => {} };

      // ── Curation (§34.2) ──────────────────────────────────────────────────────────────────
      const add = async (name: string, description: string | null = null) => {
        const r = await topics.createTopic(pool, { name, description }, platform.userId);
        assert.equal(r.status, "ok", name);
        if (r.status !== "ok") throw new Error("create topic failed");
        return r.topic;
      };
      const tA = await add(`Dbtest AI ${stamp}`, "Machine learning");
      const tB = await add(`Dbtest Auto ${stamp}`);
      const tC = await add(`Dbtest Cee ${stamp}`);
      const tE = await add(`Dbtest Eee ${stamp}`);
      const tL = await add(`Dbtest Later ${stamp}`);
      const tR = await add(`Dbtest Retired ${stamp}`);
      assert.equal((await topics.createTopic(pool, { name: tA.name.toUpperCase(), description: null }, platform.userId)).status, "duplicate");
      const audited = async (action: string, targetId: string) =>
        (await pool.query<{ before: unknown; after: unknown }>(`select before, after from audit_log where action = $1 and target_id = $2 order by id`, [action, targetId])).rows;
      assert.equal((await audited("topic.created", tA.id)).length, 1);

      const edited = await topics.patchTopic(pool, tB.id, { description: "Robots" }, platform.userId);
      assert.equal(edited.status, "ok");
      assert.deepEqual((await audited("topic.updated", tB.id))[0], { before: { description: null }, after: { description: "Robots" } });
      assert.equal((await topics.patchTopic(pool, tB.id, { name: tA.name.toLowerCase() }, platform.userId)).status, "duplicate");
      assert.equal((await topics.patchTopic(pool, tR.id, { active: false }, platform.userId)).status, "ok");
      assert.equal((await audited("topic.retired", tR.id)).length, 1);
      assert.equal((await topics.deleteTopic(pool, tA.id, platform.userId)).status, "not_retired");
      const all = await topics.listAllTopics(pool);
      assert.equal(all.find((t) => t.id === tR.id)?.active, false);

      // ── Following (§34.4) ─────────────────────────────────────────────────────────────────
      for (const who of [fan1, fan2, daily, leaver, outsider, author, nsAdmin]) {
        assert.deepEqual(await topics.setTopicFollow(pool, who.userId, tA.id, true), { status: "ok", following: true });
      }
      assert.equal((await topics.setTopicFollow(pool, fan2.userId, tB.id, true)).status, "ok");
      assert.equal((await topics.setTopicFollow(pool, bFan.userId, tB.id, true)).status, "ok");
      assert.equal((await topics.setTopicFollow(pool, fan1.userId, tA.id, true)).status, "ok", "following twice is harmless");
      assert.equal((await topics.setTopicFollow(pool, fan1.userId, tR.id, true)).status, "retired");
      assert.equal((await topics.setTopicFollow(pool, fan1.userId, randomUUID(), true)).status, "not_found");
      await pool.query(`update users set email_delivery = 'daily' where id = $1`, [daily.userId]);
      await pool.query(`update users set active = false where id = $1`, [leaver.userId]);

      // ── The author's tagging (§34.3) ──────────────────────────────────────────────────────
      const create = async (title: string, topicIds: string[], opts: { visibility?: "org" | "namespace"; ns?: string } = {}) =>
        store.createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: opts.ns ?? nsId,
          title: `${title} ${stamp}`,
          description: "d",
          clientName: null,
          visibility: opts.visibility ?? "org",
          isAnonymous: false,
          topicIds,
        });
      const mustCreate = async (...args: Parameters<typeof create>) => {
        const r = await create(...args);
        assert.equal(r.status, "ok");
        if (r.status !== "ok") throw new Error("create failed");
        return { id: r.challenge.id, num: r.challenge.number.replace("CH-", ""), topics: r.challenge.topics };
      };
      assert.deepEqual(await create("Retired topic", [tR.id]), { status: "invalid_topics", problem: "inactive" });
      assert.deepEqual(await create("Too many", [tA.id, tB.id, tC.id, tE.id]), { status: "invalid_topics", problem: "too_many" });
      const ch1 = await mustCreate("Opening", [tA.id]);
      assert.deepEqual(ch1.topics, [{ id: tA.id, name: tA.name, active: true }]);
      assert.deepEqual((await audited("challenge.created", ch1.id))[0]?.after, {
        title: `Opening ${stamp}`,
        namespaceId: nsId,
        visibility: "org",
        isAnonymous: false,
        topicIds: [tA.id],
      });

      // ── Event 18: the opening (§34.5) ─────────────────────────────────────────────────────
      const topicRows = async (challengeId: string) =>
        (
          await pool.query<{ user_id: string; payload: { message: string; subject: string; topics: string[] }; read_at: Date | null }>(
            `select user_id, payload, read_at from notifications where type = 'topic_challenge' and challenge_id = $1`,
            [challengeId],
          )
        ).rows;
      const markers = async (challengeId: string) =>
        new Map((await pool.query<{ user_id: string; via: string }>(`select user_id, via from topic_notices where challenge_id = $1`, [challengeId])).rows.map((r) => [r.user_id, r.via]));
      const toValid = async (num: string) => {
        const r = await store.setChallengeStatus(pool, nsAdmin, num, "valid");
        assert.equal(r.status, "ok");
        if (r.status !== "ok") throw new Error("transition failed");
        return r.opened;
      };

      const inReview = await store.setChallengeStatus(pool, nsAdmin, ch1.num, "in_review");
      assert.ok(inReview.status === "ok" && !inReview.opened, "in_review is not an opening");
      assert.equal(await toValid(ch1.num), true, "the first entry into valid is the opening");
      await notifyTopicFollowers(ctx, ch1.id, { via: "opening" });
      const told = new Set((await topicRows(ch1.id)).map((r) => r.user_id));
      for (const who of [fan1, fan2, daily, outsider]) assert.ok(told.has(who.userId), "a follower who can see it is told");
      assert.ok(!told.has(author.userId), "never the author");
      assert.ok(!told.has(nsAdmin.userId), "never the actor");
      assert.ok(!told.has(leaver.userId), "never a deactivated follower");
      assert.ok(!told.has(bFan.userId), "not a follower of another topic");
      const m1 = await markers(ch1.id);
      assert.equal(m1.get(fan1.userId), "opening");
      assert.equal(m1.has(author.userId), false, "nobody left out is marked");
      const fan2Row = (await topicRows(ch1.id)).find((r) => r.user_id === fan2.userId)!;
      assert.equal(fan2Row.payload.message, topicNoticeMessage({ topics: [tA.name], number: ch1.num, title: `Opening ${stamp}` }), "only the topics on the challenge");
      const { rows: outbox } = await pool.query<{ user_id: string; digest_due_at: Date | null; payload: { subject: string; digest?: { kind: string } } }>(
        `select user_id, digest_due_at, payload from notification_outbox where type = 'topic_challenge' and payload->>'parentId' = $1`,
        [ch1.id],
      );
      assert.equal(outbox.find((o) => o.user_id === fan1.userId)?.payload.subject, topicNoticeSubject([tA.name], ch1.num));
      assert.equal(outbox.find((o) => o.user_id === fan1.userId)?.digest_due_at, null, "immediate for an immediate recipient");
      const held = outbox.find((o) => o.user_id === daily.userId);
      assert.ok(held?.digest_due_at, "held for a daily digest");
      assert.equal(held?.payload.digest?.kind, "topic");

      await notifyTopicFollowers(ctx, ch1.id, { via: "opening" });
      assert.equal((await topicRows(ch1.id)).length, told.size, "nothing twice");
      await store.setChallengeStatus(pool, nsAdmin, ch1.num, "in_review");
      assert.equal(await toValid(ch1.num), false, "a second entry into valid is not an opening");

      await markCommentNotificationsReadForChallenge(pool, fan1.userId, ch1.id);
      assert.ok((await topicRows(ch1.id)).find((r) => r.user_id === fan1.userId)?.read_at, "opening the detail page reads the row");

      // ── An admin's re-tag, and a topic added while valid ──────────────────────────────────
      assert.equal((await topics.setChallengeTopics(pool, committee, ch1.num, [tA.id, tB.id])).status, "forbidden", "committee members cannot re-tag");
      assert.equal((await topics.setChallengeTopics(pool, fan1, ch1.num, [tA.id, tB.id])).status, "forbidden");
      const { rows: beforeTag } = await pool.query<{ updated_at: Date; edited_at: Date | null }>(`select updated_at, edited_at from challenges where id = $1`, [ch1.id]);
      const retag = await topics.setChallengeTopics(pool, nsAdmin, ch1.num, [tA.id, tB.id]);
      assert.equal(retag.status, "ok");
      if (retag.status !== "ok") throw new Error("retag failed");
      assert.deepEqual(retag.addedTopicIds, [tB.id]);
      const { rows: afterTag } = await pool.query<{ updated_at: Date; edited_at: Date | null }>(`select updated_at, edited_at from challenges where id = $1`, [ch1.id]);
      assert.deepEqual(afterTag[0], beforeTag[0], "curation moves neither updated_at nor edited_at");
      assert.deepEqual((await audited("challenge.topics_changed", ch1.id)).at(-1)?.after, { added: [{ id: tB.id, name: tB.name }], removed: [], via: "detail" });
      await notifyTopicFollowers(ctx, ch1.id, { via: "topic_added", topicIds: retag.addedTopicIds });
      const afterAdd = await topicRows(ch1.id);
      assert.ok(afterAdd.some((r) => r.user_id === bFan.userId && r.payload.topics.join() === tB.name), "the added topic's follower, named by it");
      assert.equal(afterAdd.filter((r) => r.user_id === fan2.userId).length, 1, "already told: nothing new");
      assert.equal((await markers(ch1.id)).get(bFan.userId), "topic_added");
      assert.deepEqual(await topics.setChallengeTopics(pool, nsAdmin, ch1.num, [tA.id, tR.id]), { status: "invalid_topics", problem: "inactive" });

      // ── A namespace-restricted challenge, then its widening ───────────────────────────────
      const ch2 = await mustCreate("Restricted", [tA.id], { visibility: "namespace" });
      assert.equal((await topics.setChallengeTopics(pool, outsider, ch2.num, [])).status, "not_found", "an invisible challenge is not found");
      await toValid(ch2.num);
      await notifyTopicFollowers(ctx, ch2.id, { via: "opening" });
      let ch2Told = new Set((await topicRows(ch2.id)).map((r) => r.user_id));
      assert.ok(ch2Told.has(fan1.userId) && !ch2Told.has(outsider.userId), "members only");
      const widened = await store.setChallengeVisibility(pool, nsAdmin, ch2.num, "org");
      assert.ok(widened.status === "ok" && widened.previousVisibility === "namespace");
      await notifyTopicFollowers(ctx, ch2.id, { via: "widened", previousVisibility: "namespace" });
      ch2Told = new Set((await topicRows(ch2.id)).map((r) => r.user_id));
      assert.ok(ch2Told.has(outsider.userId), "the widening reaches who can now see it");
      assert.equal((await topicRows(ch2.id)).filter((r) => r.user_id === fan1.userId).length, 1, "and nobody twice");
      assert.equal((await markers(ch2.id)).get(outsider.userId), "widened");

      // ── Event 15 counts as being told ─────────────────────────────────────────────────────
      const ch3 = await mustCreate("Shared", [tA.id]);
      const shared = await store.setChallengeVisibility(pool, nsAdmin, ch3.num, "people", { userIds: [outsider.userId], emails: [] });
      assert.equal(shared.status, "ok");
      await store.setChallengeStatus(pool, nsAdmin, ch3.num, "in_review"); // leaves triage: event 15
      assert.equal((await markers(ch3.id)).get(outsider.userId), "shared");
      await toValid(ch3.num);
      await notifyTopicFollowers(ctx, ch3.id, { via: "opening" });
      const ch3Told = new Set((await topicRows(ch3.id)).map((r) => r.user_id));
      assert.ok(!ch3Told.has(outsider.userId), "told by event 15 already");
      assert.ok(!ch3Told.has(fan1.userId), "membership alone does not open a people-shared challenge");

      // ── A retired topic and an archived namespace send nothing ────────────────────────────
      const ch4 = await mustCreate("Later", [tL.id]);
      assert.equal((await topics.setTopicFollow(pool, fan1.userId, tL.id, true)).status, "ok");
      assert.equal((await topics.patchTopic(pool, tL.id, { active: false }, platform.userId)).status, "ok");
      await toValid(ch4.num);
      await notifyTopicFollowers(ctx, ch4.id, { via: "opening" });
      assert.equal((await topicRows(ch4.id)).length, 0, "a retired topic never triggers");
      const ch5 = await mustCreate("Archived", [tA.id], { ns: archNsId });
      await toValid(ch5.num);
      await pool.query(`update namespaces set archived_at = now() where id = $1`, [archNsId]);
      await notifyTopicFollowers(ctx, ch5.id, { via: "opening" });
      assert.equal((await topicRows(ch5.id)).length, 0, "an archived namespace takes no solutions, so nothing opens");

      // ── The author's edit window ──────────────────────────────────────────────────────────
      const ch6 = await mustCreate("Editable", [tA.id]);
      const edit = (topicIds: string[]) =>
        store.editChallenge(pool, author, ch6.num, { title: `Editable ${stamp}`, description: "d", clientName: null, impactAreaId: internal.id, topicIds });
      assert.deepEqual(await edit([tA.id, tR.id]), { status: "invalid_topics", problem: "inactive" });
      const editOk = await edit([tB.id, tA.id]);
      assert.equal(editOk.status, "ok");
      if (editOk.status === "ok") assert.ok(editOk.challenge.editedAt, "an author's topic change is an edit");
      assert.deepEqual((await audited("challenge.edited", ch6.id)).at(-1), {
        before: { topicIds: [tA.id] },
        after: { topicIds: [tA.id, tB.id].sort() },
      });

      // ── The open count, the gallery filter and the search filter ─────────────────────────
      const ch7 = await mustCreate("Namespace only", [tB.id], { visibility: "namespace" });
      await store.setChallengeStatus(pool, nsAdmin, ch7.num, "in_review");
      const countFor = async (viewer: { userId: string; roles: RoleSet }, topicId: string) =>
        (await topics.listTopicsForViewer(pool, viewer)).find((t) => t.id === topicId);
      assert.equal((await countFor(fan1, tB.id))?.openCount, 2, "ch1 and the namespace-only ch7");
      assert.equal((await countFor(outsider, tB.id))?.openCount, 1, "never a challenge the viewer cannot see");
      assert.equal((await countFor(fan2, tB.id))?.following, true);
      assert.equal((await countFor(fan1, tR.id)), undefined, "retired topics are not listed");
      const withRetired = await topics.listTopicsForViewer(pool, nsAdmin, { includeRetired: true });
      assert.equal(withRetired.find((t) => t.id === tR.id)?.active, false, "the admins' triage list carries the retired ones");
      const gallery = await store.listChallenges(pool, fan1, { tab: "open", sort: "newest", topicId: tB.id });
      assert.deepEqual(new Set(gallery.map((c) => c.id)), new Set([ch1.id, ch7.id]));
      const found = await searchChallengePage(pool, outsider, { query: "", filters: { topicId: tB.id }, limit: 25, offset: 0 });
      assert.deepEqual(found.items.map((c) => c.id), [ch1.id]);

      // ── Bulk add / remove (§34.6) ─────────────────────────────────────────────────────────
      const addedTo: string[] = [];
      const bulkAdd = await topics.bulkChangeTopic(pool, nsAdmin, [ch1.num, ch6.num], "add", tC.id, async (id) => {
        addedTo.push(id);
      });
      assert.deepEqual(bulkAdd.map((o) => o.status), ["ok", "ok"]);
      assert.deepEqual(addedTo.sort(), [ch1.id, ch6.id].sort());
      const bulkFull = await topics.bulkChangeTopic(pool, nsAdmin, [ch1.num, ch1.num], "add", tE.id, async () => {});
      assert.deepEqual(bulkFull.map((o) => o.status), ["topic_limit", "topic_limit"]);
      const bulkRemove = await topics.bulkChangeTopic(pool, nsAdmin, [ch1.num, ch7.num], "remove", tC.id, async () => {});
      assert.deepEqual(bulkRemove.map((o) => o.status), ["ok", "unchanged"]);
      assert.deepEqual((await audited("challenge.topics_changed", ch6.id)).at(-1)?.after, { added: [{ id: tC.id, name: tC.name }], removed: [], via: "bulk" });

      // ── Deleting a retired topic ──────────────────────────────────────────────────────────
      assert.equal((await topics.patchTopic(pool, tC.id, { active: false }, platform.userId)).status, "ok");
      const delTopic = await topics.deleteTopic(pool, tC.id, platform.userId);
      assert.deepEqual(delTopic, { status: "ok", challengeCount: 1, followerCount: 0 });
      assert.deepEqual((await audited("challenge.topics_changed", ch6.id)).at(-1)?.after, { added: [], removed: [{ id: tC.id, name: tC.name }], trigger: "topic_deleted" });
      assert.equal((await pool.query(`select 1 from topics where id = $1`, [tC.id])).rows.length, 0);
      assert.equal((await audited("topic.deleted", tC.id)).length, 1);
      assert.equal((await topics.patchTopic(pool, tR.id, { active: true }, platform.userId)).status, "ok", "reactivating is allowed");

      // ── The §10.3 cascade and the §3 erasure ─────────────────────────────────────────────
      const del = await deleteChallenge({ pool, storage } as never, platform, ch1.num, "dbtest cleanup");
      assert.equal(del.status, "ok");
      if (del.status === "ok") {
        assert.ok(del.counts.topics >= 1, "the cascade counts the tags it removed");
        assert.ok(del.counts.topicNotices >= 1, "and the markers");
      }
      assert.equal((await pool.query(`select 1 from challenge_topics where challenge_id = $1`, [ch1.id])).rows.length, 0);
      assert.equal((await pool.query(`select 1 from topic_notices where challenge_id = $1`, [ch1.id])).rows.length, 0);
      assert.equal((await scrubUser(pool, platform.userId, fan2.userId)).status, "ok");
      assert.equal((await pool.query(`select 1 from topic_follows where user_id = $1`, [fan2.userId])).rows.length, 0, "erasure deletes the follows");
      assert.equal((await pool.query(`select 1 from topic_notices where user_id = $1`, [fan2.userId])).rows.length, 0, "and the markers");
    } finally {
      await pool.end();
    }
  },
);
