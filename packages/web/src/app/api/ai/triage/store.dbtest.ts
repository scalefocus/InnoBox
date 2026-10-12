// Live-DB integration test (gated) for the web half of triage assist (INNOBOX_SPEC.md §22.11): who
// sees a challenge's note per role and status — namespace and platform admins always, committee and
// assignee only past awaiting_triage, never the author or a plain member; duplicates re-filtered
// for the reader; pending vs current after an edit; the switch; restricted challenges; Re-run
// (admins only); the queue indicator; withdrawal and the §10.3 cascade deleting the note.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "triage notes: readers per role and status, duplicates per reader, re-run, lifecycle",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const support = await import("../dbtest-support");
    const { getTriageNotes, rerunTriageNotes, triageQueueNotes } = await import("./store");
    const { withdrawChallenge } = await import("../../challenges/store");
    const { deleteChallenge } = await import("../../challenges/delete");

    const pool = new Pool({ connectionString: url });
    const stub = await support.startProviderStub();
    try {
      const key = randomBytes(32);
      const ai = support.testAiClient(pool, key);
      await support.configureAi(pool, key, stub.baseUrl);
      await support.setSwitch(pool, "ai_triage_assist_enabled", true);
      await support.setSwitch(pool, "ai_restricted_content_enabled", false);

      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: n } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $1) returning id`, [`dbtest-tn-${stamp}`]);
      const nsId = n[0]!.id;
      const mkUser = async (name: string) =>
        (await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [`dbtest-tn-${name}-${stamp}`, `dbtest-tn-${name}-${stamp}@example.test`, `Dbtest TN ${name}`])).rows[0]!.id;
      const roles = (grants: { role: "member" | "committee" | "namespace_admin" | "platform_admin"; namespaceId: string | null }[]) => buildRoleSet(grants, { globalNamespaceId: globalId });
      const author = { userId: await mkUser("author"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const member = { userId: await mkUser("member"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const committee = { userId: await mkUser("committee"), roles: roles([{ role: "committee", namespaceId: nsId }]) };
      const assignee = { userId: await mkUser("assignee"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const platform = { userId: await mkUser("platform"), roles: roles([{ role: "platform_admin", namespaceId: null }]) };
      // An admin of the namespace who also wrote the challenge: still never shown it (the author rule wins).
      const authorAdmin = { userId: author.userId, roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };

      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const mk = async (title: string, status: string, visibility = "org") =>
        (
          await pool.query<{ id: string; number: string }>(
            `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, is_anonymous)
             values ($1, $2, $3, 'Text', $4, $5, $6, false) returning id, number::text`,
            [nsId, visibility, title, ia[0]!.id, author.userId, status],
          )
        ).rows[0]!;
      const ch = await mk("Triage subject", "awaiting_triage");
      const dupVisible = await mk("Visible duplicate", "valid");
      const dupHidden = await mk("Hidden duplicate", "valid", "namespace");
      const hash = async (id: string) =>
        (await pool.query<{ h: string }>(`select md5(concat_ws(chr(31), 'triage-v1', c.title, c.description, ia.name)) as h from challenges c join impact_areas ia on ia.id = c.impact_area_id where c.id = $1`, [id])).rows[0]!.h;
      const writeNote = async (id: string) =>
        pool.query(
          `insert into ai_results (kind, parent_type, parent_id, input_hash, status, payload)
           values ('triage_assist', 'challenge', $1, $2, 'ready', $3)
           on conflict (kind, parent_type, parent_id) do update set input_hash = excluded.input_hash, status = 'ready', payload = excluded.payload`,
          [
            id,
            await hash(id),
            JSON.stringify({
              summary: "Summary text.",
              missingInformation: ["Impact"],
              suggestedImpactArea: "Internal",
              questions: ["How often?"],
              duplicates: [
                { number: Number(dupVisible.number), reason: "same" },
                { number: Number(dupHidden.number), reason: "same, restricted" },
              ],
            }),
          ],
        );
      const see = async (viewer: typeof author) => (await getTriageNotes(pool, ai, viewer, ch.number)) !== null;

      // No note yet: admins see Pending; awaiting_triage hides it from committee/assignee.
      let view = await getTriageNotes(pool, ai, nsAdmin, ch.number);
      assert.equal(view?.state, "pending");
      await writeNote(ch.id);
      view = await getTriageNotes(pool, ai, nsAdmin, ch.number);
      assert.equal(view?.state, "ready");
      assert.equal(view?.current, true);
      assert.equal(view?.canRerun, true);
      assert.equal(await see(platform), true);
      assert.equal(await see(author), false, "never the author");
      assert.equal(await see(authorAdmin), false, "never the author, even as an admin");
      assert.equal(await see(member), false);
      assert.equal(await see(committee), false, "committee only past awaiting_triage");
      await pool.query(`update challenges set assignee_id = $2 where id = $1`, [ch.id, assignee.userId]);
      assert.equal(await see(assignee), false, "assignee only past awaiting_triage");

      // Past awaiting_triage: the committee and the assignee see it too; a plain member never.
      await pool.query(`update challenges set status = 'in_review' where id = $1`, [ch.id]);
      await writeNote(ch.id);
      assert.equal(await see(committee), true);
      assert.equal(await see(assignee), true);
      assert.equal(await see(member), false);
      assert.equal((await getTriageNotes(pool, ai, committee, ch.number))?.canRerun, false, "Re-run is for admins");

      // Duplicates are re-filtered per reader: an admin sees both; an assignee who is not a member
      // of the namespace cannot see the restricted duplicate, so it is not listed for them.
      const adminDups = (await getTriageNotes(pool, ai, nsAdmin, ch.number))!.notes!.duplicates.map((d) => d.number);
      assert.deepEqual(adminDups.sort(), [`CH-${dupHidden.number}`, `CH-${dupVisible.number}`].sort());
      const outsider = { userId: assignee.userId, roles: roles([]) }; // assignee, but not a namespace member
      const outsiderView = await getTriageNotes(pool, ai, outsider, ch.number);
      assert.deepEqual(outsiderView!.notes!.duplicates.map((d) => d.number), [`CH-${dupVisible.number}`], "a restricted duplicate is hidden from a reader who cannot see it");

      // An edit: the note is from an earlier version and a new one is pending.
      await pool.query(`update challenges set description = 'Edited text' where id = $1`, [ch.id]);
      view = await getTriageNotes(pool, ai, nsAdmin, ch.number);
      assert.equal(view?.state, "pending");
      assert.equal(view?.current, false);
      assert.ok(view?.notes, "the earlier note stays readable");

      // Re-run: admins only; clears the hash.
      await writeNote(ch.id);
      assert.equal(await rerunTriageNotes(pool, ai, committee, ch.number), "forbidden");
      assert.equal(await rerunTriageNotes(pool, ai, member, ch.number), "not_found");
      assert.equal(await rerunTriageNotes(pool, ai, nsAdmin, ch.number), "ok");
      assert.equal((await pool.query(`select input_hash, requested_by from ai_results where parent_id = $1`, [ch.id])).rows[0].input_hash, null);
      assert.equal((await getTriageNotes(pool, ai, nsAdmin, ch.number))?.state, "pending");

      // The queue indicator.
      const q = await triageQueueNotes(pool, ai, nsAdmin.userId, [`CH-${ch.number}`, `CH-${dupVisible.number}`]);
      assert.equal(q.get(`CH-${ch.number}`), "pending");
      assert.equal(q.get(`CH-${dupVisible.number}`), null, "a valid challenge is not a subject");
      const own = await triageQueueNotes(pool, ai, authorAdmin.userId, [`CH-${ch.number}`]);
      assert.equal(own.get(`CH-${ch.number}`), null, "an author never learns a note exists");

      // Switch off: a note still shows read-only, nothing is pending, no Re-run.
      await writeNote(ch.id);
      await support.setSwitch(pool, "ai_triage_assist_enabled", false);
      view = await getTriageNotes(pool, ai, nsAdmin, ch.number);
      assert.equal(view?.state, "ready");
      assert.equal(view?.canRerun, false);
      assert.equal(await rerunTriageNotes(pool, ai, nsAdmin, ch.number), "unavailable");
      const noNote = await mk("No note, switch off", "in_review");
      assert.equal(await getTriageNotes(pool, ai, nsAdmin, noNote.number), null, "nothing to show while off");
      await support.setSwitch(pool, "ai_triage_assist_enabled", true);

      // A restricted challenge while restricted content may not be sent: said so, no Re-run.
      const restricted = await mk("Restricted subject", "in_review", "namespace");
      view = await getTriageNotes(pool, ai, nsAdmin, restricted.number);
      assert.equal(view?.restrictedBlocked, true);
      assert.equal(view?.state, "none");
      assert.equal(await rerunTriageNotes(pool, ai, nsAdmin, restricted.number), "unavailable");

      // Withdrawal deletes the note.
      const w = await mk("To withdraw", "in_review");
      await writeNote(w.id);
      assert.equal((await withdrawChallenge(pool, author, w.number)).status, "ok");
      assert.equal((await pool.query(`select 1 from ai_results where parent_id = $1`, [w.id])).rowCount, 0);
      assert.equal(await getTriageNotes(pool, ai, nsAdmin, w.number), null);

      // The §10.3 cascade deletes it with the challenge.
      const storage = {
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
      const deleted = await deleteChallenge({ pool, storage }, platform, ch.number, "dbtest cascade");
      assert.equal(deleted.status, "ok");
      if (deleted.status === "ok") assert.equal(deleted.counts.aiResults, 1);
      assert.equal((await pool.query(`select 1 from ai_results where parent_id = $1`, [ch.id])).rowCount, 0);
    } finally {
      await pool.query(`delete from ai_integration`).catch(() => {});
      await support.setSwitch(pool, "ai_triage_assist_enabled", false).catch(() => {});
      await stub.close();
      await pool.end();
    }
  },
);
