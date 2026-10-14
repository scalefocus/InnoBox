// Live-DB integration test (gated) for public submissions (INNOBOX_SPEC.md §24.4–§24.9). Proves
// at the SQL level: receive stores one unconfirmed row and a confirmation e-mail that carries
// nothing the submitter wrote; a salt buys one row; the per-address cap; confirm moves the row to
// pending_review once and fires event 14 to the platform admins; accept creates exactly one
// authorless challenge in awaiting_triage, audited with source "public" and never the name or
// e-mail; two concurrent decisions → one 409; decline and discard create nothing; the contact
// panel reaches only the item's admins, and no list, search or triage export carries the name or
// e-mail; needs_improvement is refused; the outcome mail is sent once; erasure and the §10.3
// purge. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

const fakeStorage = {
  putObject: async () => {},
  getObject: async () => new Uint8Array(),
  getObjectStream: async () => ({ body: new Blob([]).stream(), contentLength: 0 }),
  deleteObject: async () => {},
  createMultipartUpload: async () => "mpu-1",
  uploadPart: async () => {},
  listParts: async () => [],
  completeMultipartUpload: async () => {},
  abortMultipartUpload: async () => {},
};

test(
  "§24 public submissions: receive → confirm → accept, decisions, masking, outcome mail, erasure",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { receiveSubmission, confirmSubmission } = await import("./store");
    const admin = await import("../admin/public-submissions/store");
    const challenges = await import("../challenges/store");
    const { deleteChallenge } = await import("../challenges/delete");
    const { search } = await import("../search/store");
    const { exportTriageCsv, listTriageQueue } = await import("../admin/triage/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: globalRows } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = globalRows[0]!.id;
      const opts = { globalNamespaceId: globalId };
      const { rows: nsRows } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Public') returning id`, [
        `dbtest-pub-${stamp}`,
      ]);
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
          `dbtest-pub-${label}-${stamp}`,
          `dbtest-pub-${label}-${stamp}@example.test`,
          `Dbtest Pub ${label}`,
        ]);
        return rows[0]!.id;
      };
      // The platform admin is one through a SCIM group + role mapping, so event 14 resolves them.
      const adminId = await mkUser("admin");
      const groupExternal = `dbtest-pub-admins-${stamp}`;
      const { rows: g } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, 'Dbtest Pub admins') returning id`, [groupExternal]);
      await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [g[0]!.id, adminId]);
      await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, 'platform_admin', null)`, [groupExternal]);
      const platformAdmin = { userId: adminId, roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], opts) };
      const otherAdmin = { userId: await mkUser("admin2"), roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], opts) };
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], opts) };
      const member = { userId: await mkUser("member"), roles: buildRoleSet([{ role: "member", namespaceId: nsId }], opts) };

      const NAME = `Zed Outsider ${stamp}`;
      const EMAIL = `zed.${stamp}@outside.example`;
      const fields = (title: string, email = EMAIL) => ({
        title,
        description: `Our problem ${stamp} is the queue at reception`,
        name: NAME,
        email,
        company: "Acme Ltd",
        honeypot: "",
        request: { visibility: "org" as const, emails: [], teams: [] },
      });
      const salt = () => `${randomUUID().replace(/-/g, "").slice(0, 24)}?expires=${Date.now() + 600_000}`;

      // ── Receive ───────────────────────────────────────────────────────────────────────────
      const powSalt = salt();
      const received = await receiveSubmission(pool, fields(`Reception queue ${stamp}`), powSalt);
      assert.equal(received.status, "received");
      if (received.status !== "received") throw new Error("fixture");
      const { rows: stored } = await pool.query(`select status, confirm_token_hash from public_submissions where id = $1`, [received.id]);
      assert.equal(stored[0].status, "unconfirmed");
      assert.notEqual(stored[0].confirm_token_hash, received.token, "only the hash is stored");
      const { rows: mails } = await pool.query<{ user_id: string | null; recipient_email: string; type: string; payload: Record<string, string> }>(
        `select user_id, recipient_email, type, payload from notification_outbox where payload->>'submissionId' = $1`,
        [received.id],
      );
      assert.equal(mails.length, 1);
      assert.equal(mails[0]!.user_id, null);
      assert.equal(mails[0]!.recipient_email, EMAIL);
      assert.equal(mails[0]!.type, "public_submission_confirm");
      assert.equal(mails[0]!.payload.subject, "Confirm your submission");
      const mailText = JSON.stringify(mails[0]!.payload);
      assert.ok(!mailText.includes("Reception queue") && !mailText.includes(NAME) && !mailText.includes("our problem"), "the confirmation carries nothing the submitter wrote");
      assert.equal(mails[0]!.payload.link, `/submit/confirm#${received.token}`);

      // A salt buys one row.
      assert.deepEqual(await receiveSubmission(pool, fields(`Again ${stamp}`), powSalt), { status: "spent" });

      // The per-address cap: 3 per 24 h, compared lower-cased.
      const capEmail = `Cap.${stamp}@Outside.example`;
      for (let i = 0; i < 3; i++) assert.equal((await receiveSubmission(pool, fields(`Cap ${i} ${stamp}`, capEmail), salt())).status, "received");
      assert.deepEqual(await receiveSubmission(pool, fields(`Cap 4 ${stamp}`, capEmail.toLowerCase()), salt()), { status: "address_capped" });

      // ── Confirm ───────────────────────────────────────────────────────────────────────────
      assert.deepEqual(await confirmSubmission(pool, "x".repeat(43)), { status: "invalid" });
      assert.equal((await confirmSubmission(pool, received.token)).status, "confirmed");
      assert.deepEqual(await confirmSubmission(pool, received.token), { status: "invalid" }, "used once");
      const { rows: confirmed } = await pool.query(`select status, confirmed_at, confirm_token_hash from public_submissions where id = $1`, [received.id]);
      assert.equal(confirmed[0].status, "pending_review");
      assert.ok(confirmed[0].confirmed_at);
      assert.equal(confirmed[0].confirm_token_hash, null);
      const { rows: ev14 } = await pool.query(`select payload from notifications where user_id = $1 and type = 'public_submission_confirmed'`, [adminId]);
      assert.ok(ev14.length >= 1, "event 14 reaches the platform admin");
      assert.ok(!JSON.stringify(ev14).includes(NAME));

      // An expired link is the same "invalid".
      const late = await receiveSubmission(pool, fields(`Late ${stamp}`, `late.${stamp}@outside.example`), salt());
      if (late.status !== "received") throw new Error("fixture");
      await pool.query(`update public_submissions set confirm_expires_at = now() - interval '1 minute' where id = $1`, [late.id]);
      assert.deepEqual(await confirmSubmission(pool, late.token), { status: "invalid" });

      // ── The queue ─────────────────────────────────────────────────────────────────────────
      const pending = await admin.listPublicSubmissions(pool, "pending");
      assert.ok(pending.some((r) => r.id === received.id));
      assert.ok(!pending.some((r) => r.id === late.id), "an unconfirmed row is not in the queue");
      assert.equal(await admin.getPublicSubmission(pool, platformAdmin, late.id), null);
      const detail = await admin.getPublicSubmission(pool, platformAdmin, received.id);
      assert.equal(detail?.name, NAME);
      assert.ok(Array.isArray(detail?.similar));

      // ── Accept, racing a decline: exactly one wins ────────────────────────────────────────
      const internal = (await challenges.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const acceptInput = {
        namespaceId: nsId,
        visibility: "org",
        impactAreaId: internal.id,
        clientName: null,
        title: `Reception queue (edited) ${stamp}`,
        description: `Our problem ${stamp} is the queue at reception`,
      };
      const [a, d] = await Promise.all([
        admin.acceptPublicSubmission(pool, platformAdmin, received.id, acceptInput),
        admin.declinePublicSubmission(pool, otherAdmin, received.id, null),
      ]);
      const statuses = [a.status, d.status].sort();
      assert.deepEqual(statuses, ["conflict", "ok"], "two concurrent decisions → one 409");
      let accepted = a;
      if (a.status !== "ok") {
        // The decline won the race: run the accept path on a fresh submission instead.
        const again = await receiveSubmission(pool, fields(`Reception queue ${stamp}`, `again.${stamp}@outside.example`), salt());
        if (again.status !== "received") throw new Error("fixture");
        await confirmSubmission(pool, again.token);
        accepted = await admin.acceptPublicSubmission(pool, platformAdmin, again.id, acceptInput);
      }
      assert.equal(accepted.status, "ok");
      if (accepted.status !== "ok") throw new Error("fixture");
      const { rows: chRows } = await pool.query(
        `select id, number::text, status, author_id, public_submission_id, is_anonymous from challenges where id = $1`,
        [accepted.challengeId],
      );
      const ch = chRows[0];
      assert.equal(ch.status, "awaiting_triage");
      assert.equal(ch.author_id, null);
      assert.ok(ch.public_submission_id);
      assert.equal(ch.is_anonymous, false);
      const { rows: createdCount } = await pool.query(`select count(*)::int as n from challenges where public_submission_id = $1`, [ch.public_submission_id]);
      assert.equal(createdCount[0].n, 1, "exactly one challenge");
      const subId = ch.public_submission_id as string;
      // A decision on an already-decided row is a conflict.
      assert.deepEqual(await admin.declinePublicSubmission(pool, otherAdmin, subId, null), { status: "conflict" });
      assert.deepEqual(await admin.discardPublicSubmission(pool, otherAdmin, subId), { status: "conflict" });

      const { rows: audits } = await pool.query<{ action: string; after: Record<string, unknown> }>(
        `select action, after from audit_log where target_id = $1 or target_id = $2 order by id`,
        [accepted.challengeId, subId],
      );
      const created = audits.find((r) => r.action === "challenge.created")!;
      assert.equal(created.after.source, "public");
      assert.deepEqual(created.after.editedOnAccept, ["title"]);
      assert.equal(audits.find((r) => r.action === "public_submission.accepted")!.after.challengeNumber, accepted.number);
      const auditText = JSON.stringify(audits);
      assert.ok(!auditText.includes(NAME) && !auditText.includes("outside.example"), "no audit row carries the name or e-mail");

      // ── How it shows inside InnoBox ───────────────────────────────────────────────────────
      const num = accepted.number.replace("CH-", "");
      const adminView = await challenges.getChallengeByNumber(pool, platformAdmin, num);
      assert.equal(adminView?.author.displayName, "External submission · Acme Ltd");
      assert.equal(adminView?.author.external, true);
      assert.equal(adminView?.author.userId, null);
      assert.equal(adminView?.canReveal, false);
      assert.equal(adminView?.externalContact?.name, NAME);
      const nsAdminView = await challenges.getChallengeByNumber(pool, nsAdmin, num);
      assert.ok(nsAdminView?.externalContact?.email?.endsWith("@outside.example"), "the namespace's admins see the contact panel");
      assert.equal(await challenges.getChallengeByNumber(pool, member, num), null, "awaiting triage: not visible to a member");

      // needs_improvement is refused for every role.
      assert.deepEqual(await challenges.setChallengeStatus(pool, platformAdmin, num, "needs_improvement"), { status: "external_no_author" });
      assert.equal((await challenges.setChallengeStatus(pool, platformAdmin, num, "in_review")).status, "ok");
      const memberView = await challenges.getChallengeByNumber(pool, member, num);
      assert.deepEqual(memberView?.external, { company: "Acme Ltd" });
      assert.equal(memberView?.externalContact, null, "a member never sees the contact details");
      assert.equal(memberView?.isMine, false);
      assert.ok(!memberView?.allowedTransitions.includes("needs_improvement"));

      // No list, search or triage export carries the name or e-mail.
      const surfaces = JSON.stringify([
        await challenges.listChallenges(pool, member, { tab: "open", sort: "newest" }),
        await search(pool, member, `reception ${stamp}`),
        await listTriageQueue(pool, platformAdmin, { namespaceId: nsId }),
        await exportTriageCsv(pool, platformAdmin, { namespaceId: nsId }),
        await challenges.findSimilarChallenges(pool, member, { title: "reception queue", description: stamp }),
      ]);
      assert.ok(surfaces.includes("External submission · Acme Ltd"));
      assert.ok(!surfaces.includes(NAME) && !surfaces.includes("outside.example"));

      // ── Outcome mail: once, on the first close ────────────────────────────────────────────
      const outcomeMails = async () =>
        (
          await pool.query(
            `select type from notification_outbox where payload->>'submissionId' = $1 and type in ('public_submission_solved', 'public_submission_rejected')`,
            [subId],
          )
        ).rows.map((r) => r.type as string);
      assert.equal((await challenges.setChallengeStatus(pool, platformAdmin, num, "rejected")).status, "ok");
      assert.deepEqual(await outcomeMails(), ["public_submission_rejected"]);
      const { rows: due } = await pool.query(`select contact_erase_due_at from public_submissions where id = $1`, [subId]);
      assert.ok(due[0].contact_erase_due_at, "the first close sets the erasure date");
      assert.equal((await challenges.setChallengeStatus(pool, platformAdmin, num, "in_review")).status, "ok");
      assert.equal((await challenges.setChallengeStatus(pool, platformAdmin, num, "solved")).status, "ok");
      assert.deepEqual(await outcomeMails(), ["public_submission_rejected"], "a later close does not re-arm it");

      // ── Erasure ───────────────────────────────────────────────────────────────────────────
      assert.deepEqual(await admin.eraseSubmissionContact(pool, platformAdmin, subId), { status: "ok", erased: true });
      assert.deepEqual(await admin.eraseSubmissionContact(pool, platformAdmin, subId), { status: "ok", erased: false });
      const erasedView = await challenges.getChallengeByNumber(pool, platformAdmin, num);
      assert.equal(erasedView?.externalContact?.name, null);
      assert.ok(erasedView?.externalContact?.erasedAt);
      assert.equal(erasedView?.author.displayName, "External submission · Acme Ltd", "the company stays");
      const { rows: leftMail } = await pool.query(`select 1 from notification_outbox where payload->>'submissionId' = $1`, [subId]);
      assert.equal(leftMail.length, 0, "no mail to an erased address");
      const { rows: erasedAudit } = await pool.query(`select after from audit_log where target_id = $1 and action = 'public_submission.contact_erased'`, [subId]);
      assert.deepEqual(erasedAudit[0].after, { trigger: "manual" });

      // ── Decline (with a note) and discard create nothing ──────────────────────────────────
      const mkPending = async (label: string) => {
        const r = await receiveSubmission(pool, fields(`${label} ${stamp}`, `${label}.${stamp}@outside.example`), salt());
        if (r.status !== "received") throw new Error("fixture");
        await confirmSubmission(pool, r.token);
        return r.id;
      };
      const before = (await pool.query(`select count(*)::int as n from challenges`)).rows[0].n;
      const declineId = await mkPending("decline");
      assert.deepEqual(await admin.declinePublicSubmission(pool, platformAdmin, declineId, "Out of scope"), { status: "ok" });
      const { rows: declineMail } = await pool.query(`select payload from notification_outbox where payload->>'submissionId' = $1 and type = 'public_submission_declined'`, [declineId]);
      assert.match(declineMail[0].payload.message, /Out of scope/);
      const { rows: declineAudit } = await pool.query(`select after from audit_log where target_id = $1 and action = 'public_submission.declined'`, [declineId]);
      assert.deepEqual(declineAudit[0].after, { noteSent: true });
      const discardId = await mkPending("discard");
      assert.deepEqual(await admin.discardPublicSubmission(pool, platformAdmin, discardId), { status: "ok" });
      assert.equal((await pool.query(`select 1 from public_submissions where id = $1`, [discardId])).rows.length, 0);
      assert.equal((await pool.query(`select 1 from notification_outbox where payload->>'submissionId' = $1`, [discardId])).rows.length, 0, "a discard sends nothing");
      assert.equal((await pool.query(`select count(*)::int as n from challenges`)).rows[0].n, before, "decline and discard create no challenge");

      // ── The §10.3 purge takes the submission row with it ──────────────────────────────────
      assert.equal((await deleteChallenge({ pool, storage: fakeStorage }, platformAdmin, num, "dbtest cleanup")).status, "ok");
      assert.equal((await pool.query(`select 1 from public_submissions where id = $1`, [subId])).rows.length, 0);

      // The DB backstop: a challenge has an author or a submission, never both, never neither.
      await assert.rejects(
        pool.query(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, is_anonymous, author_id)
           values ($1, 'org', 'x', 'y', $2, false, null)`,
          [nsId, internal.id],
        ),
        /challenges_author_or_public_chk/,
      );
    } finally {
      await pool.end();
    }
  },
);
