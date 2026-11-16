// Live-DB integration test (gated) for §42 Mark as duplicate (INNOBOX_SPEC.md §42.9):
//   • the mark: status, link and note; the followers who can see the original move (and only they);
//     marks copied with every skip, plus the authors' mark; one audit row with the counts and never
//     the note; the detail on both sides (the pointer, the note, "Also raised as", comments closed);
//   • event 25: authors (actionable, never held) and followers (follower-type), per-recipient
//     rendering, nothing to the marker; the inbox re-renders the original at read time;
//   • refusals in the §42.9 order: not found, trashed, forbidden, own item, status, open solution, and
//     every original case (missing, self, awaiting triage, withdrawn, a duplicate, visibility), the note;
//     `duplicate` refused on the status PATCH;
//   • a chain is re-pointed; a closed original gets no marks; two crossing marks leave no chain;
//   • an override out clears the link and reopens comments; follows stay moved;
//   • the per-viewer filter after a visibility change, in the detail and the gallery;
//   • the outside submitter: the merge mail, the outcome that follows the original (solved, already
//     rejected, withdrawn) and the hard delete that unlinks and starts the clock;
//   • the similarity check, the dialog's candidates and the triage export.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "mark as duplicate: mark, event 25, refusals, chains, undo, visibility, submitter, delete, lists",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("./store");
    const dup = await import("./duplicates");
    const aff = await import("./affected");
    const { deleteChallenge } = await import("./delete");
    const { trashChallenge } = await import("./trash");
    const { autoFollow } = await import("../follows/store");
    const { createComment } = await import("../comments/store");
    const { getInbox } = await import("../notifications/store");
    const { exportTriageCsv } = await import("../admin/triage/store");
    const { notifyClosedAsDuplicate } = await import("../../../lib/notify-events");

    const pool = new Pool({ connectionString: url });
    // The public-form challenges this suite makes have no author. Later suites re-run migration
    // 0037's backfill, which reads every challenge's author_id, so they are purged on the way out.
    const externals: string[] = [];
    let purge: (() => Promise<void>) | null = null;
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
            `dbtest-dup-${label}-${stamp}`,
            `Dbtest Dup ${label}`,
          ])
        ).rows[0]!.id;
      const nsId = await mkNs("main");
      const otherNsId = await mkNs("other");
      type Roles = ReturnType<typeof buildRoleSet>;
      const rolesOf = new Map<string, Roles>();
      const roles = (grants: { role: "member" | "committee" | "namespace_admin"; ns: string }[]) =>
        buildRoleSet(
          grants.map((x) => ({ role: x.role, namespaceId: x.ns })),
          { globalNamespaceId: globalId },
        );
      const mkUser = async (label: string, r: Roles = roles([{ role: "member", ns: nsId }])) => {
        const id = (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
            `dbtest-dup-${label}-${stamp}`,
            `dbtest-dup-${label}-${stamp}@example.test`,
            `Dbtest dup ${label} ${stamp}`,
          ])
        ).rows[0]!.id;
        rolesOf.set(id, r);
        return { userId: id, roles: r };
      };
      const resolveRoles = Object.assign(async (id: string) => rolesOf.get(id) ?? roles([{ role: "member", ns: globalId }]), {});
      const resolveMany = async (ids: readonly string[]) => new Map(ids.map((id) => [id, rolesOf.get(id) ?? roles([{ role: "member", ns: globalId }])]));
      const ctx = (actorId: string | null) => ({ pool, actorId, resolveRoles });
      const storage = { deleteObject: async () => {}, abortMultipartUpload: async () => {} };
      // Set once the platform admin exists (below); the finally runs it, pass or fail.
      const armPurge = (admin: { userId: string; roles: Roles }) => {
        purge = async () => {
          for (const num of externals) await deleteChallenge({ pool, storage } as never, admin, num, "dbtest cleanup");
        };
      };

      const author = await mkUser("author");
      const follower = await mkUser("follower");
      const outsideFollower = await mkUser("outside-follower", roles([{ role: "member", ns: otherNsId }]));
      const marker = await mkUser("marker");
      const markerOnBoth = await mkUser("marker-both");
      const member = await mkUser("member");
      const committee = await mkUser("committee", roles([{ role: "committee", ns: nsId }]));
      const nsAdmin = await mkUser("nsadmin", roles([{ role: "namespace_admin", ns: nsId }]));
      const otherAdmin = await mkUser("other-admin", roles([{ role: "namespace_admin", ns: otherNsId }]));
      const platform = await mkUser("platform", buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }));
      armPurge(platform);
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const newChallenge = async (
        title: string,
        opts: { by?: typeof author; visibility?: "org" | "namespace"; status?: string | null; estimate?: number | null; anonymous?: boolean } = {},
      ) => {
        const r = await store.createChallenge(pool, opts.by ?? author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `${title} ${stamp}`,
          description: `About ${title} ${stamp}`,
          clientName: null,
          visibility: opts.visibility ?? "org",
          isAnonymous: opts.anonymous ?? false,
          affectedEstimate: opts.estimate ?? null,
        });
        if (r.status !== "ok") throw new Error(`create failed: ${r.status}`);
        const num = r.challenge.number.replace("CH-", "");
        const status = opts.status === undefined ? "in_review" : opts.status;
        if (status) assert.equal((await store.setChallengeStatus(pool, nsAdmin, num, status)).status, "ok");
        return { id: r.challenge.id, num, label: r.challenge.number, title: `${title} ${stamp}` };
      };
      /** Turns a fresh challenge into one accepted from the public form (§24.6): no author, a submission. */
      const makeExternal = async (c: { id: string; num: string }, label: string) => {
        const ps = (
          await pool.query<{ id: string }>(
            `insert into public_submissions (status, title, description, submitter_name, submitter_email, confirm_expires_at, pow_salt, decided_at)
             values ('accepted', $1, 'From outside', 'Outside Person', $2, now() + interval '1 day', $3, now()) returning id`,
            [`External ${label} ${stamp}`, `outside-${label}-${stamp}@example.test`, `salt-${label}-${stamp}`],
          )
        ).rows[0]!.id;
        await pool.query(`delete from challenge_authors where challenge_id = $1`, [c.id]);
        await pool.query(`update challenges set author_id = null, public_submission_id = $2 where id = $1`, [c.id, ps]);
        externals.push(c.num);
        return ps;
      };
      const mark = (actor: typeof author, d: { num: string }, original: string, note: unknown = null) =>
        dup.markDuplicate(pool, actor, d.num, { original, note }, resolveMany);
      const follows = async (challengeId: string) =>
        (await pool.query<{ user_id: string }>(`select user_id from follows where parent_type = 'challenge' and parent_id = $1`, [challengeId])).rows
          .map((r) => r.user_id)
          .sort();
      const outboxFor = async (submissionId: string) =>
        (await pool.query<{ type: string }>(`select type from notification_outbox where payload->>'submissionId' = $1 order by created_at`, [submissionId])).rows.map(
          (r) => r.type,
        );

      // ── The mark (§42.4) ────────────────────────────────────────────────────────────────
      // The original has an author of its own: the duplicate's authors' mark skips an author of the
      // original (§42.4 step 5), which a shared author would hide.
      const originalAuthor = await mkUser("original-author");
      const original = await newChallenge("Manual invoice matching", { status: "valid", by: originalAuthor });
      const duplicate = await newChallenge("Invoices matched by hand", { estimate: 7 });
      await autoFollow(pool, follower.userId, "challenge", duplicate.id);
      await autoFollow(pool, outsideFollower.userId, "challenge", duplicate.id);
      assert.equal((await aff.setAffected(pool, marker, duplicate.num, 3)).status, "ok");
      assert.equal((await aff.setAffected(pool, markerOnBoth, duplicate.num, 4)).status, "ok");
      assert.equal((await aff.setAffected(pool, markerOnBoth, original.num, 9)).status, "ok");
      // §41.3: a first mark auto-follows (the route does it after the store call).
      await autoFollow(pool, marker.userId, "challenge", duplicate.id);
      await autoFollow(pool, markerOnBoth.userId, "challenge", duplicate.id);
      const followersBefore = await follows(duplicate.id);

      const preview = await dup.previewDuplicate(pool, nsAdmin, duplicate.num, original.label, resolveMany);
      assert.equal(preview.status, "ok");
      assert.ok(preview.status === "ok" && preview.preview.ok);
      if (preview.status === "ok" && preview.preview.ok) {
        // author, follower, outsideFollower (org original), marker, markerOnBoth (first marks follow).
        assert.equal(preview.preview.followersToMove, followersBefore.length);
        assert.equal(preview.preview.marksToCopy, 1, "markerOnBoth already has a row on the original");
        assert.equal(preview.preview.authorsMark, true);
        assert.equal(preview.preview.repointed, 0);
      }

      const marked = await mark(nsAdmin, duplicate, original.label, "  Same problem — CH-original has more detail  ");
      assert.equal(marked.status, "ok");
      if (marked.status !== "ok") throw new Error("mark failed");
      const row = (
        await pool.query<{ status: string; duplicate_of_id: string | null; duplicate_note: string | null }>(
          `select status, duplicate_of_id, duplicate_note from challenges where id = $1`,
          [duplicate.id],
        )
      ).rows[0]!;
      assert.deepEqual(row, { status: "duplicate", duplicate_of_id: original.id, duplicate_note: "Same problem — CH-original has more detail" });
      assert.deepEqual(await follows(duplicate.id), [], "every follower could see the org original, so every follow moved");
      for (const id of followersBefore) assert.ok((await follows(original.id)).includes(id), "moved to the original");
      const marksOnOriginal = (
        await pool.query<{ user_id: string; headcount: number }>(`select user_id, headcount from challenge_affected where challenge_id = $1 order by created_at`, [original.id])
      ).rows;
      assert.deepEqual(
        new Map(marksOnOriginal.map((m) => [m.user_id, m.headcount])),
        new Map([
          [markerOnBoth.userId, 9],
          [marker.userId, 3],
          [author.userId, 7],
        ]),
        "copied mark, the authors' mark with the estimate, and the existing row untouched",
      );
      const markAudit = (
        await pool.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
          `select before, after from audit_log where target_id = $1 and action = 'challenge.status_changed' order by id desc limit 1`,
          [duplicate.id],
        )
      ).rows[0]!;
      assert.equal(markAudit.after.trigger, "marked_duplicate");
      assert.equal(markAudit.after.duplicateOf, original.label);
      assert.equal(markAudit.after.override, true);
      assert.equal(markAudit.after.withNote, true);
      assert.equal(markAudit.after.followersMoved, followersBefore.length);
      assert.equal(markAudit.after.marksCopied, 1);
      assert.equal(markAudit.after.authorsMark, true);
      assert.ok(!JSON.stringify(markAudit).includes("Same problem"), "the note never reaches the audit log");

      const dupDetail = (await store.getChallengeByNumber(pool, author, duplicate.num))!;
      assert.deepEqual(dupDetail.duplicateOf, { number: original.label, title: original.title });
      assert.equal(dupDetail.duplicateNote, "Same problem — CH-original has more detail");
      assert.equal(dupDetail.commentsClosed, true);
      assert.equal(dupDetail.likesFrozen, true);
      assert.equal(dupDetail.canMarkDuplicate, false);
      const origDetail = (await store.getChallengeByNumber(pool, member, original.num))!;
      assert.deepEqual(origDetail.duplicates, [{ number: duplicate.label, title: duplicate.title }]);
      assert.equal(origDetail.duplicateOf, null);
      assert.equal((await store.getChallengeByNumber(pool, nsAdmin, original.num))!.canMarkDuplicate, true);

      // Comments close on the duplicate.
      assert.equal((await createComment(pool, member, "challenge", duplicate.id, "Me too")).status, "closed");
      assert.equal((await createComment(pool, member, "challenge", original.id, "Me too")).status, "ok");

      // ── Event 25 (§42.6) ────────────────────────────────────────────────────────────────
      await notifyClosedAsDuplicate(ctx(nsAdmin.userId), marked.notice);
      const inbox = async (userId: string) =>
        (
          await pool.query<{ payload: Record<string, unknown>; id: string }>(
            `select id, payload from notifications where user_id = $1 and type = 'closed_as_duplicate' and payload->>'parentId' = $2`,
            [userId, duplicate.id],
          )
        ).rows;
      const authorRows = await inbox(author.userId);
      assert.equal(authorRows.length, 1);
      assert.equal(authorRows[0]!.payload.author, true);
      assert.equal(authorRows[0]!.payload.originalNumber, original.num);
      const authorOutbox = (
        await pool.query<{ digest_due_at: Date | null }>(`select digest_due_at from notification_outbox where payload->>'notificationId' = $1`, [authorRows[0]!.id])
      ).rows;
      assert.equal(authorOutbox.length, 1);
      assert.equal(authorOutbox[0]!.digest_due_at, null, "the author's copy is never held");
      assert.equal((await inbox(follower.userId))[0]?.payload.author, false);
      assert.equal((await inbox(nsAdmin.userId)).length, 0, "never the marker");
      assert.equal((await inbox(markerOnBoth.userId)).length, 1, "a first-mark follower is told too");
      const bell = await getInbox(pool, author);
      const line = bell.notifications.find((n) => n.type === "closed_as_duplicate" && n.link === `/challenges/${original.num}`);
      assert.equal(line?.message, `Your challenge ${duplicate.label} was closed as a duplicate of ${original.label} — the discussion continues there.`);

      // ── The status PATCH never sets it (§42.2) ─────────────────────────────────────────
      const other = await newChallenge("Other thing");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, other.num, "duplicate")).status, "use_mark_duplicate");

      // ── Refusals (§42.9 order) ─────────────────────────────────────────────────────────
      const hidden = await newChallenge("Hidden namespace one", { visibility: "namespace" });
      assert.equal((await mark(otherAdmin, hidden, original.label)).status, "not_found");
      assert.equal((await mark(member, other, original.label)).status, "forbidden");
      const ownByCommittee = await newChallenge("Committee's own", { by: committee });
      assert.equal((await mark(committee, ownByCommittee, original.label)).status, "own_item");
      const valid = await newChallenge("Valid one", { status: "valid" });
      assert.equal((await mark(committee, valid, original.label)).status, "wrong_status", "the committee marks from review only");
      const sol = await store.createSolution(pool, member, valid.num, { description: "Do it", costVsBenefits: null, isAnonymous: false });
      assert.equal(sol.status, "ok");
      assert.equal((await mark(nsAdmin, valid, original.label)).status, "open_solutions");
      const invalid = async (d: { num: string }, o: string, note: unknown = null) => {
        const r = await mark(nsAdmin, d, o, note);
        assert.equal(r.status, "invalid");
        return r.status === "invalid" ? r.message : "";
      };
      assert.match(await invalid(other, "CH-999999999"), /There is no challenge CH-999999999 that you can see\./);
      assert.equal(await invalid(other, other.label), "A challenge can't be a duplicate of itself.");
      const triage = await newChallenge("Still in triage", { status: null });
      assert.match(await invalid(other, triage.label), /can't be the original while it is awaiting triage or withdrawn/);
      assert.equal(await invalid(other, duplicate.label), `${duplicate.label} is itself a duplicate of ${original.label}. Choose ${original.label}.`);
      const nsOnly = await newChallenge("Namespace-only original", { visibility: "namespace" });
      assert.match(await invalid(other, nsOnly.label), /^Everyone who can see/);
      assert.equal(await invalid(other, original.label, "x".repeat(501)), "Keep the note to 500 characters or fewer.");
      // A namespace-only duplicate may point at a namespace-only original in the same namespace.
      const nsDup = await newChallenge("Namespace-only duplicate", { visibility: "namespace" });
      assert.equal((await mark(committee, nsDup, nsOnly.label)).status, "ok", "the committee marks from review");
      const trashed = await newChallenge("Trashed one");
      assert.equal((await trashChallenge({ pool, storage } as never, platform, trashed.num, "dbtest")).status, "ok");
      assert.equal((await mark(platform, trashed, original.label)).status, "trashed");

      // ── A chain is re-pointed; a closed original takes no marks ────────────────────────
      const x = await newChallenge("Chain middle");
      const y = await newChallenge("Chain tail");
      assert.equal((await mark(nsAdmin, y, x.label)).status, "ok");
      const root = await newChallenge("Chain root", { status: "solved" });
      await aff.setAffected(pool, marker, x.num, 2);
      const chained = await mark(nsAdmin, x, root.label);
      assert.equal(chained.status, "ok");
      assert.equal((await pool.query<{ d: string }>(`select duplicate_of_id as d from challenges where id = $1`, [y.id])).rows[0]!.d, root.id);
      const repointAudit = (await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where target_id = $1 and action = 'challenge.duplicate_repointed'`, [y.id]))
        .rows;
      assert.equal(repointAudit.length, 1);
      assert.equal(repointAudit[0]!.after.duplicateOf, root.label);
      assert.equal((await pool.query(`select 1 from challenge_affected where challenge_id = $1`, [root.id])).rowCount, 0, "a solved original keeps its reach as history");

      // ── Two crossing marks leave no chain ──────────────────────────────────────────────
      const a = await newChallenge("Cross A");
      const b = await newChallenge("Cross B");
      const crossed = await Promise.all([mark(nsAdmin, a, b.label), mark(nsAdmin, b, a.label)]);
      assert.equal(crossed.filter((r) => r.status === "ok").length, 1);
      assert.equal(crossed.filter((r) => r.status === "invalid").length, 1);

      // ── Undo: an override out clears the link; follows stay moved ──────────────────────
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, duplicate.num, "in_review")).status, "ok");
      const undone = (await pool.query<{ d: string | null; n: string | null }>(`select duplicate_of_id as d, duplicate_note as n from challenges where id = $1`, [duplicate.id])).rows[0]!;
      assert.deepEqual(undone, { d: null, n: null });
      const undoAudit = (
        await pool.query<{ before: Record<string, unknown> }>(`select before from audit_log where target_id = $1 and action = 'challenge.status_changed' order by id desc limit 1`, [duplicate.id])
      ).rows[0]!;
      assert.equal(undoAudit.before.duplicateOf, original.label);
      assert.deepEqual(await follows(duplicate.id), [], "nothing moves back");
      assert.equal((await createComment(pool, member, "challenge", duplicate.id, "Reopened")).status, "ok");

      // ── Per-viewer filtering after a visibility change (§42.5) ─────────────────────────
      const visOriginal = await newChallenge("Visibility original", { status: "valid" });
      const visDup = await newChallenge("Visibility duplicate");
      assert.equal((await mark(nsAdmin, visDup, visOriginal.label, "see the original")).status, "ok");
      assert.equal((await store.setChallengeVisibility(pool, nsAdmin, visOriginal.num, "namespace")).status, "ok");
      const seenByOutsider = (await store.getChallengeByNumber(pool, outsideFollower, visDup.num))!;
      assert.equal(seenByOutsider.duplicateOf, null);
      assert.equal(seenByOutsider.duplicateNote, null, "the note may name the original");
      const seenByMember = (await store.getChallengeByNumber(pool, member, visDup.num))!;
      assert.equal(seenByMember.duplicateOf?.number, visOriginal.label);
      const galleryOutsider = await store.listChallenges(pool, outsideFollower, { tab: "completed" } as never);
      assert.equal(galleryOutsider.find((c) => c.id === visDup.id)?.duplicateOf, null);
      const galleryMember = await store.listChallenges(pool, member, { tab: "completed" } as never);
      assert.equal(galleryMember.find((c) => c.id === visDup.id)?.duplicateOf?.number, visOriginal.label);

      // ── The outside submitter (§42.6) ──────────────────────────────────────────────────
      const extOriginal = await newChallenge("External original", { status: "valid" });
      const ext = await newChallenge("External duplicate");
      const ps = await makeExternal(ext, "merge");
      assert.equal((await mark(nsAdmin, ext, extOriginal.label)).status, "ok");
      assert.deepEqual(await outboxFor(ps), ["public_submission_merged"]);
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, extOriginal.num, "solved")).status, "ok");
      assert.deepEqual(await outboxFor(ps), ["public_submission_merged", "public_submission_solved"]);
      assert.equal((await pool.query(`select 1 from public_submissions where id = $1 and contact_erase_due_at is not null`, [ps])).rowCount, 1);

      const rejected = await newChallenge("Already rejected", { status: "rejected" });
      const ext2 = await newChallenge("External into rejected");
      const ps2 = await makeExternal(ext2, "rejected");
      assert.equal((await mark(nsAdmin, ext2, rejected.label)).status, "ok");
      assert.deepEqual(await outboxFor(ps2), ["public_submission_rejected"], "the outcome at once, in place of the merge mail");

      const withdrawnOriginal = await newChallenge("Original to withdraw");
      const ext3 = await newChallenge("External into withdrawn");
      const ps3 = await makeExternal(ext3, "withdrawn");
      assert.equal((await mark(nsAdmin, ext3, withdrawnOriginal.label)).status, "ok");
      assert.equal((await store.withdrawChallenge(pool, author, withdrawnOriginal.num)).status, "ok");
      assert.deepEqual(await outboxFor(ps3), ["public_submission_merged", "public_submission_rejected"]);

      // ── A hard delete of the original unlinks and starts the clock (§42.7) ─────────────
      const doomed = await newChallenge("Original to delete");
      const ext4 = await newChallenge("External left behind");
      const ps4 = await makeExternal(ext4, "deleted");
      assert.equal((await mark(nsAdmin, ext4, doomed.label)).status, "ok");
      assert.equal((await deleteChallenge({ pool, storage } as never, platform, doomed.num, "dbtest")).status, "ok");
      const left = (await pool.query<{ status: string; d: string | null }>(`select status, duplicate_of_id as d from challenges where id = $1`, [ext4.id])).rows[0]!;
      assert.deepEqual(left, { status: "duplicate", d: null });
      const delAudit = (await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where target_id = $1 and action = 'challenge.deleted'`, [doomed.id])).rows[0]!;
      assert.deepEqual(delAudit.after.duplicatesUnlinked, [ext4.label]);
      assert.equal((await pool.query(`select 1 from public_submissions where id = $1 and contact_erase_due_at is not null`, [ps4])).rowCount, 1);
      assert.deepEqual(await outboxFor(ps4), ["public_submission_merged"], "no mail on the delete");

      // ── Lists: the similarity check, the dialog's candidates, the triage export ─────────
      const similar = await store.findSimilarChallenges(pool, member, { title: `Visibility duplicate ${stamp}`, description: `About Visibility duplicate ${stamp}` });
      assert.ok(similar.some((s) => s.number === visOriginal.label), "the original is a candidate in its place");
      assert.ok(!similar.some((s) => s.number === visDup.label), "a duplicate is never a candidate");
      const fresh = await newChallenge("Visibility original twin");
      const searched = await dup.duplicateCandidates(pool, nsAdmin, fresh.num, `Manual invoice matching ${stamp}`);
      assert.equal(searched.status, "ok");
      if (searched.status === "ok") {
        assert.ok(searched.candidates.some((c) => c.number === original.label));
        assert.ok(!searched.candidates.some((c) => c.number === fresh.label), "never itself");
      }
      const nsSearch = await dup.duplicateCandidates(pool, nsAdmin, fresh.num, `Namespace-only original ${stamp}`);
      assert.ok(nsSearch.status === "ok" && nsSearch.candidates.length === 0, "an org duplicate never gets a namespace-only original");
      const exported = await exportTriageCsv(pool, nsAdmin, { namespaceId: nsId, status: "duplicate" });
      assert.equal(exported.rows.find((r) => r.number === visDup.label)?.duplicateOf?.number, visOriginal.label);

      // The purge (in the finally) must leave no author-less challenge behind.
      await (purge as unknown as () => Promise<void>)();
      purge = null;
      assert.equal(
        (await pool.query(`select 1 from challenges where author_id is null and number::text = any($1::text[])`, [externals])).rowCount,
        0,
      );
    } finally {
      if (purge) await (purge as () => Promise<void>)().catch(() => {});
      await pool.end();
    }
  },
);
