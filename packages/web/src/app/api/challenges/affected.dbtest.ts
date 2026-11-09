// Live-DB integration test (gated) for §41 "this affects me too" (INNOBOX_SPEC.md §41.10):
//   • the authors' estimate is written on create, counts as 1 when empty, and is edited only inside
//     the author's edit window (audited in the field-level diff);
//   • a first mark writes the row and `affected.marked`; a change writes `affected.changed`; saving
//     the same number writes nothing; a removal sets removed_at (`affected.removed`) and a re-mark
//     restores the row without being a first mark; two concurrent first marks give one row and one
//     first;
//   • refusals: an author, a challenge awaiting triage (for an admin who can see it), a closed one, a
//     trashed one (the trashed status) and one the caller cannot see (not found) — none writes a row;
//   • the detail block: reach, people, the viewer's own mark, the markers largest first;
//   • event 24: an inbox row and one outbox row to every author, coalesced in place by a second marker
//     with no second outbox row; nothing on an external challenge;
//   • joining the team takes the mark back (`joined_team`);
//   • the gallery's widest_reach sort and the triage queue's sort and export, per viewer;
//   • the similar-challenges fields; the §10.3 cascade counts the marks; erasure keeps them.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "affects me too: estimate, marks, refusals, block, event 24, team join, sorts, similar, cascade, erasure",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("./store");
    const aff = await import("./affected");
    const { deleteChallenge } = await import("./delete");
    const { trashChallenge } = await import("./trash");
    const { scrubUser } = await import("../users/store");
    const { listTriageQueue, exportTriageCsv } = await import("../admin/triage/store");
    const { notifyAffected } = await import("../../../lib/notify-events");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
            `dbtest-affected-${label}-${stamp}`,
            `Dbtest Affected ${label}`,
          ])
        ).rows[0]!.id;
      const nsId = await mkNs("main");
      const otherNsId = await mkNs("other");
      type Roles = ReturnType<typeof buildRoleSet>;
      const rolesOf = new Map<string, Roles>();
      const roles = (role: "member" | "committee" | "namespace_admin", ns: string) => buildRoleSet([{ role, namespaceId: ns }], { globalNamespaceId: globalId });
      const mkUser = async (label: string, r: Roles = roles("member", nsId)) => {
        const id = (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
            `dbtest-affected-${label}-${stamp}`,
            `dbtest-affected-${label}-${stamp}@example.test`,
            `Dbtest affected ${label} ${stamp}`,
          ])
        ).rows[0]!.id;
        rolesOf.set(id, r);
        return { userId: id, roles: r };
      };
      const resolveRoles = Object.assign(async (id: string) => rolesOf.get(id) ?? roles("member", globalId), {});
      const ctx = (actorId: string | null) => ({ pool, actorId, resolveRoles });
      const storage = { deleteObject: async () => {}, abortMultipartUpload: async () => {} };

      const author = await mkUser("author");
      const coauthor = await mkUser("coauthor");
      const ana = await mkUser("ana");
      const bob = await mkUser("bob");
      const cy = await mkUser("cy");
      const outsider = await mkUser("outsider", roles("member", otherNsId));
      const nsAdmin = await mkUser("nsadmin", roles("namespace_admin", nsId));
      const platform = await mkUser("platform", buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }));
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const newChallenge = async (
        title: string,
        opts: { visibility?: "org" | "namespace"; status?: string | null; estimate?: number | null; coAuthors?: string[] } = {},
      ) => {
        const r = await store.createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `${title} ${stamp}`,
          description: `About ${title} ${stamp}`,
          clientName: null,
          visibility: opts.visibility ?? "org",
          isAnonymous: false,
          affectedEstimate: opts.estimate ?? null,
          ...(opts.coAuthors ? { coAuthors: { ids: opts.coAuthors, resolveRoles } } : {}),
        });
        if (r.status !== "ok") throw new Error(`create failed: ${r.status}`);
        const num = r.challenge.number.replace("CH-", "");
        const status = opts.status === undefined ? "in_review" : opts.status;
        if (status) assert.equal((await store.setChallengeStatus(pool, nsAdmin, num, status)).status, "ok");
        return { id: r.challenge.id, num, created: r.challenge };
      };
      const audits = async (challengeId: string) =>
        (
          await pool.query<{ action: string; actor_user_id: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
            `select action, actor_user_id, before, after from audit_log where target_id = $1 and action like 'affected.%' order by id`,
            [challengeId],
          )
        ).rows;
      const markRow = async (challengeId: string, userId: string) =>
        (
          await pool.query<{ headcount: number; removed: boolean }>(
            `select headcount, removed_at is not null as removed from challenge_affected where challenge_id = $1 and user_id = $2`,
            [challengeId, userId],
          )
        ).rows;

      // ── The authors' estimate (§41.2) ────────────────────────────────────────────────────
      const main = await newChallenge("Slow VPN", { estimate: 30 });
      assert.equal(main.created.affectedEstimate, 30);
      assert.equal(main.created.reach, 30);
      const created = (await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where target_id = $1 and action = 'challenge.created'`, [main.id])).rows[0]!;
      assert.equal(created.after.affectedEstimate, 30);

      const empty = await newChallenge("No estimate", { status: null });
      assert.equal(empty.created.affectedEstimate, null);
      assert.equal(empty.created.reach, 1, "an empty estimate counts the authors as 1");
      // Editable in the author's window: awaiting_triage — and the change is in the diff.
      const edited = await store.editChallenge(pool, author, empty.num, {
        title: `No estimate ${stamp}`,
        description: `About No estimate ${stamp}`,
        clientName: null,
        impactAreaId: internal.id,
        affectedEstimate: 12,
        baseEditedAt: null,
      });
      assert.equal(edited.status, "ok");
      if (edited.status === "ok") assert.equal(edited.challenge.reach, 12);
      const diff = (await pool.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `select before, after from audit_log where target_id = $1 and action = 'challenge.edited' order by id desc limit 1`,
        [empty.id],
      )).rows[0]!;
      assert.deepEqual([diff.before.affectedEstimate, diff.after.affectedEstimate], [null, 12]);
      // Absent keeps it.
      const kept = await store.editChallenge(pool, author, empty.num, {
        title: `No estimate renamed ${stamp}`,
        description: `About No estimate ${stamp}`,
        clientName: null,
        impactAreaId: internal.id,
        baseEditedAt: edited.status === "ok" ? edited.challenge.editedAt : null,
      });
      assert.equal(kept.status, "ok");
      if (kept.status === "ok") assert.equal(kept.challenge.affectedEstimate, 12);
      // Outside the window (in_review) the edit is refused.
      assert.equal(
        (await store.editChallenge(pool, author, main.num, { title: "x", description: "y", clientName: null, impactAreaId: internal.id, affectedEstimate: 5, baseEditedAt: null })).status,
        "not_editable",
      );

      // ── Marks (§41.3) ────────────────────────────────────────────────────────────────────
      const first = await aff.setAffected(pool, ana, main.num, 12);
      assert.equal(first.status, "ok");
      if (first.status !== "ok") throw new Error("unreachable");
      assert.equal(first.first, true);
      assert.equal(first.block.reach, 42);
      assert.equal(first.block.affectedPeople, 1);
      assert.equal(first.block.affectedMine, 12);
      assert.deepEqual(await markRow(main.id, ana.userId), [{ headcount: 12, removed: false }]);

      // The same number again writes nothing; a change is audited before → after.
      const same = await aff.setAffected(pool, ana, main.num, 12);
      assert.equal(same.status === "ok" && same.first, false);
      const changed = await aff.setAffected(pool, ana, main.num, 20);
      assert.equal(changed.status === "ok" && changed.block.reach, 50);
      // A removal, then a re-mark — not a first mark.
      const removed = await aff.removeAffected(pool, ana, main.num);
      assert.equal(removed.status === "ok" && removed.block.reach, 30);
      assert.equal(removed.status === "ok" && removed.block.affectedMine, null);
      assert.deepEqual(await markRow(main.id, ana.userId), [{ headcount: 20, removed: true }]);
      const again = await aff.removeAffected(pool, ana, main.num);
      assert.equal(again.status, "ok", "removing with no current mark succeeds and writes nothing");
      const remark = await aff.setAffected(pool, ana, main.num, 7);
      assert.equal(remark.status === "ok" && remark.first, false, "a re-mark is not a first mark");
      assert.deepEqual(
        (await audits(main.id)).map((a) => [a.action, a.before, a.after]),
        [
          ["affected.marked", null, { headcount: 12 }],
          ["affected.changed", { headcount: 12 }, { headcount: 20 }],
          ["affected.removed", { headcount: 20 }, null],
          ["affected.marked", null, { headcount: 7 }],
        ],
      );

      // Two concurrent first marks by the same person: one row, exactly one first.
      const race = await Promise.all([aff.setAffected(pool, bob, main.num, 3), aff.setAffected(pool, bob, main.num, 3)]);
      assert.equal(race.filter((r) => r.status === "ok" && r.first).length, 1);
      assert.equal((await markRow(main.id, bob.userId)).length, 1);

      // ── Refusals ─────────────────────────────────────────────────────────────────────────
      assert.equal((await aff.setAffected(pool, author, main.num, 5)).status, "refused", "an author");
      assert.equal((await aff.affectedGate(pool, author, main.num)).status, "refused");
      // Awaiting triage: the namespace admin can see it but not mark it; a member cannot see it.
      const pending = await newChallenge("Pending", { status: null });
      assert.equal((await aff.setAffected(pool, nsAdmin, pending.num, 5)).status, "refused");
      assert.equal((await aff.setAffected(pool, ana, pending.num, 5)).status, "not_found");
      // A namespace-restricted challenge is invisible to an outsider.
      const restricted = await newChallenge("Restricted", { visibility: "namespace" });
      assert.equal((await aff.setAffected(pool, outsider, restricted.num, 5)).status, "not_found");
      // Closed: the marks stay, read-only.
      const closing = await newChallenge("Closing");
      assert.equal((await aff.setAffected(pool, cy, closing.num, 4)).status, "ok");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, closing.num, "rejected")).status, "ok");
      assert.equal((await aff.setAffected(pool, cy, closing.num, 9)).status, "refused");
      assert.equal((await aff.removeAffected(pool, cy, closing.num)).status, "refused");
      assert.deepEqual(await markRow(closing.id, cy.userId), [{ headcount: 4, removed: false }]);
      // Trashed.
      const trashed = await newChallenge("Trashed");
      assert.equal((await trashChallenge({ pool, storage } as never, platform, trashed.num, "dbtest")).status, "ok");
      assert.equal((await aff.setAffected(pool, platform, trashed.num, 2)).status, "trashed");
      for (const c of [pending, restricted, trashed]) {
        assert.equal((await pool.query(`select 1 from challenge_affected where challenge_id = $1`, [c.id])).rowCount, 0);
      }

      // ── The detail block (§41.10) ────────────────────────────────────────────────────────
      const detailAna = await store.getChallengeByNumber(pool, ana, main.num);
      assert.ok(detailAna);
      const block = await aff.affectedDetailFields(pool, ana, detailAna!);
      assert.equal(block.reach, 30 + 7 + 3);
      assert.equal(detailAna!.reach, block.reach, "the SQL reach and the block's agree");
      assert.equal(block.affectedPeople, 2);
      assert.equal(block.affectedMine, 7);
      assert.deepEqual(
        block.affected.map((p) => [p.id, p.headcount]),
        [
          [ana.userId, 7],
          [bob.userId, 3],
        ],
        "largest headcount first",
      );
      assert.equal(block.canMarkAffected, true);
      const detailAuthor = await store.getChallengeByNumber(pool, author, main.num);
      const authorBlock = await aff.affectedDetailFields(pool, author, detailAuthor!);
      assert.deepEqual([authorBlock.canMarkAffected, authorBlock.affectedReason], [false, "own"]);
      const pendingDetail = await store.getChallengeByNumber(pool, nsAdmin, pending.num);
      assert.equal((await aff.affectedDetailFields(pool, nsAdmin, pendingDetail!)).affectedReason, "not_yet");
      const closedDetail = await store.getChallengeByNumber(pool, cy, closing.num);
      const closedBlock = await aff.affectedDetailFields(pool, cy, closedDetail!);
      assert.deepEqual([closedBlock.affectedReason, closedBlock.affectedMine], ["closed", 4]);

      // ── Event 24 (§41.6) ─────────────────────────────────────────────────────────────────
      const team = await newChallenge("Team", { coAuthors: [coauthor.userId] });
      const t1 = await aff.setAffected(pool, ana, team.num, 5);
      assert.equal(t1.status === "ok" && t1.first, true);
      await notifyAffected(ctx(ana.userId), team.id, ana.userId, { headcount: 5, reach: 6, people: 1 });
      const t2 = await aff.setAffected(pool, bob, team.num, 2);
      assert.equal(t2.status === "ok" && t2.first, true);
      await notifyAffected(ctx(bob.userId), team.id, bob.userId, { headcount: 2, reach: 8, people: 2 });
      for (const recipient of [author, coauthor]) {
        const inbox = (
          await pool.query<{ id: string; payload: { count: number; message: string; reach: number } }>(
            `select id, payload from notifications where user_id = $1 and type = 'affected' and challenge_id = $2`,
            [recipient.userId, team.id],
          )
        ).rows;
        assert.equal(inbox.length, 1, "one coalesced row per author");
        assert.equal(inbox[0]!.payload.count, 2);
        assert.equal(inbox[0]!.payload.reach, 8);
        assert.match(inbox[0]!.payload.message, /^2 people say CH-\d+ affects them too — latest Dbtest affected bob/);
        const outbox = (await pool.query(`select 1 from notification_outbox where user_id = $1 and type = 'affected' and payload->>'parentId' = $2`, [recipient.userId, team.id]))
          .rowCount;
        assert.equal(outbox, 1, "the e-mail went out with the first marker only");
      }
      assert.equal(
        (await pool.query(`select 1 from notifications where type = 'affected' and challenge_id = $1 and user_id = any($2::uuid[])`, [team.id, [ana.userId, bob.userId]])).rowCount,
        0,
        "never the markers",
      );

      // ── Joining the team takes the mark back (§41.3) ────────────────────────────────────
      const joined = await store.changeTeam(pool, author, "challenge", team.num, { op: "add", userId: ana.userId }, resolveRoles);
      assert.equal(joined.status, "ok");
      assert.deepEqual(await markRow(team.id, ana.userId), [{ headcount: 5, removed: true }]);
      const joinAudit = (await audits(team.id)).at(-1)!;
      assert.equal(joinAudit.action, "affected.removed");
      assert.equal(joinAudit.actor_user_id, author.userId);
      assert.deepEqual(joinAudit.after, { trigger: "joined_team" });
      assert.equal((await aff.setAffected(pool, ana, team.num, 5)).status, "refused", "a member cannot mark");

      // ── Sorts (§41.5) ────────────────────────────────────────────────────────────────────
      const wide = await newChallenge("Wide", { estimate: 900 });
      const gallery = await store.listChallenges(pool, ana, { tab: "open", sort: "widest_reach", namespaceId: nsId });
      assert.equal(gallery[0]!.number, `CH-${wide.num}`);
      for (let i = 1; i < gallery.length; i++) assert.ok(gallery[i - 1]!.reach >= gallery[i]!.reach, "reach descending");
      assert.equal(
        gallery.some((c) => c.number === `CH-${restricted.num}`),
        true,
        "a member of the namespace sees its restricted challenge",
      );
      const outsiderGallery = await store.listChallenges(pool, outsider, { tab: "open", sort: "widest_reach", namespaceId: nsId });
      assert.equal(outsiderGallery.some((c) => c.number === `CH-${restricted.num}`), false, "never ranked for an outsider");

      const queue = await listTriageQueue(pool, nsAdmin, { namespaceId: nsId, sort: "widest_reach" });
      assert.equal(queue.rows[0]!.number, `CH-${wide.num}`);
      assert.equal(queue.rows[0]!.reach, 900);
      const mainRow = queue.rows.find((r) => r.number === `CH-${main.num}`)!;
      assert.deepEqual([mainRow.reach, mainRow.affectedPeople], [40, 2]);
      const page2 = await listTriageQueue(pool, nsAdmin, { namespaceId: nsId, sort: "widest_reach" }, { page: 2, pageSize: 1 });
      assert.equal(page2.rows[0]!.number, queue.rows[1]!.number, "the sort pages");
      const exported = await exportTriageCsv(pool, nsAdmin, { namespaceId: nsId, sort: "widest_reach" });
      assert.deepEqual(
        exported.rows.map((r) => r.number),
        queue.rows.map((r) => r.number),
        "the export follows the queue's sort",
      );

      // ── The similar-challenges fields (§41.5) ───────────────────────────────────────────
      const similar = await store.findSimilarChallenges(pool, ana, { title: `Slow VPN ${stamp}`, description: `About Slow VPN ${stamp}` });
      const hit = similar.find((s) => s.number === `CH-${main.num}`);
      assert.ok(hit, "the match is found");
      assert.deepEqual([hit!.canMarkAffected, hit!.affectedMine], [true, 7]);
      const authorSimilar = await store.findSimilarChallenges(pool, author, { title: `Slow VPN ${stamp}`, description: `About Slow VPN ${stamp}` });
      assert.equal(authorSimilar.find((s) => s.number === `CH-${main.num}`)?.canMarkAffected, false, "never on your own");

      // ── Erasure keeps the marks; the cascade removes them (§41.7) ───────────────────────
      assert.equal((await scrubUser(pool, platform.userId, bob.userId)).status, "ok");
      assert.deepEqual(await markRow(main.id, bob.userId), [{ headcount: 3, removed: false }]);
      const purged = await deleteChallenge({ pool, storage } as never, platform, main.num, "dbtest cleanup");
      assert.equal(purged.status, "ok");
      if (purged.status === "ok") assert.equal(purged.counts.affectedMarks, 2, "ana's and bob's");
      assert.equal((await pool.query(`select 1 from challenge_affected where challenge_id = $1`, [main.id])).rowCount, 0);
    } finally {
      await pool.end();
    }
  },
);
