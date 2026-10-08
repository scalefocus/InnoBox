// Live-DB integration test (gated) for the §11 attachment data layer. Exercises the real SQL
// for author-only + edit-window gating, the §14.3 limits (incl. the per-item cap under
// concurrent uploads), the allowlist + content check, the anonymity-safe list projection (never
// emits uploaded_by), author removal (soft + object purge + idempotent guard), the download
// gateway (clean+visible → a byte stream; every other case → identical denial + audit), the
// chunked-upload size binding (part range/size, assembly verification → size_mismatch abort),
// and the scan-retry path to the terminal `unscannable` state. MinIO/ClamAV are NOT reachable from the host, so an in-memory fake StorageClient is
// injected. Self-skips when DATABASE_URL is unset. Mirrors challenges/store.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

/** The on-demand scan fired by every upload uses this stand-in for clamd: unreachable, so the
 *  shared verdict handler leaves rows untouched (an outage never counts) and each test decides
 *  verdicts itself — even on a machine where CLAMAV_HOST happens to point at a live clamd. */
async function scannerOffline(): Promise<never> {
  throw Object.assign(new Error("clamd unreachable (test)"), { code: "ECONNREFUSED" });
}

function makeFakeStorage() {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  // In-memory MinIO multipart: an open upload accumulates parts, then completeMultipartUpload
  // concatenates them (by ascending part number) into the object, exactly like S3.
  const multipart = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  let mpuSeq = 0;
  const storage = {
    putObject: async (key: string, body: Uint8Array) => {
      objects.set(key, body);
    },
    getObject: async (key: string) => {
      const b = objects.get(key);
      if (!b) throw new Error(`no such object: ${key}`);
      return b;
    },
    getObjectStream: async (key: string) => {
      const b = objects.get(key);
      if (!b) throw new Error(`no such object: ${key}`);
      // Two pulls, so the consumer genuinely reads a stream rather than one buffer.
      const mid = Math.floor(b.length / 2);
      const pieces = [b.subarray(0, mid), b.subarray(mid)];
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = pieces.shift();
          if (next) controller.enqueue(next);
          else controller.close();
        },
      });
      return { body, contentLength: b.length };
    },
    deleteObject: async (key: string) => {
      objects.delete(key);
      deleted.push(key);
    },
    createMultipartUpload: async (key: string) => {
      const uploadId = `mpu-${(mpuSeq += 1)}`;
      multipart.set(uploadId, { key, parts: new Map() });
      return uploadId;
    },
    uploadPart: async (_key: string, uploadId: string, partNumber: number, body: Uint8Array) => {
      const s = multipart.get(uploadId);
      if (!s) throw new Error(`no such multipart upload: ${uploadId}`);
      s.parts.set(partNumber, body);
    },
    listParts: async (_key: string, uploadId: string) => {
      const s = multipart.get(uploadId);
      if (!s) throw new Error(`no such multipart upload: ${uploadId}`);
      return [...s.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([partNumber, body]) => ({ partNumber, size: body.length, etag: `etag-${partNumber}-${body.length}` }));
    },
    completeMultipartUpload: async (key: string, uploadId: string, parts: readonly { partNumber: number; etag: string }[]) => {
      const s = multipart.get(uploadId);
      if (!s) throw new Error(`no such multipart upload: ${uploadId}`);
      // Like S3: assemble exactly the listed parts, and refuse one whose ETag no longer matches.
      for (const p of parts) {
        const body = s.parts.get(p.partNumber);
        if (!body || p.etag !== `etag-${p.partNumber}-${body.length}`) throw new Error(`InvalidPart ${p.partNumber}`);
      }
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => s.parts.get(p.partNumber)!);
      const total = ordered.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of ordered) {
        out.set(c, off);
        off += c.length;
      }
      objects.set(key, out);
      multipart.delete(uploadId);
    },
    abortMultipartUpload: async (_key: string, uploadId: string) => {
      multipart.delete(uploadId);
    },
  };
  return { storage, objects, deleted, multipart };
}

test(
  "attachments: author-only upload, edit-window, limits (409/413/415), pending+audit, list visibility, anonymity, removal, download gateway, §11 staging + binding",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, listActiveImpactAreas, setChallengeStatus } = await import("../challenges/store");
    const { getAttachmentLimits } = await import("../admin/settings/store");
    const { getAttachmentForDownload, listAttachmentsForParent, listStagedAttachments, removeAttachment, stageAttachment, uploadAttachment } =
      await import("./store");

    const pool = new Pool({ connectionString: url });
    const bytes = new TextEncoder().encode("hello attachment payload");
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Att NS') returning id`,
        [`dbtest-att-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-att-${label}-${stamp}`, `dbtest-att-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });

      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const admin = { userId: await mkUser("admin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const member = { userId: await mkUser("member"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const outsider = { userId: await mkUser("outsider"), roles: roles([]) };

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

      const { storage, objects, deleted } = makeFakeStorage();
      const deps = { pool, storage, scan: scannerOffline };
      const limits = await getAttachmentLimits(pool);

      const ch = await mkChallenge("Attachment subject"); // starts awaiting_triage (author-edit window)
      const goodFile = { parentType: "challenge" as const, parentId: ch.id, filename: "notes.txt", mime: "text/plain", size: bytes.byteLength, bytes };

      // ── Author-only + edit-window + type + size gates ──────────────────────────────────
      assert.equal((await uploadAttachment(deps, member, goodFile)).status, "forbidden", "non-author cannot upload");
      assert.equal(
        (await uploadAttachment(deps, author, { ...goodFile, filename: "run.exe", mime: "application/octet-stream" })).status,
        "unsupported_type",
      );
      assert.equal(
        (await uploadAttachment(deps, author, { ...goodFile, size: limits.maxUploadSizeMb * 1024 * 1024 + 1 })).status,
        "too_large",
      );
      // Content check (415): an allowlisted name + MIME whose bytes are something else.
      assert.equal(
        (await uploadAttachment(deps, author, { ...goodFile, filename: "report.pdf", mime: "application/pdf" })).status,
        "content_mismatch",
        "text bytes named .pdf are refused",
      );
      assert.equal(objects.size, 0, "a refused upload writes nothing to storage");

      // ── Happy path upload → pending, audited, object written ───────────────────────────
      const up1 = await uploadAttachment(deps, author, goodFile);
      assert.equal(up1.status, "ok");
      if (up1.status !== "ok") return;
      const att1 = up1.attachment;
      assert.equal(att1.status, "pending");
      assert.equal(att1.isUploader, true);
      assert.equal("uploadedBy" in (att1 as object), false, "the client view must never carry uploaded_by");
      assert.equal(objects.size, 1, "bytes are written to storage on upload");
      await assertAudited(pool, "attachment.uploaded", att1.id);

      // ── List visibility + anonymity: pending shown only to the uploader ────────────────
      const authorList = await listAttachmentsForParent(pool, author, "challenge", ch.id);
      assert.equal(authorList.length, 1);
      assert.equal(authorList[0]!.id, att1.id);
      assert.equal("uploadedBy" in (authorList[0] as object), false, "list projection must omit uploaded_by (invariant 3)");
      const memberListPending = await listAttachmentsForParent(pool, member, "challenge", ch.id);
      assert.equal(memberListPending.length, 0, "a pending attachment is hidden from non-uploaders");

      // ── Download gateway: pending → denied + audited ───────────────────────────────────
      assert.equal((await getAttachmentForDownload(deps, author, att1.id)).status, "denied", "pending is never served");
      await assertAudited(pool, "attachment.download_denied", att1.id);

      // ── Author removal (soft + object purge + idempotent) on a second attachment ───────
      const up2 = await uploadAttachment(deps, author, { ...goodFile, filename: "second.txt" });
      assert.equal(up2.status, "ok");
      if (up2.status !== "ok") return;
      const att2 = up2.attachment;
      const { rows: keyRows } = await pool.query<{ object_key: string }>(`select object_key from attachments where id = $1`, [att2.id]);
      const att2Key = keyRows[0]!.object_key;

      // §2.4: the member can't see this pending attachment (nor its awaiting_triage parent), so a
      // removal attempt is the same 404 as a nonexistent id — never a 403 existence oracle.
      assert.equal((await removeAttachment(deps, member, att2.id)).status, "not_found", "a non-uploader who can't see it gets not_found");
      assert.equal((await removeAttachment(deps, author, att2.id)).status, "ok");
      await assertAudited(pool, "attachment.removed", att2.id);
      assert.ok(deleted.includes(att2Key), "the object is purged from storage on removal");
      const { rows: rem } = await pool.query<{ removed_at: Date | null }>(`select removed_at from attachments where id = $1`, [att2.id]);
      assert.ok(rem[0]!.removed_at, "removed_at is stamped (soft-remove, row retained)");
      assert.equal((await removeAttachment(deps, author, att2.id)).status, "already_removed", "idempotent guard");
      // Removed rows are hidden from everyone, including the uploader.
      const afterRemove = await listAttachmentsForParent(pool, author, "challenge", ch.id);
      assert.equal(afterRemove.some((a) => a.id === att2.id), false, "removed attachment is never listed");
      assert.equal(afterRemove.some((a) => a.id === att1.id), true, "the other attachment survives");
      assert.equal((await getAttachmentForDownload(deps, author, att2.id)).status, "denied", "removed is never served");

      // ── Mark att1 clean (simulating the worker verdict), then exercise the gateway ─────
      await pool.query(`update attachments set scan_status = 'clean', scanned_at = now() where id = $1`, [att1.id]);
      const cleanDownload = await getAttachmentForDownload(deps, author, att1.id);
      assert.equal(cleanDownload.status, "ok");
      if (cleanDownload.status !== "ok") return;
      assert.deepEqual(
        new Uint8Array(await new Response(cleanDownload.body).arrayBuffer()),
        bytes,
        "the gateway streams the stored bytes for a clean, visible attachment",
      );
      assert.equal(cleanDownload.sizeBytes, bytes.byteLength);
      assert.equal(cleanDownload.filename, "notes.txt");
      // The challenge is still awaiting_triage & namespace-only → outsider can't see the parent.
      assert.equal((await getAttachmentForDownload(deps, outsider, att1.id)).status, "denied", "not-visible parent → denied");

      // Once valid, a mere namespace member can see the parent and its clean attachment.
      assert.equal((await setChallengeStatus(pool, admin, ch.number, "valid")).status, "ok");
      const memberListClean = await listAttachmentsForParent(pool, member, "challenge", ch.id);
      assert.equal(memberListClean.length, 1, "a clean attachment is visible to any parent-viewer");
      assert.equal(memberListClean[0]!.isUploader, false);
      assert.equal((await getAttachmentForDownload(deps, member, att1.id)).status, "ok", "member can download the clean attachment");

      // Out of the edit window now (valid) → no more uploads/removes.
      assert.equal((await uploadAttachment(deps, author, goodFile)).status, "not_editable");
      assert.equal((await removeAttachment(deps, author, att1.id)).status, "not_editable");

      // ── Per-item cap (409 too_many); removed rows don't count ──────────────────────────
      const cap = await mkChallenge("Cap subject"); // fresh, awaiting_triage
      const capFile = { parentType: "challenge" as const, parentId: cap.id, filename: "c.txt", mime: "text/plain", size: bytes.byteLength, bytes };
      const capIds: string[] = [];
      for (let i = 0; i < limits.maxPerItem; i++) {
        const r = await uploadAttachment(deps, author, capFile);
        assert.equal(r.status, "ok", `upload ${i + 1} within the cap`);
        if (r.status === "ok") capIds.push(r.attachment.id);
      }
      assert.equal((await uploadAttachment(deps, author, capFile)).status, "too_many", "one over the cap is refused");
      // Freeing a slot via removal lets a new upload through (removed rows are not counted).
      assert.equal((await removeAttachment(deps, author, capIds[0]!)).status, "ok");
      assert.equal((await uploadAttachment(deps, author, capFile)).status, "ok", "a removed row frees a cap slot");

      // The cap holds under concurrency: uploads racing for the free slots cannot overshoot it,
      // and every loser's object is purged (§11).
      const race = await mkChallenge("Cap race subject");
      const raceFile = { ...capFile, parentId: race.id };
      const objectsBefore = objects.size;
      const raced = await Promise.all(Array.from({ length: limits.maxPerItem + 3 }, () => uploadAttachment(deps, author, raceFile)));
      assert.equal(raced.filter((r) => r.status === "ok").length, limits.maxPerItem, "exactly the cap wins the race");
      assert.equal(raced.filter((r) => r.status === "too_many").length, 3);
      const { rows: raceCount } = await pool.query<{ n: string }>(
        `select count(*)::text as n from attachments where parent_id = $1 and removed_at is null`,
        [race.id],
      );
      assert.equal(Number(raceCount[0]!.n), limits.maxPerItem, "the table never exceeds the cap");
      assert.equal(objects.size - objectsBefore, limits.maxPerItem, "losing uploads leave no orphaned objects");

      // ── Infected rows are also never served ────────────────────────────────────────────
      await pool.query(`update attachments set scan_status = 'infected', scanned_at = now() where id = $1`, [capIds[1]!]);
      assert.equal((await getAttachmentForDownload(deps, author, capIds[1]!)).status, "denied", "infected is never served");

      // ── §11 staging: submission-time uploads under a client-generated draftKey ──────────
      const draftKey = randomUUID();
      const stageInput = { parentType: "challenge" as const, draftKey, filename: "draft.txt", mime: "text/plain", size: bytes.byteLength, bytes };

      // Any authenticated user may stage — even an outsider (member of nothing); anyone may raise
      // a challenge. Allowlist (415) + size (413) gates still apply.
      assert.equal((await stageAttachment(deps, outsider, { ...stageInput, filename: "x.exe", mime: "application/octet-stream" })).status, "unsupported_type");
      assert.equal((await stageAttachment(deps, outsider, { ...stageInput, size: limits.maxUploadSizeMb * 1024 * 1024 + 1 })).status, "too_large");
      const st1 = await stageAttachment(deps, outsider, stageInput);
      assert.equal(st1.status, "ok");
      if (st1.status !== "ok") return;
      assert.equal(st1.attachment.status, "pending");
      assert.equal("uploadedBy" in (st1.attachment as object), false, "staged view must omit uploaded_by (invariant 3)");
      await assertAudited(pool, "attachment.uploaded", st1.attachment.id);

      // Listing is scoped to the uploader: another user with the SAME draftKey sees nothing.
      assert.equal((await listStagedAttachments(pool, outsider, draftKey)).length, 1);
      assert.equal((await listStagedAttachments(pool, member, draftKey)).length, 0, "staged files are private to their uploader");

      // A staged (unbound) row is NEVER downloadable, even if (hypothetically) marked clean.
      await pool.query(`update attachments set scan_status = 'clean', scanned_at = now() where id = $1`, [st1.attachment.id]);
      assert.equal((await getAttachmentForDownload(deps, outsider, st1.attachment.id)).status, "denied", "unbound staged rows are never served");

      // Staged removal by the uploader with NO edit-window (there is no parent yet).
      const st2 = await stageAttachment(deps, outsider, { ...stageInput, filename: "draft2.txt" });
      assert.equal(st2.status, "ok");
      if (st2.status !== "ok") return;
      assert.equal((await removeAttachment(deps, member, st2.attachment.id)).status, "not_found", "a staged row is invisible to everyone but its uploader");
      assert.equal((await removeAttachment(deps, outsider, st2.attachment.id)).status, "ok");
      assert.equal((await listStagedAttachments(pool, outsider, draftKey)).some((a) => a.id === st2.attachment.id), false);

      // The per-item cap applies to staging too (removed rows don't count).
      const capKey = randomUUID();
      const capStage = { parentType: "challenge" as const, draftKey: capKey, filename: "cap.txt", mime: "text/plain", size: bytes.byteLength, bytes };
      for (let i = 0; i < limits.maxPerItem; i++) assert.equal((await stageAttachment(deps, author, capStage)).status, "ok");
      assert.equal((await stageAttachment(deps, author, capStage)).status, "too_many", "staging honors the per-item cap");
      // …atomically, too.
      const raceKey = randomUUID();
      const stageRace = await Promise.all(
        Array.from({ length: limits.maxPerItem + 2 }, () => stageAttachment(deps, author, { ...capStage, draftKey: raceKey })),
      );
      assert.equal(stageRace.filter((r) => r.status === "ok").length, limits.maxPerItem, "concurrent staging cannot overshoot the cap");

      // ── Binding at submit: createChallenge(draftKey) re-parents the caller's staged rows ─
      const bindKey = randomUUID();
      const bindStage = { parentType: "challenge" as const, draftKey: bindKey, filename: "bind.txt", mime: "text/plain", size: bytes.byteLength, bytes };
      const b1 = await stageAttachment(deps, author, bindStage);
      const b2 = await stageAttachment(deps, author, { ...bindStage, filename: "bind2.txt" });
      assert.equal(b1.status, "ok");
      assert.equal(b2.status, "ok");
      if (b1.status !== "ok" || b2.status !== "ok") return;
      const bound = await createChallenge(pool, author, {
        impactAreaId: internal.id, namespaceId: nsId, title: "Bind subject", description: "d",
        clientName: null, visibility: "namespace", isAnonymous: false, draftKey: bindKey,
      });
      assert.equal(bound.status, "ok");
      if (bound.status !== "ok") return;
      assert.equal((await listAttachmentsForParent(pool, author, "challenge", bound.challenge.id)).length, 2, "both staged files bind to the new challenge");
      await assertAudited(pool, "attachment.bound", b1.attachment.id);
      assert.equal((await listStagedAttachments(pool, author, bindKey)).length, 0, "no rows remain staged under the bound draftKey");
      // The bound rows carry over their pending scan status (submission never blocks on the scan).
      assert.equal((await listAttachmentsForParent(pool, author, "challenge", bound.challenge.id)).every((a) => a.status === "pending"), true);

      // A foreign draftKey binds nothing: `member` stages, then `author` submits with member's key.
      const foreignKey = randomUUID();
      const mStage = await stageAttachment(deps, member, { parentType: "challenge", draftKey: foreignKey, filename: "foreign.txt", mime: "text/plain", size: bytes.byteLength, bytes });
      assert.equal(mStage.status, "ok");
      const foreignBound = await createChallenge(pool, author, {
        impactAreaId: internal.id, namespaceId: nsId, title: "Foreign bind", description: "d",
        clientName: null, visibility: "namespace", isAnonymous: false, draftKey: foreignKey,
      });
      assert.equal(foreignBound.status, "ok");
      if (foreignBound.status !== "ok") return;
      assert.equal((await listAttachmentsForParent(pool, author, "challenge", foreignBound.challenge.id)).length, 0, "another user's staged files are never bound");
      assert.equal((await listStagedAttachments(pool, member, foreignKey)).length, 1, "the foreign staged file is left untouched for its owner");
    } finally {
      await pool.end();
    }
  },
);

test(
  "attachments (chunked, §11): initiate validation, parts → complete assembles the object + pending row + audit + session cleanup, abort, and the submit scan gate",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet } = await import("@innobox/shared");
    const { createChallenge, listActiveImpactAreas } = await import("../challenges/store");
    const {
      abortChunkedUpload,
      completeChunkedUpload,
      getAttachmentForDownload,
      hasUncleanStagedAttachments,
      initiateChunkedUpload,
      listAttachmentsForParent,
      stageAttachment,
      uploadChunkPart,
    } = await import("./store");
    const { scanAttachmentNow } = await import("./scan");
    const { ClamdErrorReply, SCAN_MAX_ATTEMPTS } = await import("@innobox/shared");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Chunk NS') returning id`,
        [`dbtest-chunk-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-chunk-${label}-${stamp}`, `dbtest-chunk-${label}-${stamp}@example.test`, `Dbtest ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "platform_admin" | "namespace_admin" | "committee" | "member"; namespaceId: string | null }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });
      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const other = { userId: await mkUser("other"), roles: roles([{ role: "member", namespaceId: nsId }]) };

      const internal = (await listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const c = await createChallenge(pool, author, {
        impactAreaId: internal.id, namespaceId: nsId, title: "Chunk subject", description: "d",
        clientName: null, visibility: "namespace", isAnonymous: false,
      });
      assert.equal(c.status, "ok");
      if (c.status !== "ok") return;
      const parentId = c.challenge.id;

      const { storage, objects, multipart } = makeFakeStorage();
      const deps = { pool, storage, scan: scannerOffline };
      const enc = new TextEncoder();
      const part1 = enc.encode("A".repeat(64));
      const part2 = enc.encode("B".repeat(48));
      const total = part1.length + part2.length;
      // The configured chunk size has a 5 MB floor; shrink a session's negotiated size to 64 bytes
      // so the size-binding rules can be exercised with tiny parts.
      const useTinyChunks = async (uploadId: string) =>
        pool.query(`update attachment_uploads set chunk_size_bytes = $2 where id = $1`, [uploadId, part1.length]);

      // ── Initiate validation (fail-fast) ────────────────────────────────────────────────
      assert.equal(
        (await initiateChunkedUpload(deps, author, { parentType: "challenge", parentId, filename: "x.exe", mime: "application/octet-stream", size: total })).status,
        "unsupported_type",
      );
      assert.equal(
        (await initiateChunkedUpload(deps, author, { parentType: "challenge", parentId, filename: "big.txt", mime: "text/plain", size: 9_999_999_999 })).status,
        "too_large",
      );
      assert.equal(
        (await initiateChunkedUpload(deps, other, { parentType: "challenge", parentId, filename: "big.txt", mime: "text/plain", size: total })).status,
        "forbidden",
        "only the author may attach to a bound parent",
      );

      // ── Happy path: initiate → 2 parts → complete assembles the object ─────────────────
      const init = await initiateChunkedUpload(deps, author, { parentType: "challenge", parentId, filename: "big.txt", mime: "text/plain", size: total });
      assert.equal(init.status, "ok");
      if (init.status !== "ok") return;
      await useTinyChunks(init.uploadId);
      // A session row exists while the upload is in flight.
      const { rows: sess } = await pool.query<{ n: string }>(`select count(*)::text as n from attachment_uploads where id = $1`, [init.uploadId]);
      assert.equal(sess[0]!.n, "1");

      // Only the owner may send parts.
      assert.equal((await uploadChunkPart(deps, other, init.uploadId, 1, part1)).status, "not_found");
      // The declared size is binding (400, nothing relayed): an over-size chunk, a short non-final
      // part, a final part that isn't exactly the remainder, a part number outside 1…N.
      const relayedBefore = multipart.get([...multipart.keys()].at(-1)!)!.parts.size;
      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 1, enc.encode("z".repeat(part1.length + 1)))).status, "bad_request");
      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 1, enc.encode("z".repeat(part1.length - 1)))).status, "bad_request", "short non-final part");
      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 2, enc.encode("z".repeat(part2.length + 1)))).status, "bad_request", "over-long final part");
      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 3, part2)).status, "bad_request", "part number beyond N");
      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 0, part2)).status, "bad_request", "part number below 1");
      assert.equal(multipart.get([...multipart.keys()].at(-1)!)!.parts.size, relayedBefore, "rejected parts never reach the store");
      // Content check on part 1 (415): the first bytes of a ".txt" contain a NUL.
      const binary = new Uint8Array(part1.length).fill(0x41);
      binary[3] = 0;
      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 1, binary)).status, "content_mismatch");

      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 1, part1)).status, "ok");
      assert.equal((await uploadChunkPart(deps, author, init.uploadId, 2, part2)).status, "ok");

      const done = await completeChunkedUpload(deps, author, init.uploadId);
      assert.equal(done.status, "ok");
      if (done.status !== "ok") return;
      assert.equal(done.attachment.status, "pending", "a completed chunked upload starts pending (then scans)");
      assert.equal("uploadedBy" in (done.attachment as object), false);
      await assertAudited(pool, "attachment.uploaded", done.attachment.id);

      // The session row is gone, and the object is the concatenation of the parts.
      const { rows: sessGone } = await pool.query<{ n: string }>(`select count(*)::text as n from attachment_uploads where id = $1`, [init.uploadId]);
      assert.equal(sessGone[0]!.n, "0", "the session row is deleted on complete");
      const { rows: keyRows } = await pool.query<{ object_key: string; size_bytes: string }>(
        `select object_key, size_bytes::text from attachments where id = $1`,
        [done.attachment.id],
      );
      const assembled = objects.get(keyRows[0]!.object_key);
      const expected = new Uint8Array(total);
      expected.set(part1, 0);
      expected.set(part2, part1.length);
      assert.deepEqual(assembled, expected, "complete reassembles the parts in order");
      assert.equal(keyRows[0]!.size_bytes, String(total), "the row records the verified size");
      assert.equal((await listAttachmentsForParent(pool, author, "challenge", parentId)).length, 1);

      // ── Abort discards the session (no attachments row) ────────────────────────────────
      const init2 = await initiateChunkedUpload(deps, author, { parentType: "challenge", parentId, filename: "abandon.txt", mime: "text/plain", size: total });
      assert.equal(init2.status, "ok");
      if (init2.status !== "ok") return;
      await useTinyChunks(init2.uploadId);
      assert.equal((await uploadChunkPart(deps, author, init2.uploadId, 1, part1)).status, "ok");
      assert.equal((await abortChunkedUpload(deps, author, init2.uploadId)).status, "ok");
      const { rows: sess2 } = await pool.query<{ n: string }>(`select count(*)::text as n from attachment_uploads where id = $1`, [init2.uploadId]);
      assert.equal(sess2[0]!.n, "0", "the session row is deleted on abort");
      const { rows: abortAudit } = await pool.query<{ n: string }>(
        `select count(*)::text as n from audit_log where action = 'attachment.upload_aborted'`,
      );
      assert.ok(Number(abortAudit[0]!.n) >= 1, "abort is audited attachment.upload_aborted");

      // ── Complete verifies the assembly: a missing part → size_mismatch abort ─────────────
      const init3 = await initiateChunkedUpload(deps, author, { parentType: "challenge", parentId, filename: "partial.txt", mime: "text/plain", size: total });
      assert.equal(init3.status, "ok");
      if (init3.status !== "ok") return;
      await useTinyChunks(init3.uploadId);
      assert.equal((await uploadChunkPart(deps, author, init3.uploadId, 1, part1)).status, "ok");
      const rowsBefore = (await listAttachmentsForParent(pool, author, "challenge", parentId)).length;
      const incomplete = await completeChunkedUpload(deps, author, init3.uploadId);
      assert.equal(incomplete.status, "upload_incomplete", "a missing final part fails the assembly check");
      const { rows: sess3 } = await pool.query<{ n: string }>(`select count(*)::text as n from attachment_uploads where id = $1`, [init3.uploadId]);
      assert.equal(sess3[0]!.n, "0", "the session row is dropped");
      assert.equal((await listAttachmentsForParent(pool, author, "challenge", parentId)).length, rowsBefore, "no attachments row is created");
      const { rows: mismatchAudit } = await pool.query<{ after: { reason?: string } }>(
        `select after from audit_log where action = 'attachment.upload_aborted' and after->>'objectKey' like $1 order by id desc limit 1`,
        [`%${parentId}%`],
      );
      assert.equal(mismatchAudit[0]?.after.reason, "size_mismatch", "audited with reason size_mismatch");
      assert.equal((await completeChunkedUpload(deps, author, init3.uploadId)).status, "not_found", "the client must start a new upload");

      // ── Submit scan gate helper: unclean staged rows block; clean ones don't ───────────
      const gateKey = randomUUID();
      const staged = await stageAttachment(deps, author, { parentType: "challenge", draftKey: gateKey, filename: "s.txt", mime: "text/plain", size: part1.length, bytes: part1 });
      assert.equal(staged.status, "ok");
      if (staged.status !== "ok") return;
      assert.equal(await hasUncleanStagedAttachments(pool, author, "challenge", gateKey), true, "a pending staged row is unclean");
      await pool.query(`update attachments set scan_status = 'clean' where id = $1`, [staged.attachment.id]);
      assert.equal(await hasUncleanStagedAttachments(pool, author, "challenge", gateKey), false, "once clean the gate opens");
      await pool.query(`update attachments set scan_status = 'infected' where id = $1`, [staged.attachment.id]);
      assert.equal(await hasUncleanStagedAttachments(pool, author, "challenge", gateKey), true, "an infected staged row blocks submit");
      // The gate is scoped to the caller: another user's key isn't consulted.
      assert.equal(await hasUncleanStagedAttachments(pool, other, "challenge", gateKey), false, "gate is per-uploader");

      // ── Scan retries → the terminal `unscannable` state (shared verdict handler) ─────────
      const failing = async () => {
        throw new ClamdErrorReply("Can't allocate memory ERROR");
      };
      const odd = await stageAttachment(deps, author, { parentType: "challenge", draftKey: randomUUID(), filename: "odd.txt", mime: "text/plain", size: part1.length, bytes: part1 });
      assert.equal(odd.status, "ok");
      if (odd.status !== "ok") return;
      // A per-file error counts an attempt and backs the row off; it stays pending.
      await scanAttachmentNow({ ...deps, scan: failing }, odd.attachment.id);
      const { rows: afterOne } = await pool.query<{ scan_status: string; scan_attempts: number; due_later: boolean }>(
        `select scan_status, scan_attempts, next_scan_at > now() as due_later from attachments where id = $1`,
        [odd.attachment.id],
      );
      assert.deepEqual(afterOne[0], { scan_status: "pending", scan_attempts: 1, due_later: true });
      // An outage counts nothing.
      await scanAttachmentNow({ ...deps, scan: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); } }, odd.attachment.id);
      const { rows: afterOutage } = await pool.query<{ scan_attempts: number }>(`select scan_attempts from attachments where id = $1`, [odd.attachment.id]);
      assert.equal(afterOutage[0]!.scan_attempts, 1, "an outage never condemns a file");
      // The attempt that reaches the cap makes the row unscannable: purged, audited, gate-blocking.
      await pool.query(`update attachments set scan_attempts = $2 where id = $1`, [odd.attachment.id, SCAN_MAX_ATTEMPTS - 1]);
      await scanAttachmentNow({ ...deps, scan: failing }, odd.attachment.id);
      const { rows: oddRow } = await pool.query<{ scan_status: string; object_key: string; draft_key: string }>(
        `select scan_status, object_key, draft_key from attachments where id = $1`,
        [odd.attachment.id],
      );
      assert.equal(oddRow[0]!.scan_status, "unscannable");
      assert.equal(objects.has(oddRow[0]!.object_key), false, "the unscannable object is purged");
      await assertAudited(pool, "attachment.scan_unscannable", odd.attachment.id);
      assert.equal(await hasUncleanStagedAttachments(pool, author, "challenge", oddRow[0]!.draft_key), true, "an unscannable staged row blocks submit");

      // On a bound parent: listed only to the uploader, never downloadable.
      const bound = await stageAttachment(deps, author, { parentType: "challenge", draftKey: randomUUID(), filename: "b.txt", mime: "text/plain", size: part1.length, bytes: part1 });
      assert.equal(bound.status, "ok");
      if (bound.status !== "ok") return;
      await pool.query(`update attachments set parent_id = $2, draft_key = null, scan_status = 'unscannable' where id = $1`, [bound.attachment.id, parentId]);
      const authorView = (await listAttachmentsForParent(pool, author, "challenge", parentId)).find((a) => a.id === bound.attachment.id);
      assert.equal(authorView?.status, "unscannable", "the uploader sees the unscannable row");
      assert.equal((await listAttachmentsForParent(pool, other, "challenge", parentId)).some((a) => a.id === bound.attachment.id), false, "nobody else does");
      assert.equal((await getAttachmentForDownload(deps, author, bound.attachment.id)).status, "denied", "unscannable is never served");
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
  const { rows } = await pool.query(`select 1 from audit_log where action = $1 and target_id = $2 order by id desc limit 1`, [action, targetId]);
  assert.equal(rows.length, 1, `expected an audit_log row for ${action} / ${targetId}`);
}
