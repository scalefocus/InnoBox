// Live-DB integration test (gated) for the §10.3 platform-admin permanent delete. This is the
// one hard-delete path in the app, so the things worth proving are all SQL-level: the RBAC gate
// answers 404 (never 403), the cascade leaves ZERO orphans across every child table, the
// implemented-solution delete un-solves its challenge while leaving not_selected siblings
// closed, already-sent outbox rows survive while pending ones go, pre-existing audit rows are
// untouched, and the audit payload carries metadata + reason but no content. MinIO is not
// reachable from the host, so an in-memory fake StorageClient records the purge.
// Self-skips when DATABASE_URL is unset. Mirrors challenges/store.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

function makeFakeStorage() {
  const deletedObjects: string[] = [];
  const abortedUploads: { key: string; uploadId: string }[] = [];
  const storage = {
    putObject: async () => {},
    getObject: async () => new Uint8Array(),
    getObjectStream: async () => ({ body: new Blob([]).stream(), contentLength: 0 }),
    deleteObject: async (key: string) => {
      deletedObjects.push(key);
    },
    createMultipartUpload: async () => "mpu-1",
    uploadPart: async () => {},
    listParts: async () => [],
    completeMultipartUpload: async () => {},
    abortMultipartUpload: async (key: string, uploadId: string) => {
      abortedUploads.push({ key, uploadId });
    },
  };
  return { storage, deletedObjects, abortedUploads };
}

test(
  "§10.3 admin delete: 404 for non-platform-admins, full cascade with no orphans, implemented-solution un-solve, audit without content",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet, validateDeleteReason } = await import("@innobox/shared");
    const { createChallenge, createSolution, listActiveImpactAreas, setChallengeStatus, setSolutionStatus, toggleLike } = await import("./store");
    const { deleteChallenge, deleteSolution } = await import("./delete");

    const pool = new Pool({ connectionString: url });
    const { storage, deletedObjects, abortedUploads } = makeFakeStorage();
    const deps = { pool, storage };
    try {
      const stamp = randomUUID().slice(0, 8);

      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Delete NS') returning id`,
        [`dbtest-del-${stamp}`],
      );
      const nsId = nsRows[0]!.id;

      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-del-${label}-${stamp}`, `dbtest-del-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const authorId = await mkUser("author");
      const nsAdminId = await mkUser("nsadmin");
      const platformAdminId = await mkUser("platformadmin");
      const rivalId = await mkUser("rival");

      const author = { userId: authorId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const rival = { userId: rivalId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const nsAdmin = { userId: nsAdminId, roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const platformAdmin = { userId: platformAdminId, roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }) };
      assert.equal(platformAdmin.roles.isPlatformAdmin, true, "the platform-admin fixture must actually be one");
      assert.equal(nsAdmin.roles.isPlatformAdmin, false, "the namespace-admin fixture must NOT be a platform admin");

      const impactAreas = await listActiveImpactAreas(pool);
      const internal = impactAreas.find((a) => a.name === "Internal")!;

      // ── Fixture: a solved challenge with an implemented winner and a not_selected sibling ──
      const created = await createChallenge(pool, author, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: "Delete me",
        description: "Body",
        clientName: null,
        visibility: "org",
        isAnonymous: false,
      });
      assert.equal(created.status, "ok");
      if (created.status !== "ok") return;
      const challengeId = created.challenge.id;
      const chNum = created.challenge.number.replace("CH-", "");
      await setChallengeStatus(pool, platformAdmin, chNum, "valid");

      const winner = await createSolution(pool, author, chNum, { description: "The winner", costVsBenefits: null, isAnonymous: false });
      const loser = await createSolution(pool, rival, chNum, { description: "The other one", costVsBenefits: null, isAnonymous: false });
      assert.equal(winner.status, "ok");
      assert.equal(loser.status, "ok");
      if (winner.status !== "ok" || loser.status !== "ok") return;
      const winnerId = winner.solution.id;
      const loserId = loser.solution.id;
      const winnerNum = winner.solution.number.replace("SOL-", "");

      // Children on both the challenge and its solutions.
      // (The winner's like waits until it leaves `proposed` below — a proposed solution is
      // invisible to the rival, so liking it now would be refused as not_found.)
      assert.equal((await toggleLike(pool, rival, "challenge", challengeId)).status, "ok");
      for (const [parentType, parentId] of [
        ["challenge", challengeId],
        ["solution", winnerId],
        ["solution", loserId],
      ] as const) {
        await pool.query(`insert into comments (parent_type, parent_id, author_id, body) values ($1, $2, $3, 'a comment')`, [
          parentType,
          parentId,
          rivalId,
        ]);
        await pool.query(`insert into follows (user_id, parent_type, parent_id) values ($1, $2, $3) on conflict do nothing`, [
          rivalId,
          parentType,
          parentId,
        ]);
        await pool.query(
          `insert into attachments (parent_type, parent_id, filename, size_bytes, mime, object_key, scan_status, uploaded_by)
           values ($1, $2, 'f.txt', 4, 'text/plain', $3, 'clean', $4)`,
          [parentType, parentId, `dbtest-del-${stamp}-${parentType}-${parentId}`, authorId],
        );
      }
      // One bound chunked-upload session on the winner (must be aborted + dropped).
      const sessionKey = `dbtest-del-${stamp}-session`;
      await pool.query(
        `insert into attachment_uploads (attachment_id, parent_type, parent_id, filename, mime, declared_size_bytes, object_key, s3_upload_id, chunk_size_bytes, uploaded_by)
         values ($1, 'solution', $2, 'big.bin', 'application/zip', 99, $3, 'mpu-dbtest', 8, $4)`,
        [randomUUID(), winnerId, sessionKey, authorId],
      );

      // Notifications: one on the challenge, one on the winner, one on an UNRELATED challenge
      // whose number shares a prefix (CH-<chNum>0) — the '#'-anchored prefix must not eat it.
      const mkNotification = async (link: string, status: "pending" | "sent") => {
        await pool.query(`insert into notifications (user_id, type, payload) values ($1, 'status_changed', $2)`, [
          rivalId,
          JSON.stringify({ message: "m", link }),
        ]);
        await pool.query(`insert into notification_outbox (user_id, type, payload, status) values ($1, 'status_changed', $2, $3)`, [
          rivalId,
          JSON.stringify({ message: "m", link }),
          status,
        ]);
      };
      await mkNotification(`/challenges/${chNum}`, "pending");
      await mkNotification(`/challenges/${chNum}#SOL-${winnerNum}`, "pending");
      await mkNotification(`/challenges/${chNum}#SOL-${winnerNum}`, "sent");
      await mkNotification(`/challenges/${chNum}0`, "pending"); // a different challenge entirely

      // Drive the §8.3 auto-close: winner → implemented solves the challenge, sibling closes.
      for (const st of ["in_review", "valid", "accepted_internally", "waiting_for_resources", "in_implementation", "implemented"]) {
        // Like the winner on its last open step: once it is implemented the challenge is solved
        // and likes are frozen (§8.3).
        if (st === "implemented") {
          assert.equal((await toggleLike(pool, rival, "solution", winnerId)).status, "ok", "the advancing winner is visible to the rival");
        }
        const r = await setSolutionStatus(pool, platformAdmin, winnerNum, st);
        assert.equal(r.status, "ok", `winner → ${st}`);
      }
      const solvedRow = await pool.query<{ status: string; resolved_at: Date | null }>(`select status, resolved_at from challenges where id = $1`, [
        challengeId,
      ]);
      assert.equal(solvedRow.rows[0]!.status, "solved");
      assert.ok(solvedRow.rows[0]!.resolved_at, "the auto-close stamps resolved_at");
      const loserStatus = await pool.query<{ status: string }>(`select status from solutions where id = $1`, [loserId]);
      assert.equal(loserStatus.rows[0]!.status, "not_selected");

      const auditRowsBefore = await countAudit(pool, challengeId);

      // ── 1. A namespace admin is NOT a platform admin: 404, and nothing is touched ────────
      assert.equal((await deleteSolution(deps, nsAdmin, winnerNum, "trying it on")).status, "not_found");
      assert.equal((await deleteChallenge(deps, nsAdmin, chNum, "trying it on")).status, "not_found");
      assert.equal((await deleteChallenge(deps, author, chNum, "trying it on")).status, "not_found");
      assert.equal(await rowExists(pool, `select 1 from challenges where id = $1`, challengeId), true, "a refused delete changes nothing");
      assert.equal(await rowExists(pool, `select 1 from solutions where id = $1`, winnerId), true);

      // An unknown number is the same 404, even for a platform admin.
      assert.equal((await deleteSolution(deps, platformAdmin, "99999999", "nope")).status, "not_found");
      assert.equal((await deleteChallenge(deps, platformAdmin, "99999999", "nope")).status, "not_found");

      // ── 2. Delete the implemented solution ──────────────────────────────────────────────
      // The route trims the reason (validateDeleteReason) before the store sees it; mirror that
      // here so the audit assertion below exercises the same input path.
      const reason = validateDeleteReason("  contained a client contract  ");
      assert.ok(reason.ok);
      if (!reason.ok) return;
      const delSol = await deleteSolution(deps, platformAdmin, winnerNum, reason.value);
      assert.equal(delSol.status, "ok");
      if (delSol.status !== "ok") return;
      assert.equal(delSol.challengeRevertedToValid, true);
      assert.equal(delSol.counts.solutions, 0, "a solution delete removes no solutions of its own");
      assert.equal(delSol.counts.comments, 1);
      assert.equal(delSol.counts.likes, 1);
      assert.equal(delSol.counts.follows, 1);
      assert.equal(delSol.counts.attachments, 1);
      assert.equal(delSol.counts.uploadSessions, 1);
      assert.equal(delSol.counts.notifications, 2, "both inbox rows for this solution's link go");
      assert.equal(delSol.counts.outbox, 1, "only the PENDING outbox row goes — sent mail is history");

      assert.equal(await rowExists(pool, `select 1 from solutions where id = $1`, winnerId), false, "the solution row is gone");
      assert.equal(await childCount(pool, "comments", "solution", winnerId), 0);
      assert.equal(await childCount(pool, "likes", "solution", winnerId), 0);
      assert.equal(await childCount(pool, "follows", "solution", winnerId), 0);
      assert.equal(await childCount(pool, "attachments", "solution", winnerId), 0);
      assert.equal(await childCount(pool, "attachment_uploads", "solution", winnerId), 0);
      assert.ok(
        abortedUploads.some((a) => a.key === sessionKey && a.uploadId === "mpu-dbtest"),
        "the bound chunked-upload session is aborted in the object store",
      );
      assert.ok(deletedObjects.length >= 1, "the solution's attachment object is purged");

      // The parent is un-solved; the not_selected sibling stays closed (§8.3 is not replayed).
      const revert = await pool.query<{ status: string; resolved_at: Date | null }>(`select status, resolved_at from challenges where id = $1`, [
        challengeId,
      ]);
      assert.equal(revert.rows[0]!.status, "valid");
      assert.equal(revert.rows[0]!.resolved_at, null, "resolved_at is cleared on the un-solve");
      const loserAfter = await pool.query<{ status: string }>(`select status from solutions where id = $1`, [loserId]);
      assert.equal(loserAfter.rows[0]!.status, "not_selected", "siblings closed by the auto-close stay closed");

      // The un-solve is audited as an override transition triggered by the delete.
      const revertAudit = await pool.query<{ before: { status: string }; after: { status: string; override: boolean; trigger: string } }>(
        `select before, after from audit_log where action = 'challenge.status_changed' and target_id = $1 order by id desc limit 1`,
        [challengeId],
      );
      assert.equal(revertAudit.rows[0]!.before.status, "solved");
      assert.equal(revertAudit.rows[0]!.after.status, "valid");
      assert.equal(revertAudit.rows[0]!.after.override, true);
      assert.equal(revertAudit.rows[0]!.after.trigger, "solution_deleted");

      // The delete's own audit row: metadata + trimmed reason + cascade counts, NO content.
      const solAudit = await pool.query<{ actor_user_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
        `select actor_user_id, before, after from audit_log where action = 'solution.deleted' and target_id = $1`,
        [winnerId],
      );
      assert.equal(solAudit.rows.length, 1);
      assert.equal(solAudit.rows[0]!.actor_user_id, platformAdminId);
      assert.equal(solAudit.rows[0]!.before.number, `SOL-${winnerNum}`);
      assert.equal(solAudit.rows[0]!.before.status, "implemented");
      assert.equal(solAudit.rows[0]!.before.authorId, authorId);
      assert.equal(solAudit.rows[0]!.after.reason, "contained a client contract");
      assertNoContent(solAudit.rows[0]!.before, solAudit.rows[0]!.after);

      // Only this solution's notifications went: the challenge's own row and the CH-<n>0 row live.
      assert.equal(await linkCount(pool, "notifications", `/challenges/${chNum}`), 1, "the challenge's own inbox row survives a solution delete");
      assert.equal(await linkCount(pool, "notifications", `/challenges/${chNum}0`), 1, "a prefix-sharing challenge is never touched");
      assert.equal(await linkCount(pool, "notification_outbox", `/challenges/${chNum}#SOL-${winnerNum}`), 1, "the sent outbox row survives");

      // ── 3. Delete the whole challenge ───────────────────────────────────────────────────
      const delCh = await deleteChallenge(deps, platformAdmin, chNum, "spam");
      assert.equal(delCh.status, "ok");
      if (delCh.status !== "ok") return;
      assert.equal(delCh.counts.solutions, 1, "the surviving sibling is cascaded away");
      assert.equal(delCh.counts.comments, 2, "the challenge's comment and the sibling's");
      assert.equal(delCh.counts.likes, 1);
      assert.equal(delCh.counts.follows, 2);
      assert.equal(delCh.counts.attachments, 2);
      assert.equal(delCh.counts.notifications, 1);

      assert.equal(await rowExists(pool, `select 1 from challenges where id = $1`, challengeId), false);
      assert.equal(await rowExists(pool, `select 1 from solutions where id = $1`, loserId), false);
      for (const [table, parentType, parentId] of [
        ["comments", "challenge", challengeId],
        ["comments", "solution", loserId],
        ["likes", "challenge", challengeId],
        ["follows", "challenge", challengeId],
        ["follows", "solution", loserId],
        ["attachments", "challenge", challengeId],
        ["attachments", "solution", loserId],
      ] as const) {
        assert.equal(await childCount(pool, table, parentType, parentId), 0, `${table} orphans left for ${parentType}`);
      }
      assert.equal(await linkCount(pool, "notifications", `/challenges/${chNum}`), 0);
      assert.equal(await linkCount(pool, "notifications", `/challenges/${chNum}0`), 1, "the prefix-sharing challenge is STILL untouched");

      const chAudit = await pool.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `select before, after from audit_log where action = 'challenge.deleted' and target_id = $1`,
        [challengeId],
      );
      assert.equal(chAudit.rows.length, 1);
      assert.equal(chAudit.rows[0]!.before.number, `CH-${chNum}`);
      assert.equal(chAudit.rows[0]!.before.status, "valid");
      assert.equal(chAudit.rows[0]!.after.reason, "spam");
      assertNoContent(chAudit.rows[0]!.before, chAudit.rows[0]!.after);

      // Invariant 5: the audit history of a deleted item survives it, and only grows.
      const auditRowsAfter = await countAudit(pool, challengeId);
      assert.ok(auditRowsAfter > auditRowsBefore, "audit rows written before the delete are still there, plus the new ones");
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

/** The §10.3 audit payload must carry metadata only — never the content the delete destroyed. */
function assertNoContent(before: Record<string, unknown>, after: Record<string, unknown>): void {
  const serialized = JSON.stringify({ before, after });
  for (const forbidden of ["title", "description", "clientName", "client_name", "filename", "body"]) {
    assert.ok(!serialized.includes(forbidden), `the delete audit payload must not carry "${forbidden}"`);
  }
}

async function rowExists(pool: import("pg").Pool, sql: string, id: string): Promise<boolean> {
  const { rows } = await pool.query(sql, [id]);
  return rows.length > 0;
}

async function childCount(pool: import("pg").Pool, table: string, parentType: string, parentId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*) as n from ${table} where parent_type = $1 and parent_id = $2`, [
    parentType,
    parentId,
  ]);
  return Number(rows[0]!.n);
}

async function linkCount(pool: import("pg").Pool, table: string, link: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*) as n from ${table} where payload->>'link' = $1`, [link]);
  return Number(rows[0]!.n);
}

async function countAudit(pool: import("pg").Pool, targetId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`select count(*) as n from audit_log where target_id = $1`, [targetId]);
  return Number(rows[0]!.n);
}
