// Live-DB integration test (gated) for §43 mentions (INNOBOX_SPEC.md §43.11):
//   • a create with mentions stores tokens — never a name — writes one row per person, audits the
//     ids, and returns display text with each mention's range;
//   • the settling check: a reviewer mentioned on a `proposed` solution is told at once, anyone else
//     only when it leaves `proposed`, and exactly once; `proposed → rejected` tells nobody and a later
//     override to `in_review` does; an edit in `needs_improvement` tells a newly mentioned person on
//     save; a resubmit runs the check;
//   • event 26: an inbox row and one outbox row, never held for a digest; the sender named, or nobody
//     on an anonymous solution (inbox row, payload and e-mail subject) — and named again once the
//     author has revealed themselves; opening the challenge reads the row;
//   • silence: a co-author, a muted person, a deactivated one and one who lost sight of the challenge
//     are settled with no row; removing and re-adding a settled mention sends nothing;
//   • refusals: an ineligible person (cannot see the challenge, the saver, deactivated, unknown)
//     refuses the whole save and writes nothing; an existing mention survives its person's
//     deactivation through a later edit;
//   • the caps: the 11th person on a solution and the 31st of a UTC day refuse and write nothing,
//     yesterday's rows do not count, a cancelled pending mention frees its place, and two concurrent
//     saves cannot both take the last place;
//   • a save with no list (an agent's edit) keeps an untouched mention, drops a changed one and adds
//     none; a create with no list has none;
//   • search finds a solution by the words around a mention, never by the mentioned person's name;
//   • erasure deletes the person's rows, nulls `mentioned_by`, resets the preference and turns the
//     name into "@Deleted User" without touching the stored text; the §10.3 cascade removes the rows.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "mentions: save, settle, event 26, silence, refusals, caps, agent edits, search, erasure, cascade",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, MENTION_OPEN, MENTIONS_PER_DAY, MENTIONS_PER_SOLUTION, mentionedUserIds } = await import("@innobox/shared");
    const store = await import("./store");
    const { search } = await import("../search/store");
    const { scrubUser } = await import("../users/store");
    const { deleteSolution } = await import("./delete");
    const { notifyMentioned } = await import("../../../lib/notify-events");
    const { markCommentNotificationsReadForChallenge } = await import("../../../lib/notify");
    const { mentionRoomFor } = await import("../../../lib/mentions");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
            `dbtest-mention-${label}-${stamp}`,
            `Dbtest Mention ${label}`,
          ])
        ).rows[0]!.id;
      const nsId = await mkNs("main");
      const otherNsId = await mkNs("other");
      type Roles = ReturnType<typeof buildRoleSet>;
      type Person = { userId: string; roles: Roles; name: string };
      const rolesOf = new Map<string, Roles>();
      const roles = (role: "member" | "committee" | "namespace_admin", ns: string) => buildRoleSet([{ role, namespaceId: ns }], { globalNamespaceId: globalId });
      // The display name is two words; its second is unique to the person, so a search for it could
      // only ever match through a mention.
      const mkUser = async (label: string, r: Roles = roles("member", nsId)): Promise<Person> => {
        const name = `Dbm ${label}${stamp}`;
        const id = (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
            `dbtest-mention-${label}-${stamp}`,
            `dbtest-mention-${label}-${stamp}@example.test`,
            name,
          ])
        ).rows[0]!.id;
        rolesOf.set(id, r);
        return { userId: id, roles: r, name };
      };
      const resolveRoles = Object.assign(async (id: string) => rolesOf.get(id) ?? roles("member", globalId), {});
      const ctx = (actorId: string | null) => ({ pool, actorId, resolveRoles });
      const storage = { deleteObject: async () => {}, abortMultipartUpload: async () => {} };

      const author = await mkUser("author");
      const ana = await mkUser("ana");
      const bob = await mkUser("bob");
      const cy = await mkUser("cy");
      const dee = await mkUser("dee");
      const eve = await mkUser("eve");
      const co = await mkUser("co");
      const outsider = await mkUser("outsider", roles("member", otherNsId));
      const committee = await mkUser("committee", roles("committee", nsId));
      const nsAdmin = await mkUser("nsadmin", roles("namespace_admin", nsId));
      const platform = await mkUser("platform", buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }));
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
      const at = (p: Person) => `@${p.name}`;
      const cand = (...people: Person[]) => people.map((p) => ({ userId: p.userId, name: p.name }));

      const newChallenge = async (title: string, visibility: "org" | "namespace" = "org") => {
        const r = await store.createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `${title} ${stamp}`,
          description: "d",
          clientName: null,
          visibility,
          isAnonymous: false,
        });
        if (r.status !== "ok") throw new Error("create failed");
        const num = r.challenge.number.replace("CH-", "");
        assert.equal((await store.setChallengeStatus(pool, nsAdmin, num, "valid")).status, "ok");
        return { id: r.challenge.id, num };
      };
      type Candidates = { userId: string; name: string }[];
      const createRaw = (chNum: string, who: Person, description: string, candidates: Candidates | undefined, opts: { cost?: string | null; anonymous?: boolean; coAuthorIds?: string[] } = {}) =>
        store.createSolution(pool, who, chNum, {
          description,
          costVsBenefits: opts.cost ?? null,
          isAnonymous: opts.anonymous ?? false,
          ...(opts.coAuthorIds ? { coAuthors: { ids: opts.coAuthorIds, resolveRoles } } : {}),
          ...(candidates ? { mentions: { candidates, resolveRoles } } : {}),
        });
      const propose = async (chNum: string, who: Person, description: string, candidates: Candidates | undefined, opts: { cost?: string | null; anonymous?: boolean; coAuthorIds?: string[] } = {}) => {
        const r = await createRaw(chNum, who, description, candidates, opts);
        if (r.status !== "ok") throw new Error(`propose failed: ${r.status}`);
        await notifyMentioned(ctx(who.userId), r.solution.id, r.mentioned);
        return { id: r.solution.id, num: r.solution.number.replace("SOL-", ""), solution: r.solution };
      };
      const editedAtOf = async (solutionId: string) =>
        (await pool.query<{ edited_at: Date | null }>(`select edited_at from solutions where id = $1`, [solutionId])).rows[0]!.edited_at?.toISOString() ?? null;
      /** `candidates: undefined` sends no list — an agent's edit. */
      const editRaw = async (sol: { id: string; num: string }, who: Person, description: string, candidates: Candidates | undefined, cost: string | null = null) =>
        store.editSolution(pool, who, sol.num, {
          description,
          costVsBenefits: cost,
          baseEditedAt: await editedAtOf(sol.id),
          ...(candidates ? { mentions: { candidates, resolveRoles } } : {}),
        });
      const edit = async (sol: { id: string; num: string }, who: Person, description: string, candidates: Candidates | undefined, cost: string | null = null) => {
        const r = await editRaw(sol, who, description, candidates, cost);
        if (r.status !== "ok") throw new Error(`edit failed: ${r.status}`);
        await notifyMentioned(ctx(who.userId), sol.id, r.mentioned);
        return r.solution;
      };
      const move = async (actor: Person, sol: { id: string; num: string }, status: string) => {
        const r = await store.setSolutionStatus(pool, actor, sol.num, status, resolveRoles);
        if (r.status !== "ok") throw new Error(`move to ${status} failed: ${r.status}`);
        await notifyMentioned(ctx(actor.userId), sol.id, r.mentioned);
        return r;
      };
      const rowsOf = async (solutionId: string) =>
        (await pool.query<{ user_id: string; mentioned_by: string | null; settled: boolean }>(
          `select user_id, mentioned_by, settled_at is not null as settled from solution_mentions where solution_id = $1 order by created_at, user_id`,
          [solutionId],
        )).rows;
      const rowOf = async (solutionId: string, person: Person) => (await rowsOf(solutionId)).find((r) => r.user_id === person.userId);
      const storedOf = async (solutionId: string) =>
        (await pool.query<{ description: string; cost_vs_benefits: string | null }>(`select description, cost_vs_benefits from solutions where id = $1`, [solutionId])).rows[0]!;
      const inbox = async (person: Person) =>
        (await pool.query<{ id: string; payload: Record<string, unknown>; read_at: Date | null; challenge_id: string | null; solution_id: string | null }>(
          `select id, payload, read_at, challenge_id, solution_id from notifications where user_id = $1 and type = 'mentioned' order by id`,
          [person.userId],
        )).rows;
      const outbox = async (person: Person) =>
        (await pool.query<{ digest_due_at: Date | null; payload: Record<string, unknown> }>(
          `select digest_due_at, payload from notification_outbox where user_id = $1 and type = 'mentioned'`,
          [person.userId],
        )).rows;
      const sentToday = async (person: Person) =>
        (await pool.query<{ n: number }>(`select count(*)::int as n from solution_mentions where mentioned_by = $1 and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`, [person.userId])).rows[0]!.n;

      const ch = await newChallenge("Main");
      const word = `kiwi${stamp}`;

      // ── A create with mentions: tokens in the stored text, display text and ranges in the answer. ──
      // The committee member takes a daily digest: event 26 is actionable, so it is never held.
      await pool.query(`update users set email_delivery = 'daily' where id = $1`, [committee.userId]);
      const s1 = await propose(ch.num, ana, `The ${word} plan needs ${at(bob)}'s API.`, cand(bob, committee), { cost: `Ask ${at(committee)} about the budget.` });
      const s1Stored = await storedOf(s1.id);
      assert.equal(s1Stored.description.includes(bob.name), false, "the stored text holds no name");
      assert.deepEqual(mentionedUserIds(s1Stored.description, s1Stored.cost_vs_benefits), [bob.userId, committee.userId]);
      assert.equal(s1.solution.description, `The ${word} plan needs ${at(bob)}'s API.`, "the answer carries display text");
      assert.equal(s1.solution.description.includes(MENTION_OPEN), false, "no response carries a token");
      assert.deepEqual(
        s1.solution.mentions.map((m) => [m.field, m.user?.id, (m.field === "description" ? s1.solution.description : s1.solution.costVsBenefits!).slice(m.start, m.start + m.length)]),
        [
          ["description", bob.userId, at(bob)],
          ["costVsBenefits", committee.userId, at(committee)],
        ],
      );
      const { rows: created } = await pool.query<{ after: Record<string, unknown> }>(
        `select after from audit_log where action = 'solution.created' and target_id = $1`,
        [s1.id],
      );
      assert.deepEqual(created[0]!.after.mentions, [bob.userId, committee.userId], "the create's audit row lists the ids");

      // ── The check on a `proposed` solution: the reviewer is told at once, the member waits. ──
      assert.deepEqual((await rowsOf(s1.id)).map((r) => [r.user_id, r.mentioned_by, r.settled]).sort(), [
        [bob.userId, ana.userId, false],
        [committee.userId, ana.userId, true],
      ].sort());
      const committeeRows = await inbox(committee);
      assert.equal(committeeRows.length, 1);
      assert.equal(committeeRows[0]!.payload.message, `${ana.name} mentioned you in SOL-${s1.num} on CH-${ch.num} "Main ${stamp}".`);
      assert.equal(committeeRows[0]!.payload.link, `/challenges/${ch.num}#SOL-${s1.num}`);
      assert.equal(committeeRows[0]!.payload.mentionerId, ana.userId);
      assert.deepEqual([committeeRows[0]!.challenge_id, committeeRows[0]!.solution_id], [ch.id, s1.id], "the row carries its item, so the read-time gates apply");
      const committeeMail = await outbox(committee);
      assert.equal(committeeMail.length, 1);
      assert.equal(committeeMail[0]!.digest_due_at, null, "never held for a digest");
      assert.equal(committeeMail[0]!.payload.subject, `${ana.name} mentioned you in SOL-${s1.num}`);
      assert.equal((await inbox(bob)).length, 0, "a member cannot see a proposed solution, so he is not told yet");

      // ── Leaving `proposed` tells everyone still pending — once. ──
      await move(committee, s1, "in_review");
      assert.equal((await inbox(bob)).length, 1);
      assert.equal((await rowOf(s1.id, bob))!.settled, true);
      await move(committee, s1, "valid");
      assert.equal((await inbox(bob)).length, 1, "a later move adds nothing");
      assert.equal((await inbox(committee)).length, 1);

      // Opening the challenge reads the row (§12.1 read action).
      await markCommentNotificationsReadForChallenge(pool, bob.userId, ch.id);
      assert.ok((await inbox(bob))[0]!.read_at, "opening the challenge reads the mention");

      // ── A closed solution tells nobody; an override that reopens it does. ──
      const s2 = await propose(ch.num, ana, `Second idea, ask ${at(cy)}.`, cand(cy));
      await move(committee, s2, "rejected");
      assert.equal((await inbox(cy)).length, 0, "proposed → rejected settles nobody");
      assert.equal((await rowOf(s2.id, cy))!.settled, false);
      await move(nsAdmin, s2, "in_review");
      assert.equal((await inbox(cy)).length, 1, "the override reopened it");

      // ── An edit in needs_improvement tells a newly mentioned person on save. ──
      const s3 = await propose(ch.num, ana, "Third idea.", cand());
      await move(committee, s3, "in_review");
      await move(committee, s3, "needs_improvement");
      const s3Text = `Third idea, with ${at(dee)}.`;
      const s3Edited = await edit(s3, ana, s3Text, cand(dee));
      assert.equal(s3Edited.description, s3Text);
      assert.equal((await inbox(dee)).length, 1, "told at the save");
      const { rows: edits } = await pool.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
        `select before, after from audit_log where action = 'solution.edited' and target_id = $1 order by id`,
        [s3.id],
      );
      assert.deepEqual(edits[0]!.after.mentionsAdded, [dee.userId]);
      assert.equal(edits[0]!.after.description, `Third idea, with @[user:${dee.userId}].`, "an audited text carries the id, never the name");

      // Removing a settled mention keeps its row; adding it back sends nothing.
      await edit(s3, ana, s3Text, cand());
      assert.equal(mentionedUserIds((await storedOf(s3.id)).description).length, 0, "the name is ordinary text now");
      assert.equal((await rowOf(s3.id, dee))!.settled, true, "a settled row is the once-ever marker");
      await edit(s3, ana, s3Text, cand(dee));
      assert.deepEqual(mentionedUserIds((await storedOf(s3.id)).description), [dee.userId]);
      assert.equal((await inbox(dee)).length, 1, "told once per solution, ever");

      // A resubmit is a status change: the check runs (nothing is pending here, so nothing is sent).
      const resubmitted = await store.resubmitSolution(pool, ana, s3.num);
      assert.equal(resubmitted.status, "ok");
      if (resubmitted.status === "ok") assert.deepEqual(resubmitted.mentioned, []);

      // ── A pending mention taken out of the text is cancelled and frees its place. ──
      const s4 = await propose(ch.num, ana, `Fourth, ${at(eve)} knows.`, cand(eve));
      const before = await sentToday(ana);
      await edit(s4, ana, "Fourth, on reflection nobody knows.", cand());
      assert.equal(await rowOf(s4.id, eve), undefined, "the pending row is gone");
      assert.equal(await sentToday(ana), before - 1, "its place under the daily cap is free again");
      await move(committee, s4, "in_review");
      assert.equal((await inbox(eve)).length, 0, "a cancelled mention never notifies");

      // ── Refusals: one answer for every reason, and nothing written. ──
      const restricted = await newChallenge("Restricted", "namespace");
      const countSolutions = async () => (await pool.query<{ n: number }>(`select count(*)::int as n from solutions where author_id = $1`, [ana.userId])).rows[0]!.n;
      const solutionsBefore = await countSolutions();
      const gone = await mkUser("gone");
      await pool.query(`update users set active = false where id = $1`, [gone.userId]);
      for (const [why, description, candidates] of [
        ["cannot see the challenge", `Ask ${at(outsider)}.`, cand(outsider)],
        ["the saver", `Ask ${at(ana)}.`, cand(ana)],
        ["deactivated", `Ask ${at(gone)}.`, cand(gone)],
        ["unknown", "Ask @Nobody Atall.", [{ userId: randomUUID(), name: "Nobody Atall" }]],
        ["one bad person among good ones", `Ask ${at(bob)} and ${at(outsider)}.`, cand(bob, outsider)],
      ] as const) {
        assert.deepEqual(await createRaw(restricted.num, ana, description, [...candidates]), { status: "ineligible_mention" }, why);
      }
      assert.equal(await countSolutions(), solutionsBefore, "a refused save writes nothing");

      // An existing mention survives its person's deactivation and loss of access through a later edit.
      const leaver = await mkUser("leaver");
      const s5 = await propose(restricted.num, ana, `Restricted idea for ${at(leaver)}.`, cand(leaver));
      await pool.query(`update users set active = false where id = $1`, [leaver.userId]);
      rolesOf.set(leaver.userId, roles("member", otherNsId));
      const s5Kept = await editRaw(s5, ana, `Restricted idea, reworded, for ${at(leaver)}.`, cand(leaver));
      assert.equal(s5Kept.status, "ok", "an edit that keeps an existing mention is not refused");
      assert.deepEqual(mentionedUserIds((await storedOf(s5.id)).description), [leaver.userId]);
      // …and a newly mentioned ineligible person in an edit refuses it, leaving the text as it was.
      const s5Before = await storedOf(s5.id);
      assert.deepEqual(await editRaw(s5, ana, `Now for ${at(outsider)}.`, cand(outsider)), { status: "ineligible_mention" });
      assert.deepEqual(await storedOf(s5.id), s5Before);

      // ── Silence: settled, with no inbox row. ──
      const muted = await mkUser("muted");
      await pool.query(`update users set notify_mentions = false where id = $1`, [muted.userId]);
      const lost = await mkUser("lost");
      const off = await mkUser("off");
      const s6 = await propose(
        restricted.num,
        ana,
        `For ${at(co)}, ${at(muted)}, ${at(lost)} and ${at(off)}.`,
        cand(co, muted, lost, off),
        { coAuthorIds: [co.userId] },
      );
      assert.equal((await rowOf(s6.id, co))!.settled, true, "a co-author can see a proposed solution — settled at the create");
      assert.equal((await inbox(co)).length, 0, "the solution's own team is never notified by a mention");
      rolesOf.set(lost.userId, roles("member", otherNsId));
      await pool.query(`update users set active = false where id = $1`, [off.userId]);
      await move(committee, s6, "in_review");
      for (const person of [muted, lost, off]) {
        assert.equal((await rowOf(s6.id, person))!.settled, true, `${person.name} is settled`);
        assert.equal((await inbox(person)).length, 0, `${person.name} is passed over in silence`);
      }
      // Switching the preference back on brings back nothing already settled.
      await pool.query(`update users set notify_mentions = true where id = $1`, [muted.userId]);
      await move(committee, s6, "valid");
      assert.equal((await inbox(muted)).length, 0);

      // ── An anonymous solution's notice names nobody — until the author reveals themselves. ──
      const anon = await mkUser("anon");
      const fay = await mkUser("fay");
      const s7 = await propose(ch.num, anon, `Quietly, ${at(committee)} and ${at(fay)} should look.`, cand(committee, fay), { anonymous: true });
      const anonNotice = (await inbox(committee)).find((r) => r.solution_id === s7.id)!;
      assert.equal(anonNotice.payload.message, `You were mentioned in SOL-${s7.num} on CH-${ch.num} "Main ${stamp}".`);
      assert.equal(anonNotice.payload.mentionerId, null);
      assert.equal(anonNotice.payload.mentionerName, null);
      const anonMail = (await outbox(committee)).find((r) => r.payload.parentId === s7.id)!;
      assert.equal(anonMail.payload.subject, `You were mentioned in SOL-${s7.num}`);
      for (const payload of [anonNotice.payload, anonMail.payload]) {
        const text = JSON.stringify(payload);
        assert.equal(text.includes(anon.name), false, "the payload never names an anonymous author");
        assert.equal(text.includes(anon.userId), false, "…nor carries their id");
      }
      assert.equal((await store.selfRevealSolution(pool, anon, s7.num)).status, "ok");
      assert.equal((await inbox(fay)).length, 0, "a self-reveal sends nothing");
      await move(committee, s7, "in_review");
      assert.equal((await inbox(fay))[0]!.payload.message, `${anon.name} mentioned you in SOL-${s7.num} on CH-${ch.num} "Main ${stamp}".`, "a revealed author is named");

      // ── The caps. ──
      const crowd: Person[] = [];
      for (let i = 0; i < MENTIONS_PER_SOLUTION + 1; i += 1) crowd.push(await mkUser(`crowd${String.fromCharCode(97 + i)}`));
      const zed = await mkUser("zed");
      const ten = crowd.slice(0, MENTIONS_PER_SOLUTION);
      const s8 = await propose(ch.num, zed, `Everyone: ${ten.map(at).join(", ")}.`, cand(...ten));
      assert.equal((await rowsOf(s8.id)).length, MENTIONS_PER_SOLUTION, "the 10th person is allowed");
      const s8Before = await storedOf(s8.id);
      const eleventh = crowd[MENTIONS_PER_SOLUTION]!;
      assert.deepEqual(await editRaw(s8, zed, `Everyone: ${crowd.map(at).join(", ")}.`, cand(...crowd)), { status: "mention_cap", reason: "solution_cap" }, "the 11th is refused");
      assert.deepEqual(await storedOf(s8.id), s8Before, "a save over the cap writes nothing — not the text, not the rows");
      assert.equal((await rowsOf(s8.id)).length, MENTIONS_PER_SOLUTION);
      // A settled person taken out of the text still counts toward the 10.
      await move(committee, s8, "in_review");
      await move(committee, s8, "needs_improvement");
      await edit(s8, zed, `Fewer now: ${ten.slice(0, 9).map(at).join(", ")}.`, cand(...ten.slice(0, 9)));
      assert.equal((await rowsOf(s8.id)).length, MENTIONS_PER_SOLUTION, "the settled row stays");
      assert.deepEqual(await editRaw(s8, zed, `Fewer now: ${ten.slice(0, 9).map(at).join(", ")} and ${at(eleventh)}.`, cand(...ten.slice(0, 9), eleventh)), {
        status: "mention_cap",
        reason: "solution_cap",
      });
      assert.equal((await mentionRoomFor(pool, zed.userId, [s8.id])).left.get(s8.id), 0);

      // The daily cap: zed has used 10 today; 19 more rows on other solutions make 29.
      const fillers = [s1.id, s2.id];
      let made = 0;
      for (const solutionId of fillers) {
        for (const person of ten) {
          if (made === MENTIONS_PER_DAY - MENTIONS_PER_SOLUTION - 1) break;
          await pool.query(`insert into solution_mentions (solution_id, user_id, mentioned_by, settled_at) values ($1, $2, $3, now())`, [solutionId, person.userId, zed.userId]);
          made += 1;
        }
      }
      assert.equal(await sentToday(zed), MENTIONS_PER_DAY - 1);
      assert.equal((await mentionRoomFor(pool, zed.userId, [])).leftToday, 1);
      // Two concurrent saves, each for the last place: exactly one takes it.
      const [raceA, raceB] = await Promise.all([
        createRaw(ch.num, zed, `Race A: ${at(bob)}.`, cand(bob)),
        createRaw(ch.num, zed, `Race B: ${at(cy)}.`, cand(cy)),
      ]);
      assert.deepEqual([raceA.status, raceB.status].sort(), ["mention_cap", "ok"], "the 30th of the day is allowed, the 31st refused");
      const refused = raceA.status === "ok" ? raceB : raceA;
      assert.deepEqual(refused, { status: "mention_cap", reason: "daily_cap" });
      assert.equal(await sentToday(zed), MENTIONS_PER_DAY);
      // Yesterday's rows do not count.
      await pool.query(`update solution_mentions set created_at = created_at - interval '1 day' where mentioned_by = $1`, [zed.userId]).catch(async () => {
        // The app role may not update created_at; the owner connection of the throwaway database can.
        const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
        try {
          await owner.query(`update solution_mentions set created_at = created_at - interval '1 day' where mentioned_by = $1`, [zed.userId]);
        } finally {
          await owner.end();
        }
      });
      assert.equal(await sentToday(zed), 0);
      assert.equal((await createRaw(ch.num, zed, `A new day: ${at(dee)}.`, cand(dee))).status, "ok");

      // ── A save with no list — an agent's edit — keeps what it leaves alone and adds nobody. ──
      const s9 = await propose(ch.num, ana, `Agent case: ${at(bob)} and ${at(cy)}.`, cand(bob, cy));
      const agentKept = await editRaw(s9, ana, `Agent case, reworded: ${at(bob)} and @Someone Else, plus ${at(dee)}.`, undefined);
      assert.equal(agentKept.status, "ok");
      assert.deepEqual(mentionedUserIds((await storedOf(s9.id)).description), [bob.userId], "the untouched mention is kept; the changed one is dropped; nobody is added");
      assert.equal(await rowOf(s9.id, cy), undefined, "the dropped mention was still pending, so it is cancelled");
      assert.equal(await rowOf(s9.id, dee), undefined, "an agent mentions nobody new");
      const s10 = await propose(ch.num, ana, `No list here, just ${at(bob)} as text.`, undefined);
      assert.equal(mentionedUserIds((await storedOf(s10.id)).description).length, 0, "a create with no list has no mentions");
      assert.equal((await rowsOf(s10.id)).length, 0);

      // ── Search: by the words around a mention, never by the mentioned person's name. ──
      const byWord = await search(pool, bob, word);
      const hit = byWord.solutions.find((s) => s.number === `SOL-${s1.num}`);
      assert.ok(hit, "found by a word of the text");
      assert.equal(hit!.description, `The ${word} plan needs ${at(bob)}'s API.`, "a hit shows display text");
      const byName = await search(pool, bob, `bob${stamp}`);
      assert.equal(byName.solutions.some((s) => s.number === `SOL-${s1.num}`), false, "not found by the mentioned person's name");

      // No detail read carries a token.
      const detail = await store.getChallengeByNumber(pool, nsAdmin, ch.num);
      assert.ok(detail);
      assert.equal(JSON.stringify(detail).includes(MENTION_OPEN), false);

      // ── Erasure: rows gone, sender nulled, preference reset, text untouched, the name gone. ──
      const sender = await mkUser("sender");
      const s11 = await propose(ch.num, sender, `Erasure case: ${at(eve)}.`, cand(eve));
      assert.equal((await rowOf(s11.id, eve))!.mentioned_by, sender.userId);
      await pool.query(`update users set notify_mentions = false where id = $1`, [dee.userId]);
      const s3StoredBefore = await storedOf(s3.id);
      assert.equal((await scrubUser(pool, platform.userId, dee.userId)).status, "ok");
      assert.equal((await pool.query(`select 1 from solution_mentions where user_id = $1`, [dee.userId])).rows.length, 0, "erasure deletes the rows that name the person");
      assert.deepEqual(await storedOf(s3.id), s3StoredBefore, "no solution text is rewritten");
      const s3After = (await store.getChallengeByNumber(pool, nsAdmin, ch.num))!.solutions.find((s) => s.id === s3.id)!;
      assert.equal(s3After.description, "Third idea, with @Deleted User.");
      assert.equal(s3After.mentions[0]!.user, null, "an erased person's mention names nobody");
      assert.equal((await pool.query<{ notify_mentions: boolean }>(`select notify_mentions from users where id = $1`, [dee.userId])).rows[0]!.notify_mentions, true, "the preference is reset");
      assert.equal((await scrubUser(pool, platform.userId, sender.userId)).status, "ok");
      assert.equal((await rowOf(s11.id, eve))!.mentioned_by, null, "the rows an erased person wrote lose their sender");
      await move(committee, s11, "in_review");
      const eveNotice = (await inbox(eve)).find((r) => r.solution_id === s11.id)!;
      assert.equal(eveNotice.payload.message, `You were mentioned in SOL-${s11.num} on CH-${ch.num} "Main ${stamp}".`, "an erased sender is not named");

      // ── The §10.3 cascade removes the rows and the notices. ──
      const purged = await deleteSolution({ pool, storage } as never, platform, s1.num, "dbtest cleanup");
      assert.equal(purged.status, "ok");
      assert.equal((await rowsOf(s1.id)).length, 0);
      assert.equal((await inbox(bob)).filter((r) => r.solution_id === s1.id).length, 0);
    } finally {
      await pool.end();
    }
  },
);
