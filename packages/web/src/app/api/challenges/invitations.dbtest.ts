// Live-DB integration test (gated) for §40 invite a solver (INNOBOX_SPEC.md §40.11):
//   • a send writes one row and one audit row per invitee (never the note), all-or-nothing;
//     a repeat pair, the caller, a visible author, a deactivated person and someone who cannot see
//     a restricted challenge are refused with the one message; a challenge that is not open refuses;
//   • the caps: the 6th on a challenge and the 21st of a UTC day refuse; yesterday's do not count;
//     two concurrent sends cannot both take the last place;
//   • the picker leaves out the caller, the people they invited and a visible author — and still
//     offers someone another inviter invited;
//   • event 22: an inbox row (with the quoted note) and one outbox row, never held; a second one
//     about the same challenge the same UTC day is in-app only; the mute, Not for me and a
//     deactivated invitee write nothing; opening the challenge and Not for me read it;
//   • the detail fields: canInvite, the inviter's own list and room, the invitee's open invitations
//     newest first — gone once answered, after a dismissal and out of `valid`;
//   • the payoff on every path out of `proposed` (enforced, withdrawal, the §8.3 auto-close), every
//     inviter credited once, a second solution adding nothing; never for a solution created before the
//     invitation, with the inviter on the team, or for a later joiner; a form co-author counts; an
//     anonymous solution waits for its self-reveal and is backdated; invite_fulfilled is 0 points and
//     never via_mcp; Matchmaker Bronze; event 23 in-app only, written with gamification off, dropped
//     for an inviter who lost sight of the challenge (their ledger row stays); nothing revoked;
//   • the §10.3 cascade removes the rows and leaves the ledger; erasure removes sent and received
//     invitations and dismissals and resets the preference.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "invitations: send, caps, picker, event 22, banner, payoff, event 23, Matchmaker, cascade, erasure",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, INVITE_NOTE_INBOX_MAX } = await import("@innobox/shared");
    const store = await import("./store");
    const inv = await import("./invitations");
    const { searchActiveUsers, scrubUser } = await import("../users/store");
    const { deleteChallenge, deleteSolution } = await import("./delete");
    const { notifyInvited, notifyInvitationPayoffs } = await import("../../../lib/notify-events");
    const { markCommentNotificationsReadForChallenge } = await import("../../../lib/notify");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkNs = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
            `dbtest-invite-${label}-${stamp}`,
            `Dbtest Invite ${label}`,
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
            `dbtest-invite-${label}-${stamp}`,
            `dbtest-invite-${label}-${stamp}@example.test`,
            `Dbtest invite ${label} ${stamp}`,
          ])
        ).rows[0]!.id;
        rolesOf.set(id, r);
        return { userId: id, roles: r };
      };
      const resolveRoles = Object.assign(async (id: string) => rolesOf.get(id) ?? roles("member", globalId), {});
      const ctx = (actorId: string | null) => ({ pool, actorId, resolveRoles });
      const storage = { deleteObject: async () => {}, abortMultipartUpload: async () => {} };

      const author = await mkUser("author");
      const ana = await mkUser("ana");
      const bob = await mkUser("bob");
      const cy = await mkUser("cy");
      const eve = await mkUser("eve");
      const fred = await mkUser("fred");
      const outsider = await mkUser("outsider", roles("member", otherNsId));
      const committee = await mkUser("committee", roles("committee", nsId));
      const nsAdmin = await mkUser("nsadmin", roles("namespace_admin", nsId));
      const platform = await mkUser("platform", buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }));
      const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;

      const newChallenge = async (title: string, opts: { visibility?: "org" | "namespace"; valid?: boolean } = {}) => {
        const r = await store.createChallenge(pool, author, {
          impactAreaId: internal.id,
          namespaceId: nsId,
          title: `${title} ${stamp}`,
          description: "d",
          clientName: null,
          visibility: opts.visibility ?? "org",
          isAnonymous: false,
        });
        if (r.status !== "ok") throw new Error("create failed");
        const num = r.challenge.number.replace("CH-", "");
        if (opts.valid !== false) assert.equal((await store.setChallengeStatus(pool, nsAdmin, num, "valid")).status, "ok");
        return { id: r.challenge.id, num };
      };
      const propose = async (chNum: string, who: { userId: string; roles: Roles }, opts: { anonymous?: boolean; coAuthorIds?: string[]; via?: { clientName: string } } = {}) => {
        const r = await store.createSolution(
          pool,
          who,
          chNum,
          {
            description: `Solution ${stamp}`,
            costVsBenefits: null,
            isAnonymous: opts.anonymous ?? false,
            ...(opts.coAuthorIds ? { coAuthors: { ids: opts.coAuthorIds, resolveRoles } } : {}),
          },
          opts.via,
        );
        if (r.status !== "ok") throw new Error(`propose failed: ${r.status}`);
        return { id: r.solution.id, num: r.solution.number.replace("SOL-", "") };
      };
      const send = (who: { userId: string; roles: Roles }, chNum: string, userIds: string[], note: string | null = null) =>
        inv.sendInvitations(pool, who, chNum, { userIds, note }, resolveRoles);
      const sendOk = async (who: { userId: string; roles: Roles }, chNum: string, userIds: string[], note: string | null = null) => {
        const r = await send(who, chNum, userIds, note);
        assert.equal(r.status, "ok", `send to ${userIds.length} should succeed`);
        if (r.status !== "ok") throw new Error("send failed");
        await notifyInvited(ctx(who.userId), r.challengeId, r.created);
        return r;
      };
      const rowsFor = async (challengeId: string) =>
        (await pool.query<{ inviter_id: string; invitee_id: string; note: string | null; paid_off_at: Date | null }>(
          `select inviter_id, invitee_id, note, paid_off_at from challenge_invitations where challenge_id = $1 order by id`,
          [challengeId],
        )).rows;
      const inbox = async (userId: string, type: string) =>
        (await pool.query<{ id: string; payload: Record<string, unknown>; read_at: Date | null }>(
          `select id, payload, read_at from notifications where user_id = $1 and type = $2 order by id`,
          [userId, type],
        )).rows;
      const outbox = async (userId: string, type: string) =>
        (await pool.query<{ digest_due_at: Date | null }>(`select digest_due_at from notification_outbox where user_id = $1 and type = $2`, [userId, type])).rows;
      const ledger = async (userId: string) =>
        (await pool.query<{ points: number; item_id: string; via_mcp: boolean; award_key: string; occurred_at: Date }>(
          `select points, item_id, via_mcp, award_key, occurred_at from gamification_ledger where user_id = $1 and reason = 'invite_fulfilled' order by id`,
          [userId],
        )).rows;
      const detailFor = async (who: { userId: string; roles: Roles }, num: string) => {
        const d = await store.getChallengeByNumber(pool, who, num);
        if (!d) throw new Error("detail not visible");
        return inv.invitationDetailFields(pool, who, d);
      };

      // ── A challenge that does not accept solutions refuses; one the caller cannot see is not found. ──
      const triage = await newChallenge("Triage", { valid: false });
      assert.deepEqual(await send(nsAdmin, triage.num, [bob.userId]), { status: "not_open" });
      assert.deepEqual(await send(ana, triage.num, [bob.userId]), { status: "not_found" }, "awaiting triage is hidden from a member");

      // ── A send: rows, audit rows without the note, event 22 with the quoted note. ──
      const ch = await newChallenge("Main");
      // Bob takes a daily digest: event 22 is actionable, so it is never held for one.
      await pool.query(`update users set email_delivery = 'daily' where id = $1`, [bob.userId]);
      const longNote = `You built the cost model last year. ${"x".repeat(300)}`;
      const first = await sendOk(ana, ch.num, [bob.userId], longNote);
      assert.equal(first.sent, 1);
      assert.deepEqual(first.invitations.sent.map((p) => p.id), [bob.userId]);
      assert.equal(first.invitations.left, 4);
      assert.deepEqual((await rowsFor(ch.id)).map((r) => [r.inviter_id, r.invitee_id, r.note]), [[ana.userId, bob.userId, longNote]]);
      const { rows: audit } = await pool.query<{ after: Record<string, unknown>; target_id: string }>(
        `select after, target_id from audit_log where action = 'invitation.sent' and actor_user_id = $1`,
        [ana.userId],
      );
      assert.deepEqual(audit.map((a) => a.after), [{ inviteeId: bob.userId, withNote: true }], "the audit row never carries the note");
      assert.equal(audit[0]!.target_id, ch.id);
      const bobRows = await inbox(bob.userId, "invitation");
      assert.equal(bobRows.length, 1);
      assert.match(String(bobRows[0]!.payload.message), new RegExp(`invited you to propose a solution to CH-${ch.num}`));
      assert.ok(String(bobRows[0]!.payload.detail).length <= INVITE_NOTE_INBOX_MAX + 2, "the bell's note line is cut");
      assert.deepEqual(await outbox(bob.userId, "invitation"), [{ digest_due_at: null }], "e-mailed, never held for a digest");

      // A second invitation about the same challenge on the same UTC day: in-app only.
      await sendOk(cy, ch.num, [bob.userId], "Second nudge");
      assert.equal((await inbox(bob.userId, "invitation")).length, 2);
      assert.equal((await outbox(bob.userId, "invitation")).length, 1, "at most one e-mail per person per challenge a day");

      // ── Refusals — one answer for every reason, and nothing written. ──
      for (const ids of [[bob.userId], [ana.userId], [author.userId], [cy.userId, bob.userId]]) {
        assert.deepEqual(await send(ana, ch.num, ids), { status: "ineligible" }, `refused: ${ids.join(",")}`);
      }
      const leaver = await mkUser("leaver");
      await pool.query(`update users set active = false where id = $1`, [leaver.userId]);
      assert.deepEqual(await send(ana, ch.num, [leaver.userId]), { status: "ineligible" }, "a deactivated person");
      assert.equal((await rowsFor(ch.id)).length, 2, "an all-or-nothing refusal writes nothing");
      const restricted = await newChallenge("Restricted", { visibility: "namespace" });
      assert.deepEqual(await send(ana, restricted.num, [outsider.userId]), { status: "ineligible" }, "an invitation never widens visibility");
      assert.equal((await send(ana, restricted.num, [cy.userId])).status, "ok", "a namespace member can be invited");

      // ── The picker: the caller, their invitees and a visible author are left out. ──
      const audience = await inv.getInvitePickerAudience(pool, ana, `CH-${ch.num}`);
      assert.ok(audience);
      const offered = (await searchActiveUsers(pool, stamp, undefined, { ...audience!, callerId: ana.userId })).map((u) => u.id);
      assert.ok(!offered.includes(ana.userId) && !offered.includes(bob.userId) && !offered.includes(author.userId));
      assert.ok(offered.includes(cy.userId), "someone the caller has not invited is offered");
      const cyAudience = await inv.getInvitePickerAudience(pool, cy, `CH-${ch.num}`);
      const cyOffered = (await searchActiveUsers(pool, stamp, undefined, { ...cyAudience!, callerId: cy.userId })).map((u) => u.id);
      assert.ok(!cyOffered.includes(bob.userId) && cyOffered.includes(ana.userId), "only the caller's own invitations are filtered on");
      assert.equal(await inv.getInvitePickerAudience(pool, ana, `CH-${triage.num}`), null, "no picker off an open challenge");

      // ── The caps. ──
      const capped = await newChallenge("Caps");
      const four = await Promise.all(["c1", "c2", "c3", "c4"].map((l) => mkUser(l)));
      await sendOk(eve, capped.num, four.map((u) => u.userId));
      const [lastA, lastB] = await Promise.all([mkUser("c5"), mkUser("c6")]);
      const raced = await Promise.all([send(eve, capped.num, [lastA.userId]), send(eve, capped.num, [lastB.userId])]);
      assert.deepEqual(raced.map((r) => r.status).sort(), ["challenge_cap", "ok"], "two concurrent sends cannot both take the fifth place");
      const sixth = await mkUser("c7");
      assert.deepEqual(await send(eve, capped.num, [sixth.userId]), { status: "challenge_cap" });

      const daily = await Promise.all(Array.from({ length: 20 }, (_, i) => mkUser(`d${i}`)));
      const dayCh = await newChallenge("Daily");
      await pool.query(`insert into challenge_invitations (challenge_id, inviter_id, invitee_id) select $1, $2, u from unnest($3::uuid[]) as u`, [
        dayCh.id,
        fred.userId,
        daily.map((u) => u.userId),
      ]);
      const another = await newChallenge("Daily2");
      assert.deepEqual(await send(fred, another.num, [bob.userId]), { status: "daily_cap" }, "the 21st of a UTC day");
      await pool.query(`update challenge_invitations set created_at = now() - interval '1 day' where inviter_id = $1`, [fred.userId]);
      assert.equal((await send(fred, another.num, [bob.userId])).status, "ok", "yesterday's invitations do not count");

      // ── The detail fields: the inviter's own list, the invitee's open invitations, newest first. ──
      const anaFields = await detailFor(ana, ch.num);
      assert.equal(anaFields.canInvite, true);
      assert.deepEqual(anaFields.invitations?.sent.map((p) => p.id), [bob.userId]);
      assert.equal(anaFields.invited, null, "nobody invited ana");
      const bobFields = await detailFor(bob, ch.num);
      assert.deepEqual(bobFields.invited?.inviters.map((i) => [i.id, i.note]), [
        [cy.userId, "Second nudge"],
        [ana.userId, longNote],
      ]);

      // Opening the challenge reads event 22; Not for me hides the banner and silences later ones.
      await markCommentNotificationsReadForChallenge(pool, bob.userId, ch.id);
      assert.ok((await inbox(bob.userId, "invitation")).every((r) => r.read_at !== null));
      assert.deepEqual(await inv.dismissInvitations(pool, outsider, ch.num), { status: "no_invitation" });
      assert.deepEqual(await inv.dismissInvitations(pool, bob, ch.num), { status: "ok" });
      assert.deepEqual(await inv.dismissInvitations(pool, bob, ch.num), { status: "ok" }, "a repeat succeeds");
      assert.equal((await detailFor(bob, ch.num)).invited, null);
      await sendOk(eve, ch.num, [bob.userId]);
      assert.equal((await inbox(bob.userId, "invitation")).length, 2, "a silenced invitation writes no event 22");
      assert.equal((await rowsFor(ch.id)).length, 3, "but it is recorded");

      // The mute: no row at all.
      await pool.query(`update users set notify_invitations = false where id = $1`, [cy.userId]);
      await sendOk(eve, ch.num, [cy.userId]);
      assert.equal((await inbox(cy.userId, "invitation")).filter((r) => r.payload.challengeId === ch.id).length, 0, "muted");

      // Out of `valid`: the button and the banner go; the invitations stay.
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, ch.num, "in_review")).status, "ok");
      assert.deepEqual(await detailFor(ana, ch.num), { canInvite: false, invitations: null, invited: null });
      assert.equal((await rowsFor(ch.id)).length, 4);
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, ch.num, "valid")).status, "ok");

      // ── The payoff: on leaving `proposed`, every inviter once, 0 points, Matchmaker, event 23. ──
      const pay = await newChallenge("Pay");
      const gus = await mkUser("gus");
      await sendOk(ana, pay.num, [gus.userId]);
      await sendOk(cy, pay.num, [gus.userId]);
      const sol1 = await propose(pay.num, gus);
      assert.equal((await detailFor(gus, pay.num)).invited, null, "answered: the banner goes at once");
      assert.ok((await rowsFor(pay.id)).every((r) => r.paid_off_at === null), "nothing while the solution is still proposed");
      const moved = await store.setSolutionStatus(pool, committee, sol1.num, "in_review");
      assert.equal(moved.status, "ok");
      if (moved.status !== "ok") throw new Error("move failed");
      assert.deepEqual(moved.payoffs.map((p) => p.inviterId).sort(), [ana.userId, cy.userId].sort(), "every inviter is credited");
      const anaAwards = await ledger(ana.userId);
      assert.equal(anaAwards.length, 1);
      assert.deepEqual([anaAwards[0]!.points, anaAwards[0]!.item_id, anaAwards[0]!.via_mcp], [0, sol1.id, false]);
      assert.equal(anaAwards[0]!.award_key, `invite_fulfilled:${pay.id}:${gus.userId}:${ana.userId}`);
      const { rows: badge } = await pool.query(`select tier from user_badges where user_id = $1 and badge_key = 'matchmaker'`, [ana.userId]);
      assert.deepEqual(badge, [{ tier: 1 }], "Matchmaker (Bronze)");
      await notifyInvitationPayoffs(ctx(committee.userId), moved.payoffs);
      const paid = await inbox(ana.userId, "invitation_paid_off");
      assert.equal(paid.length, 1, "event 23, with gamification off");
      assert.match(String(paid[0]!.payload.message), new RegExp(`answered your invitation with SOL-${sol1.num} on CH-${pay.num}`));
      assert.equal((await outbox(ana.userId, "invitation_paid_off")).length, 0, "in-app only");

      // A second solution by the same invitee adds nothing; a revert and a delete revoke nothing.
      const sol2 = await propose(pay.num, gus);
      const again = await store.setSolutionStatus(pool, committee, sol2.num, "in_review");
      assert.ok(again.status === "ok" && again.payoffs.length === 0);
      assert.equal((await store.setSolutionStatus(pool, nsAdmin, sol1.num, "proposed")).status, "ok");
      const del = await deleteSolution({ pool, storage } as never, platform, sol1.num, "dbtest");
      assert.equal(del.status, "ok");
      assert.equal((await ledger(ana.userId)).length, 1, "the ledger is untouched");
      const afterDelete = (await rowsFor(pay.id)).find((r) => r.inviter_id === ana.userId)!;
      assert.ok(afterDelete.paid_off_at !== null, "the payoff is kept");

      // Never for a solution created before the invitation, with the inviter on the team, or a later joiner.
      const early = await newChallenge("Early");
      const lee = await mkUser("lee");
      const leeSol = await propose(early.num, lee);
      await sendOk(ana, early.num, [lee.userId]);
      const leeMove = await store.setSolutionStatus(pool, committee, leeSol.num, "in_review");
      assert.ok(leeMove.status === "ok" && leeMove.payoffs.length === 0, "created before the invitation");

      const team = await newChallenge("Team");
      const hal = await mkUser("hal");
      await sendOk(ana, team.num, [hal.userId]);
      const halSol = await propose(team.num, hal, { coAuthorIds: [ana.userId] });
      const halMove = await store.setSolutionStatus(pool, committee, halSol.num, "in_review");
      assert.ok(halMove.status === "ok" && halMove.payoffs.length === 0, "the inviter on the team");

      const late = await newChallenge("Late");
      const ivy = await mkUser("ivy");
      const jon = await mkUser("jon");
      await sendOk(ana, late.num, [ivy.userId]);
      const jonSol = await propose(late.num, jon);
      await pool.query(`insert into solution_authors (solution_id, user_id, added_at, added_by) values ($1, $2, clock_timestamp(), $3)`, [
        jonSol.id,
        ivy.userId,
        jon.userId,
      ]);
      const jonMove = await store.setSolutionStatus(pool, committee, jonSol.num, "in_review");
      assert.ok(jonMove.status === "ok" && jonMove.payoffs.length === 0, "a later joiner never counts");

      // A co-author named on the form counts — and through an agent the row is still not via_mcp.
      const form = await newChallenge("Form");
      const kim = await mkUser("kim");
      await sendOk(cy, form.num, [kim.userId]);
      const kimSol = await propose(form.num, jon, { coAuthorIds: [kim.userId], via: { clientName: "Dbtest agent" } });
      const kimMove = await store.setSolutionStatus(pool, committee, kimSol.num, "in_review");
      assert.ok(kimMove.status === "ok" && kimMove.payoffs.length === 1);
      assert.ok((await ledger(cy.userId)).every((r) => r.via_mcp === false), "never via_mcp");

      // Anonymous: nothing until the self-reveal, then backdated to the first move out of proposed.
      const anon = await newChallenge("Anon");
      const max = await mkUser("max");
      await sendOk(ana, anon.num, [max.userId]);
      const maxSol = await propose(anon.num, max, { anonymous: true });
      const maxMove = await store.setSolutionStatus(pool, committee, maxSol.num, "in_review");
      assert.ok(maxMove.status === "ok" && maxMove.payoffs.length === 0, "an anonymous solution waits");
      const before = (await ledger(ana.userId)).length;
      await pool.query(`select pg_sleep(0.05)`);
      const reveal = await store.selfRevealSolution(pool, max, maxSol.num);
      assert.ok(reveal.status === "ok" && reveal.payoffs?.length === 1, "the self-reveal pays off");
      const backdated = (await ledger(ana.userId)).find((r) => r.item_id === maxSol.id)!;
      assert.equal((await ledger(ana.userId)).length, before + 1);
      const { rows: exit } = await pool.query<{ at: Date }>(
        `select min(created_at) as at from audit_log where target_id = $1 and action = 'solution.status_changed' and before->>'status' = 'proposed'`,
        [maxSol.id],
      );
      assert.equal(backdated.occurred_at.getTime(), exit[0]!.at.getTime(), "dated to the first move out of proposed");

      // The author's withdrawal straight out of proposed, and the §8.3 auto-close of a proposed sibling.
      const wd = await newChallenge("Withdraw");
      const ned = await mkUser("ned");
      await sendOk(ana, wd.num, [ned.userId]);
      const nedSol = await propose(wd.num, ned);
      const withdrawn = await store.withdrawSolution(pool, ned, nedSol.num);
      assert.ok(withdrawn.status === "ok" && withdrawn.payoffs.length === 1, "a withdrawal out of proposed pays off");

      const ac = await newChallenge("AutoClose");
      const oli = await mkUser("oli");
      await sendOk(ana, ac.num, [oli.userId]);
      const oliSol = await propose(ac.num, oli);
      const winner = await propose(ac.num, jon);
      const implemented = await store.setSolutionStatus(pool, nsAdmin, winner.num, "implemented");
      assert.ok(implemented.status === "ok" && implemented.payoffs.some((p) => p.solutionId === oliSol.id), "the auto-close pays off a proposed sibling");

      // Event 23 is dropped for an inviter who can no longer see the challenge; their ledger row stays.
      const lost = await newChallenge("Lost", { visibility: "namespace" });
      const pat = await mkUser("pat");
      const quinn = await mkUser("quinn");
      await sendOk(pat, lost.num, [quinn.userId]);
      const quinnSol = await propose(lost.num, quinn);
      rolesOf.set(pat.userId, roles("member", otherNsId));
      const lostMove = await store.setSolutionStatus(pool, committee, quinnSol.num, "in_review");
      assert.ok(lostMove.status === "ok");
      if (lostMove.status === "ok") await notifyInvitationPayoffs(ctx(committee.userId), lostMove.payoffs);
      assert.equal((await inbox(pat.userId, "invitation_paid_off")).length, 0);
      assert.equal((await ledger(pat.userId)).length, 1);

      // ── The §10.3 cascade and the §3 erasure. ──
      const purged = await deleteChallenge({ pool, storage } as never, platform, ch.num, "dbtest cleanup");
      assert.equal(purged.status, "ok");
      if (purged.status === "ok") {
        assert.ok(purged.counts.invitations >= 4, "the cascade counts the invitations");
        assert.equal(purged.counts.invitationDismissals, 1);
      }
      assert.equal((await rowsFor(ch.id)).length, 0);
      assert.equal((await inbox(bob.userId, "invitation")).filter((r) => r.payload.challengeId === ch.id).length, 0);

      assert.equal((await scrubUser(pool, platform.userId, gus.userId)).status, "ok");
      const { rows: gusLeft } = await pool.query(`select 1 from challenge_invitations where invitee_id = $1 or inviter_id = $1`, [gus.userId]);
      assert.equal(gusLeft.length, 0, "erasure removes the person's invitations");
      assert.equal((await ledger(ana.userId)).length >= 1, true, "other inviters keep their payoffs");
      await pool.query(`update users set notify_invitations = false where id = $1`, [kim.userId]);
      await pool.query(`insert into challenge_invitation_dismissals (challenge_id, user_id) values ($1, $2)`, [form.id, kim.userId]);
      assert.equal((await scrubUser(pool, platform.userId, kim.userId)).status, "ok");
      const { rows: kimRow } = await pool.query<{ notify_invitations: boolean }>(`select notify_invitations from users where id = $1`, [kim.userId]);
      assert.equal(kimRow[0]!.notify_invitations, true, "the preference is reset");
      assert.equal((await pool.query(`select 1 from challenge_invitation_dismissals where user_id = $1`, [kim.userId])).rows.length, 0);
    } finally {
      await pool.end();
    }
  },
);
