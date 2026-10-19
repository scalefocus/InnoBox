// Live-DB integration test (gated) for §26 hype (INNOBOX_SPEC.md §26.11):
//   • a hype is written with the right weight (2 in the item's first week, 1 after) and audited;
//   • self-hype, a closed item, an awaiting-triage item, a trashed item and an invisible item
//     refuse without a row; a repeat refuses with a single row;
//   • the budget: the fourth hype of a week refuses and writes nothing; last week's hypes don't
//     count; two concurrent requests can never both take the last hype;
//   • hype_received (3 points) in the same transaction, never while anonymous, replayed on
//     self-reveal backdated to the hype; hype_fulfilled + Talent Scout on an override, the §8.3
//     auto-close and a bulk set — once per item, never revoked by a revert;
//   • event 16: one coalesced unread row and one outbox row for the author, the SQL refresh text
//     pinned to hypeNotificationMessage; no row for a deactivated author; opening the detail reads it;
//   • the detail decoration (hype, hyped, canHype, hypeReason, hypers newest first, budget);
//   • the Home board's per-viewer filter (a namespace-restricted item and a proposed solution
//     only for those §4.3 lets see them), and closed / trashed items off the board;
//   • the §10.3 cascade removes hypes and leaves the ledger; erasure keeps the hype rows;
//   • the platform switch is audited.
// Self-skips when DATABASE_URL is unset. It flips the hype switch and restores it to off.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "hype: give, budget, weight, awards, Talent Scout, event 16, detail, board, cascade, switch",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, hypeNotificationMessage } = await import("@innobox/shared");
    const store = await import("../challenges/store");
    const hype = await import("./store");
    const { deleteChallenge } = await import("../challenges/delete");
    const { trashChallenge } = await import("../challenges/trash");
    const { bulkSetStatus } = await import("../admin/triage/store");
    const { setHypeEnabled } = await import("../admin/settings/store");
    const { scrubUser } = await import("../users/store");
    const { notifyHyped } = await import("../../../lib/notify-events");
    const { markCommentNotificationsReadForChallenge } = await import("../../../lib/notify");

    const pool = new Pool({ connectionString: url });
    let platformId: string | null = null;
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
            `dbtest-hype-${label}-${stamp}`,
            `Dbtest Hype ${label}`,
          ])
        ).rows[0]!.id;
      const nsId = await mkNs("main");
      const otherNsId = await mkNs("other");
      const mkUser = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
            `dbtest-hype-${label}-${stamp}`,
            `dbtest-hype-${label}-${stamp}@example.test`,
            `Dbtest hype ${label} ${stamp}`,
          ])
        ).rows[0]!.id;
      const roles = (role: "member" | "committee" | "namespace_admin", ns: string) => buildRoleSet([{ role, namespaceId: ns }], { globalNamespaceId: globalId });
      const member = async (label: string) => ({ userId: await mkUser(label), roles: roles("member", nsId) });
      const author = await member("author");
      const fan1 = await member("fan1");
      const fan2 = await member("fan2");
      const fan3 = await member("fan3");
      const fan4 = await member("fan4");
      const proposer = await member("proposer");
      const outsider = { userId: await mkUser("outsider"), roles: roles("member", otherNsId) };
      const committee = { userId: await mkUser("committee"), roles: roles("committee", nsId) };
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: roles("namespace_admin", nsId) };
      const platform = {
        userId: await mkUser("platform"),
        roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }),
      };
      platformId = platform.userId;
      const resolveRoles = Object.assign(async () => roles("member", nsId), {});
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const newChallenge = async (title: string, opts: { anonymous?: boolean; visibility?: "org" | "namespace"; valid?: boolean } = {}) => {
        const r = await store.createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `${title} ${stamp}`,
          description: "d",
          clientName: null,
          visibility: opts.visibility ?? "org",
          isAnonymous: opts.anonymous ?? false,
        });
        assert.equal(r.status, "ok");
        if (r.status !== "ok") throw new Error("create failed");
        const num = r.challenge.number.replace("CH-", "");
        if (opts.valid !== false) assert.equal((await store.setChallengeStatus(pool, nsAdmin, num, "valid")).status, "ok");
        return { id: r.challenge.id, num };
      };
      const newSolution = async (chNum: string, who = proposer) => {
        const r = await store.createSolution(pool, who, chNum, { description: `Solution ${stamp}`, costVsBenefits: null, isAnonymous: false });
        assert.equal(r.status, "ok");
        if (r.status !== "ok") throw new Error("solution failed");
        return { id: r.solution.id, num: r.solution.number.replace("SOL-", "") };
      };
      const hypeRows = async (parentId: string) =>
        (await pool.query<{ user_id: string; weight: number }>(`select user_id, weight from hypes where parent_id = $1 order by id`, [parentId])).rows;
      const ledger = async (userId: string, reason: string) =>
        (
          await pool.query<{ points: number; item_id: string; occurred_at: Date }>(
            `select points, item_id, occurred_at from gamification_ledger where user_id = $1 and reason = $2 order by id`,
            [userId, reason],
          )
        ).rows;

      // ── The switch is audited. ───────────────────────────────────────────────────────────
      await setHypeEnabled(pool, true, platform.userId);
      const { rows: switchAudit } = await pool.query<{ after: { enabled: boolean } }>(
        `select after from audit_log where action = 'settings.hype_enabled_changed' and actor_user_id = $1 order by id desc limit 1`,
        [platform.userId],
      );
      assert.deepEqual(switchAudit[0]?.after, { enabled: true });

      // ── Eligibility: awaiting triage, self-hype. ─────────────────────────────────────────
      const triaged = await newChallenge("Triage", { valid: false });
      assert.deepEqual(await hype.giveHype(pool, fan1, "challenge", triaged.id), { status: "not_found" }, "awaiting triage is invisible to a member");
      assert.deepEqual(await hype.giveHype(pool, nsAdmin, "challenge", triaged.id), { status: "refused", reason: "closed" }, "visible but not open");

      const ch = await newChallenge("Main");
      assert.deepEqual(await hype.giveHype(pool, author, "challenge", ch.id), { status: "refused", reason: "own" });
      assert.equal((await hypeRows(ch.id)).length, 0, "a refused hype writes nothing");

      // ── A hype: weight 2 in the first week, audited, 3 points to the author. ────────────
      const first = await hype.giveHype(pool, fan1, "challenge", ch.id);
      assert.equal(first.status, "ok");
      if (first.status === "ok") {
        assert.equal(first.weight, 2);
        assert.equal(first.hype, 2);
        assert.equal(first.hypesLeft, 2);
        assert.deepEqual(
          first.hypers.map((h) => h.id),
          [fan1.userId],
        );
      }
      const { rows: given } = await pool.query<{ after: { weight: number } }>(
        `select after from audit_log where action = 'hype.given' and target_id = $1 and actor_user_id = $2`,
        [ch.id, fan1.userId],
      );
      assert.deepEqual(given[0]?.after, { weight: 2 });
      assert.deepEqual(
        (await ledger(author.userId, "hype_received")).map((r) => r.points),
        [3],
      );
      assert.deepEqual(await hype.giveHype(pool, fan1, "challenge", ch.id), { status: "refused", reason: "hyped" });
      assert.equal((await hypeRows(ch.id)).length, 1, "a repeat never writes a second row");

      // A week-old item weighs 1.
      const old = await newChallenge("Old");
      await pool.query(`update challenges set created_at = now() - interval '8 days' where id = $1`, [old.id]);
      const late = await hype.giveHype(pool, fan2, "challenge", old.id);
      assert.equal(late.status === "ok" && late.weight, 1);

      // ── The budget: 3 a week, last week's don't count, the fourth refuses. ───────────────
      const b1 = await newChallenge("Budget 1");
      const b2 = await newChallenge("Budget 2");
      const b3 = await newChallenge("Budget 3");
      const b4 = await newChallenge("Budget 4");
      // Three hypes from last week (inserted directly — the app role has no UPDATE on hypes).
      for (const c of [b1, b2, b3]) {
        await pool.query(`insert into hypes (user_id, parent_type, parent_id, weight, created_at) values ($1, 'challenge', $2, 1, now() - interval '8 days')`, [
          fan3.userId,
          c.id,
        ]);
      }
      for (const c of [ch, old, b4]) assert.equal((await hype.giveHype(pool, fan3, "challenge", c.id)).status, "ok", "last week's hypes don't count");
      assert.deepEqual(await hype.giveHype(pool, fan4, "challenge", b1.id).then((r) => r.status), "ok");
      assert.deepEqual(await hype.giveHype(pool, fan3, "challenge", ch.id), { status: "refused", reason: "hyped" });
      const extra = await newChallenge("Budget 5");
      assert.deepEqual(await hype.giveHype(pool, fan3, "challenge", extra.id), { status: "refused", reason: "budget" });
      assert.equal((await hypeRows(extra.id)).length, 0, "the fourth hype writes nothing");

      // Concurrency: fan4 has 2 left after one more; two parallel requests for the last one.
      assert.equal((await hype.giveHype(pool, fan4, "challenge", b2.id)).status, "ok");
      const race = await Promise.all([hype.giveHype(pool, fan4, "challenge", b3.id), hype.giveHype(pool, fan4, "challenge", extra.id)]);
      assert.deepEqual(race.map((r) => r.status).sort(), ["ok", "refused"], "only one request takes the last hype");

      // ── The detail decoration. ───────────────────────────────────────────────────────────
      const forFan = await hype.decorateDetailWithHype(pool, fan1, (await store.getChallengeByNumber(pool, fan1, ch.num))!);
      assert.equal(forFan.hype, 2 + 2, "fan1 and fan3, both early");
      assert.equal(forFan.hyped, true);
      assert.equal(forFan.hypeReason, "hyped");
      assert.equal(forFan.hypeEarly, true);
      assert.deepEqual(
        forFan.hypers.map((h) => h.id),
        [fan3.userId, fan1.userId],
        "newest first",
      );
      const forAuthor = await hype.decorateDetailWithHype(pool, author, (await store.getChallengeByNumber(pool, author, ch.num))!);
      assert.equal(forAuthor.canHype, false);
      assert.equal(forAuthor.hypeReason, "own");
      const forFresh = await hype.decorateDetailWithHype(pool, fan2, (await store.getChallengeByNumber(pool, fan2, ch.num))!);
      assert.equal(forFresh.canHype, true);
      assert.equal(forFresh.hypeReason, null);
      assert.equal(forFresh.hypesLeft, 2, "fan2 spent one on the old challenge");

      // ── Event 16: coalesced for the author, one outbox row, text pinned to the shared builder. ──
      const ctx = { pool, actorId: fan1.userId, resolveRoles };
      await notifyHyped(ctx, "challenge", ch.id, fan1.userId, 2);
      await notifyHyped({ ...ctx, actorId: fan3.userId }, "challenge", ch.id, fan3.userId, 4);
      const { rows: inbox } = await pool.query<{ id: string; payload: { count: number; message: string; itemLabel: string; latestBy: string } }>(
        `select id, payload from notifications where user_id = $1 and type = 'hyped' and read_at is null and payload->>'parentId' = $2`,
        [author.userId, ch.id],
      );
      assert.equal(inbox.length, 1, "one unread row per item");
      assert.equal(inbox[0]!.payload.count, 2);
      assert.equal(inbox[0]!.payload.message, hypeNotificationMessage(2, inbox[0]!.payload.itemLabel, inbox[0]!.payload.latestBy, 4));
      const { rows: outbox } = await pool.query<{ payload: { subject: string } }>(
        `select payload from notification_outbox where user_id = $1 and type = 'hyped' and payload->>'parentId' = $2`,
        [author.userId, ch.id],
      );
      assert.equal(outbox.length, 1, "one e-mail until the row is read");
      assert.match(outbox[0]!.payload.subject, /hyped your challenge CH-\d+$/);
      await markCommentNotificationsReadForChallenge(pool, author.userId, ch.id);
      const { rows: stillUnread } = await pool.query(`select 1 from notifications where user_id = $1 and type = 'hyped' and read_at is null and payload->>'parentId' = $2`, [
        author.userId,
        ch.id,
      ]);
      assert.equal(stillUnread.length, 0, "opening the challenge reads the hyped row");

      // ── Anonymous: no award until self-reveal, then replayed backdated. ──────────────────
      const anon = await newChallenge("Anon", { anonymous: true });
      assert.equal((await hype.giveHype(pool, fan2, "challenge", anon.id)).status, "ok");
      assert.equal((await ledger(author.userId, "hype_received")).filter((r) => r.item_id === anon.id).length, 0, "nothing while anonymous");
      assert.equal((await hype.giveHype(pool, author, "challenge", anon.id)).status, "refused", "own anonymous item refused too");
      assert.equal((await store.selfRevealChallenge(pool, author, anon.num)).status, "ok");
      const replayed = (await ledger(author.userId, "hype_received")).filter((r) => r.item_id === anon.id);
      assert.equal(replayed.length, 1, "the reveal replays one award per hype");
      const { rows: anonHype } = await pool.query<{ created_at: Date }>(`select created_at from hypes where parent_id = $1`, [anon.id]);
      assert.equal(replayed[0]!.occurred_at.getTime(), anonHype[0]!.created_at.getTime(), "backdated to the hype");

      // ── The Home board: per viewer, open only. ───────────────────────────────────────────
      const restricted = await newChallenge("Restricted", { visibility: "namespace" });
      assert.equal((await hype.giveHype(pool, committee, "challenge", restricted.id)).status, "ok");
      const proposedOn = await newChallenge("Proposed parent");
      const proposed = await newSolution(proposedOn.num);
      assert.equal((await hype.giveHype(pool, committee, "solution", proposed.id)).status, "ok", "the committee sees a proposed solution");
      assert.equal((await hype.giveHype(pool, fan1, "solution", proposed.id)).status, "not_found", "a member does not");
      const boardNums = async (viewer: typeof fan1) => (await hype.getHypedBoard(pool, viewer)).items.map((i) => i.number);
      const restrictedNum = `CH-${restricted.num}`;
      const proposedNum = `SOL-${proposed.num}`;
      // The board is a top 5 across the whole database; ranking ties aside, assert only membership.
      const outsiderBoard = await hype.getHypedBoard(pool, outsider);
      assert.equal(outsiderBoard.items.some((i) => i.number === restrictedNum), false, "a restricted item never reaches an outsider's board");
      assert.equal(outsiderBoard.items.some((i) => i.number === proposedNum), false);
      assert.equal((await boardNums(fan1)).includes(proposedNum), false, "a proposed solution is not on a member's board");
      for (const item of outsiderBoard.items) assert.notEqual(item.author.displayName, "", "authors arrive masked or named, never blank");

      // ── Talent Scout: an override to implemented auto-solves; both items' hypers earn. ──
      const winnerParent = await newChallenge("Winner parent");
      const winner = await newSolution(winnerParent.num);
      assert.equal((await store.setSolutionStatus(pool, nsAdmin, winner.num, "valid")).status, "ok");
      assert.equal((await hype.giveHype(pool, fan2, "solution", winner.id)).status, "ok");
      assert.deepEqual(await hype.giveHype(pool, fan2, "challenge", winnerParent.id), { status: "refused", reason: "budget" }, "fan2's budget is spent");
      await pool.query(`insert into hypes (user_id, parent_type, parent_id, weight) values ($1, 'challenge', $2, 1)`, [fan4.userId, winnerParent.id]);
      assert.equal((await store.setSolutionStatus(pool, nsAdmin, winner.num, "implemented")).status, "ok");
      assert.equal((await ledger(fan2.userId, "hype_fulfilled")).filter((r) => r.item_id === winner.id).length, 1, "the solution's hyper");
      assert.equal((await ledger(fan4.userId, "hype_fulfilled")).filter((r) => r.item_id === winnerParent.id).length, 1, "the auto-solved challenge's hyper");
      const { rows: scout } = await pool.query(`select tier from user_badges where user_id = $1 and badge_key = 'talent_scout'`, [fan2.userId]);
      assert.deepEqual(
        scout.map((r) => r.tier),
        [1],
        "Talent Scout Bronze",
      );
      assert.equal((await ledger(fan2.userId, "hype_fulfilled"))[0]!.points, 0, "a marker, never points");
      // A revert and a second solve neither revoke nor double-award.
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, winnerParent.num, "valid")).status, "ok");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, winnerParent.num, "solved")).status, "ok");
      assert.equal((await ledger(fan4.userId, "hype_fulfilled")).filter((r) => r.item_id === winnerParent.id).length, 1, "once per item");

      // A bulk status set awards too, and a closed item refuses and leaves the board.
      assert.equal((await hype.giveHype(pool, fan1, "challenge", b4.id)).status, "ok");
      await bulkSetStatus(pool, nsAdmin, [b4.num], "solved", resolveRoles);
      assert.equal((await ledger(fan1.userId, "hype_fulfilled")).filter((r) => r.item_id === b4.id).length, 1, "the bulk set awards");
      assert.deepEqual(await hype.giveHype(pool, fan2, "challenge", b4.id), { status: "refused", reason: "closed" });
      assert.equal((await boardNums(fan1)).includes(`CH-${b4.num}`), false, "a closed item is off the board");
      const closedDetail = await hype.decorateDetailWithHype(pool, fan1, (await store.getChallengeByNumber(pool, fan1, b4.num))!);
      assert.ok(closedDetail.hype > 0, "the number stays on a closed item");
      assert.equal(closedDetail.hypeReason, "closed");

      // ── Trash: refused, off the board. ───────────────────────────────────────────────────
      const storage = { deleteObject: async () => {}, abortMultipartUpload: async () => {} };
      assert.equal((await trashChallenge({ pool, storage } as never, platform, b1.num, "dbtest")).status, "ok");
      assert.deepEqual(await hype.giveHype(pool, platform, "challenge", b1.id), { status: "trashed" });
      assert.equal((await boardNums(platform)).includes(`CH-${b1.num}`), false);

      // ── Deactivated author: no event 16 row. ─────────────────────────────────────────────
      const leaverAuthor = await member("leaver");
      const leaverItem = await store.createChallenge(pool, leaverAuthor, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: `Leaver ${stamp}`,
        description: "d",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      if (leaverItem.status !== "ok") throw new Error("leaver create failed");
      await pool.query(`update users set active = false where id = $1`, [leaverAuthor.userId]);
      await notifyHyped(ctx, "challenge", leaverItem.challenge.id, fan1.userId, 2);
      const { rows: leaverRows } = await pool.query(`select 1 from notifications where user_id = $1 and type = 'hyped'`, [leaverAuthor.userId]);
      assert.equal(leaverRows.length, 0, "a deactivated author is never a recipient");

      // ── Erasure keeps the hype rows; the §10.3 cascade removes them and keeps the ledger. ──
      assert.equal((await scrubUser(pool, platform.userId, fan3.userId)).status, "ok");
      assert.ok((await pool.query(`select 1 from hypes where user_id = $1`, [fan3.userId])).rows.length > 0, "erasure keeps the hypes");
      const before = (await ledger(author.userId, "hype_received")).filter((r) => r.item_id === ch.id).length;
      const del = await deleteChallenge({ pool, storage } as never, platform, ch.num, "dbtest cleanup");
      assert.equal(del.status, "ok");
      if (del.status === "ok") assert.ok(del.counts.hypes >= 1, "the cascade counts the hypes it removed");
      assert.equal((await hypeRows(ch.id)).length, 0);
      assert.equal((await ledger(author.userId, "hype_received")).filter((r) => r.item_id === ch.id).length, before, "the ledger is untouched");
    } finally {
      if (platformId) {
        const { setHypeEnabled: off } = await import("../admin/settings/store");
        await off(pool, false, platformId).catch(() => {});
      }
      await pool.end();
    }
  },
);
