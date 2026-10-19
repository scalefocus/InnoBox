// Live-DB integration test (gated) for the §10.4 trash & restore. What is worth proving at SQL
// level: every route answers 404 to a non-platform-admin; a trashed challenge (and everything
// under it) drops out of the lists for EVERYONE, platform admins included, while the platform
// admin can still open its read-only detail; writes to it are refused (409 for the platform admin,
// 404 for anyone else); trash → restore round-trips every child row untouched; inbox rows are
// hidden while trashed and back after restore, unsent outbox and webhook rows are removed for good;
// a trashed implemented solution keeps its challenge solved and still blocks a second winner; and
// the nested-restore rule. Self-skips when DATABASE_URL is unset. Mirrors delete.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

function makeFakeStorage() {
  const aborted: string[] = [];
  return {
    aborted,
    storage: {
      deleteObject: async () => {},
      abortMultipartUpload: async (key: string) => {
        aborted.push(key);
      },
    },
  };
}

test(
  "§10.4 trash & restore: 404 for non-platform-admins, hidden everywhere, read-only, lossless restore, side effects",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("./store");
    const { trashChallenge, trashSolution, restoreChallenge, restoreSolution, listTrash } = await import("./trash");
    const { getInbox, markAllRead } = await import("../notifications/store");
    const { createComment } = await import("../comments/store");
    const { toggleFollow } = await import("../follows/store");

    const pool = new Pool({ connectionString: url });
    const { storage, aborted } = makeFakeStorage();
    const deps = { pool, storage };
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Trash NS') returning id`,
        [`dbtest-trash-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-trash-${label}-${stamp}`, `dbtest-trash-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "member" | "namespace_admin" | "platform_admin"; namespaceId: string | null }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });
      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const rival = { userId: await mkUser("rival"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const pa = { userId: await mkUser("pa"), roles: roles([{ role: "platform_admin", namespaceId: null }]) };

      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const created = await store.createChallenge(pool, author, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: `Trash me ${stamp}`,
        description: "Body",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const challengeId = created.challenge.id;
      const chNum = created.challenge.number.replace("CH-", "");
      assert.equal((await store.setChallengeStatus(pool, pa, chNum, "valid")).status, "ok");
      assert.equal((await store.setChallengeAssignee(pool, pa, chNum, nsAdmin.userId, async () => nsAdmin.roles)).status, "ok");

      const winner = await store.createSolution(pool, author, chNum, { description: "Winner", costVsBenefits: null, isAnonymous: false });
      const sibling = await store.createSolution(pool, rival, chNum, { description: "Sibling", costVsBenefits: null, isAnonymous: false });
      assert.ok(winner.status === "ok" && sibling.status === "ok");
      if (winner.status !== "ok" || sibling.status !== "ok") return;
      const winnerNum = winner.solution.number.replace("SOL-", "");
      const siblingNum = sibling.solution.number.replace("SOL-", "");
      for (const st of ["in_review", "valid"]) {
        assert.equal((await store.setSolutionStatus(pool, pa, siblingNum, st)).status, "ok");
        assert.equal((await store.setSolutionStatus(pool, pa, winnerNum, st)).status, "ok");
      }

      // Children: a comment, a like, a follow, an attachment, an inbox row and unsent mail/posts.
      assert.equal((await createComment(pool, rival, "challenge", challengeId, "hello")).status, "ok");
      assert.equal((await store.toggleLike(pool, rival, "challenge", challengeId)).status, "ok");
      assert.equal((await toggleFollow(pool, rival, "challenge", challengeId)).status, "ok");
      await pool.query(
        `insert into attachments (parent_type, parent_id, filename, size_bytes, mime, object_key, scan_status, uploaded_by)
         values ('challenge', $1, 'f.txt', 4, 'text/plain', $2, 'clean', $3)`,
        [challengeId, `dbtest-trash-${stamp}-obj`, author.userId],
      );
      await pool.query(
        `insert into attachment_uploads (attachment_id, parent_type, parent_id, filename, mime, declared_size_bytes, object_key, s3_upload_id, chunk_size_bytes, uploaded_by)
         values ($1, 'challenge', $2, 'big.bin', 'application/zip', 99, $3, 'mpu-trash', 8, $4)`,
        [randomUUID(), challengeId, `dbtest-trash-${stamp}-session`, author.userId],
      );
      const payload = (link: string) => JSON.stringify({ message: "m", link, parentType: "challenge", parentId: challengeId });
      await pool.query(`insert into notifications (user_id, type, payload) values ($1, 'status_changed', $2)`, [rival.userId, payload(`/challenges/${chNum}`)]);
      await pool.query(`insert into notification_outbox (user_id, type, payload, status) values ($1, 'status_changed', $2, 'pending')`, [
        rival.userId,
        payload(`/challenges/${chNum}`),
      ]);
      await pool.query(`insert into notification_outbox (user_id, type, payload, status) values ($1, 'status_changed', $2, 'sent')`, [
        rival.userId,
        payload(`/challenges/${chNum}`),
      ]);
      const { rows: hookRows } = await pool.query<{ id: string }>(
        `insert into channel_webhooks (namespace_id, name, format, url_enc, url_hint, enabled) values ($1, 'Trash hook', 'json', 'x', 'hooks.example.com …abcd', true) returning id`,
        [nsId],
      );
      for (const status of ["pending", "sent"]) {
        await pool.query(
          `insert into webhook_deliveries (webhook_id, event, entity_type, entity_id, event_status, occurred_at, status) values ($1, 'challenge.validated', 'challenge', $2, 'valid', now(), $3)`,
          [hookRows[0]!.id, challengeId, status],
        );
      }
      const before = await snapshot(pool, challengeId);
      const inboxBefore = await getInbox(pool, rival);
      assert.ok(inboxBefore.notifications.some((n) => n.link === `/challenges/${chNum}`), "fixture: the rival has an inbox row about it");

      // ── 1. Non-platform-admins: 404 everywhere, nothing touched ───────────────────────────
      for (const who of [author, nsAdmin]) {
        assert.equal((await trashChallenge(deps, who, chNum, "nope")).status, "not_found");
        assert.equal((await trashSolution(deps, who, winnerNum, "nope")).status, "not_found");
        assert.equal((await restoreChallenge(pool, who, chNum)).status, "not_found");
        assert.equal((await restoreSolution(pool, who, winnerNum)).status, "not_found");
        assert.equal(await listTrash(pool, who, null), null);
      }
      assert.deepEqual(await snapshot(pool, challengeId), before, "a refused trash changes nothing");

      // ── 2. Trash the challenge ───────────────────────────────────────────────────────────
      assert.equal((await trashChallenge(deps, pa, chNum, "posted by mistake")).status, "ok");
      assert.equal((await trashChallenge(deps, pa, chNum, "again")).status, "already_trashed");
      assert.equal((await trashSolution(deps, pa, winnerNum, "under a trashed challenge")).status, "already_trashed");

      // Gone from every list, for the platform admin too.
      for (const who of [author, rival, nsAdmin, pa]) {
        for (const tab of ["open", "mine", "completed"] as const) {
          const list = await store.listChallenges(pool, who, { tab, sort: "newest" });
          assert.ok(!list.some((c) => c.id === challengeId), `hidden from ${tab} list`);
        }
      }
      // Detail: 404 to everyone but the platform admin, who gets the read-only trashed view.
      for (const who of [author, rival, nsAdmin]) assert.equal(await store.getChallengeByNumber(pool, who, chNum), null);
      const view = await store.getChallengeByNumber(pool, pa, chNum);
      assert.ok(view, "the platform admin can open a trashed challenge");
      assert.equal(view!.trashed?.reason, "posted by mistake");
      assert.equal(view!.canRestore, true);
      assert.equal(view!.canTrash, false);
      assert.equal(view!.canDelete, true);
      for (const flag of [view!.canOverrideStatus, view!.canAssign, view!.canPropose, view!.canFeature, view!.canEdit, view!.canReveal]) assert.equal(flag, false);
      assert.ok(view!.solutions.every((s) => !s.canOverrideStatus && !s.canTrash && !s.canRestore), "solutions under a trashed challenge are read-only");

      // Writes: 409 for the platform admin, 404 for everyone else.
      assert.equal((await store.setChallengeStatus(pool, pa, chNum, "solved")).status, "trashed");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, chNum, "solved")).status, "not_found");
      assert.equal((await store.setSolutionStatus(pool, pa, winnerNum, "accepted_internally")).status, "trashed");
      assert.equal((await store.toggleLike(pool, pa, "challenge", challengeId)).status, "trashed");
      assert.equal((await store.toggleLike(pool, rival, "challenge", challengeId)).status, "not_found");
      assert.equal((await createComment(pool, pa, "challenge", challengeId, "x")).status, "trashed");
      assert.equal((await createComment(pool, rival, "challenge", challengeId, "x")).status, "not_found");
      assert.equal((await toggleFollow(pool, pa, "challenge", challengeId)).status, "trashed");
      assert.equal((await store.withdrawChallenge(pool, author, chNum)).status, "not_found");

      // Inbox hidden (list and count) and left alone by mark-all-read; unsent mail/posts gone.
      const inboxTrashed = await getInbox(pool, rival);
      assert.ok(!inboxTrashed.notifications.some((n) => n.link === `/challenges/${chNum}`), "inbox row hidden while trashed");
      assert.equal(inboxTrashed.unreadCount, inboxBefore.unreadCount - 1);
      await markAllRead(pool, rival);
      const outbox = await pool.query<{ status: string }>(`select status from notification_outbox where payload->>'parentId' = $1`, [challengeId]);
      assert.deepEqual(outbox.rows.map((r) => r.status), ["sent"], "only the already-sent row stays");
      const hooks = await pool.query<{ status: string }>(`select status from webhook_deliveries where entity_id = $1`, [challengeId]);
      assert.deepEqual(hooks.rows.map((r) => r.status), ["sent"]);
      assert.deepEqual(aborted, [`dbtest-trash-${stamp}-session`], "the in-flight upload is aborted");

      // The trash page lists it, masked, with its purge date 30 days on.
      const page = await listTrash(pool, pa, `CH-${chNum}`);
      assert.equal(page?.length, 1);
      assert.equal(page![0]!.reason, "posted by mistake");
      const trashedAt = new Date(page![0]!.trashedAt).getTime();
      assert.equal(new Date(page![0]!.purgesOn).getTime() - trashedAt, 30 * 24 * 60 * 60 * 1000);
      assert.equal((await listTrash(pool, pa, `SOL-${chNum}`))?.some((r) => r.number === `CH-${chNum}`), false, "a SOL- filter never matches a challenge");

      // Audit: number, namespace, status, reason — no content.
      const trashAudit = await pool.query<{ after: Record<string, unknown> }>(
        `select after from audit_log where action = 'challenge.trashed' and target_id = $1`,
        [challengeId],
      );
      assert.deepEqual(trashAudit.rows[0]!.after, { number: `CH-${chNum}`, namespaceId: nsId, status: "valid", reason: "posted by mistake" });

      // ── 3. Restore: everything back exactly as it was ────────────────────────────────────
      assert.equal((await restoreChallenge(pool, pa, chNum)).status, "ok");
      assert.equal((await restoreChallenge(pool, pa, chNum)).status, "not_trashed");
      const after = await snapshot(pool, challengeId);
      assert.deepEqual({ ...after, uploads: before.uploads }, before, "every child row, the status, the assignee and updated_at round-trip");
      const inboxBack = await getInbox(pool, rival);
      const row = inboxBack.notifications.find((n) => n.link === `/challenges/${chNum}`);
      assert.ok(row, "the inbox row is back after restore");
      assert.equal(row!.read, false, "mark-all-read did not touch it while it was hidden");
      assert.ok((await store.listChallenges(pool, rival, { tab: "open", sort: "newest" })).some((c) => c.id === challengeId));
      const restoreAudit = await pool.query<{ after: { daysInTrash: number } }>(
        `select after from audit_log where action = 'challenge.restored' and target_id = $1`,
        [challengeId],
      );
      assert.equal(restoreAudit.rows[0]!.after.daysInTrash, 0);

      // ── 4. A trashed implemented solution keeps the challenge solved and the winner slot ──
      for (const st of ["accepted_internally", "waiting_for_resources", "in_implementation", "external_acceptance", "implemented"]) {
        assert.equal((await store.setSolutionStatus(pool, pa, winnerNum, st)).status, "ok", `winner → ${st}`);
      }
      // The auto-close closed the sibling; put it back to `valid` to probe the single-winner gate.
      assert.equal((await store.setSolutionStatus(pool, pa, siblingNum, "valid")).status, "ok");
      assert.equal((await trashSolution(deps, pa, winnerNum, "duplicate")).status, "ok");
      const parent = await pool.query<{ status: string }>(`select status from challenges where id = $1`, [challengeId]);
      assert.equal(parent.rows[0]!.status, "solved", "trashing the implemented solution does not un-solve the challenge");
      assert.equal(
        (await store.setSolutionStatus(pool, pa, siblingNum, "accepted_internally")).status,
        "blocked_single_winner",
        "a trashed winner still holds the single-winner slot",
      );
      const detail = await store.getChallengeByNumber(pool, rival, chNum);
      assert.ok(detail && !detail.solutions.some((s) => s.number === `SOL-${winnerNum}`), "a trashed solution is hidden from others");
      const paDetail = await store.getChallengeByNumber(pool, pa, chNum);
      const trashedSol = paDetail!.solutions.find((s) => s.number === `SOL-${winnerNum}`);
      assert.ok(trashedSol?.trashed, "the platform admin sees it, marked trashed");
      assert.equal(trashedSol!.canRestore, true);
      assert.equal(trashedSol!.restoreBlocked, false);

      // ── 5. Nested trash: the challenge goes too; restoring it leaves the solution trashed ──
      assert.equal((await trashChallenge(deps, pa, chNum, "the whole thing")).status, "ok");
      assert.equal((await restoreSolution(pool, pa, winnerNum)).status, "parent_trashed");
      assert.equal((await restoreChallenge(pool, pa, chNum)).status, "ok");
      const stillTrashed = await pool.query<{ trashed: boolean }>(`select trashed_at is not null as trashed from solutions where number = $1`, [winnerNum]);
      assert.equal(stillTrashed.rows[0]!.trashed, true, "an individually trashed solution keeps its own clock");
      assert.equal((await restoreSolution(pool, pa, winnerNum)).status, "ok");
      assert.equal((await restoreSolution(pool, pa, siblingNum)).status, "not_trashed");
    } finally {
      await pool.end();
    }
  },
);

/** Everything a restore must give back untouched. */
async function snapshot(pool: import("pg").Pool, challengeId: string) {
  const one = async (sql: string) => (await pool.query(sql, [challengeId])).rows;
  return {
    challenge: (await one(`select status, assignee_id, visibility, number, updated_at, edited_at from challenges where id = $1`))[0],
    solutions: await one(`select id, status, updated_at from solutions where challenge_id = $1 order by id`),
    comments: await one(`select id, body from comments where parent_type = 'challenge' and parent_id = $1 order by id`),
    likes: await one(`select user_id from likes where parent_type = 'challenge' and parent_id = $1 order by user_id`),
    follows: await one(`select user_id from follows where parent_type = 'challenge' and parent_id = $1 order by user_id`),
    attachments: await one(`select id, removed_at from attachments where parent_type = 'challenge' and parent_id = $1 order by id`),
    inbox: await one(`select id from notifications where payload->>'parentId' = $1::text order by id`),
    uploads: await one(`select object_key from attachment_uploads where parent_type = 'challenge' and parent_id = $1`),
  };
}
