// Live-DB integration test (gated) for §38 feature ideas (INNOBOX_SPEC.md §38.14):
//   • proposing: stored pending and audited without its text; the fourth pending is refused, also
//     for two concurrent requests; withdraw deletes a pending row, 409 once decided, 404 for others;
//   • approve: planned with the admin's copy, the proposer's vote, event 19 with its e-mail text,
//     idea_approved (10 points, item-less), audited — and a second decision is a conflict;
//   • decline carries the note to event 19; merge moves the vote, refuses an entry outside the
//     proposer's audience (`not_visible`), awards nothing;
//   • the Coming soon read: audience-filtered, ordered by votes, the name switch read live for the
//     proposer and the voters, the viewer's own unnamed vote; off → the specified teasers alone;
//   • the vote toggle: on and off, audited, 404 for a retired key, a pending idea or an audience the
//     viewer is outside of;
//   • edit keeps votes and audits the diff; the planned delete: needs a choice, event 20 to the
//     proposer and voters (never the actor, a deactivated voter or one outside a narrowed audience),
//     held for a digest recipient, idea_shipped and Roadmapper — and silent when unticked; the spam
//     delete sends nothing; a declined row is not deleted here;
//   • erasure deletes pending/declined/merged rows, keeps a planned one without its text, keeps votes;
//   • the switch is audited, and the migration's CHECKs hold.
// Self-skips when DATABASE_URL is unset. It flips the feature-ideas switch and restores it to on.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComingSoonEntry } from "./store";

const url = process.env.DATABASE_URL;

test(
  "feature ideas: propose, review, votes, Coming soon, events 19–20, awards, delete, erasure, switch",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const ideas = await import("./store");
    const { setFeatureIdeasEnabled } = await import("../admin/settings/store");
    const { scrubUser } = await import("../users/store");

    const pool = new Pool({ connectionString: url });
    let adminId: string | null = null;
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
        `dbtest-fi-${stamp}`,
        `Dbtest FI ${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const mkUser = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`, [
            `dbtest-fi-${label}-${stamp}`,
            `dbtest-fi-${label}-${stamp}@example.test`,
            `Dbtest fi ${label} ${stamp}`,
            `dbtest-fi-${label}-${stamp}@example.test`,
          ])
        ).rows[0]!.id;
      // Roles resolve from SCIM groups + role mappings (invariant 1) — the audience test reads them.
      const mapGroup = async (label: string, role: "platform_admin" | "namespace_admin", members: string[]) => {
        const ext = `dbtest-fi-group-${label}-${stamp}`;
        const { rows } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [ext]);
        await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, $2, $3)`, [ext, role, role === "platform_admin" ? null : nsId]);
        for (const m of members) await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [rows[0]!.id, m]);
      };
      const member = (userId: string) => ({ userId, roles: buildRoleSet([{ role: "member", namespaceId: globalId }], { globalNamespaceId: globalId }) });

      const proposer = member(await mkUser("proposer"));
      const voter = member(await mkUser("voter"));
      const quiet = member(await mkUser("quiet"));
      const leaver = member(await mkUser("leaver"));
      const digestFan = member(await mkUser("digest"));
      const other = member(await mkUser("other"));
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const admin = { userId: await mkUser("admin"), roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }) };
      adminId = admin.userId;
      await mapGroup("pa", "platform_admin", [admin.userId]);
      await mapGroup("nsa", "namespace_admin", [nsAdmin.userId]);
      await setFeatureIdeasEnabled(pool, true, admin.userId);

      const status = async (id: string) => (await pool.query<{ status: string }>(`select status from feature_ideas where id = $1`, [id])).rows[0]?.status ?? null;
      const inbox = async (userId: string, type: string) =>
        (await pool.query<{ payload: { message: string; link: string } }>(`select payload from notifications where user_id = $1 and type = $2 order by created_at`, [userId, type])).rows;
      const outbox = async (userId: string, type: string) =>
        (
          await pool.query<{ payload: { subject: string; emailText: string; digest?: { kind: string; featureTitle: string } }; digest_due_at: Date | null }>(
            `select payload, digest_due_at from notification_outbox where user_id = $1 and type = $2 order by created_at`,
            [userId, type],
          )
        ).rows;
      const ledger = async (userId: string, reason: string) =>
        (await pool.query<{ points: number; item_type: string | null }>(`select points, item_type from gamification_ledger where user_id = $1 and reason = $2`, [userId, reason])).rows;
      const lastAudit = async (action: string, targetId: string) =>
        (await pool.query<{ actor_user_id: string; before: unknown; after: unknown }>(
          `select actor_user_id, before, after from audit_log where action = $1 and target_id = $2 order by id desc limit 1`,
          [action, targetId],
        )).rows[0];
      const propose = async (who: { userId: string }, text: string) => {
        const r = await ideas.proposeIdea(pool, who.userId, text);
        if (r.status !== "ok") throw new Error(`propose failed: ${r.status}`);
        return r.id;
      };
      const copy = (title: string, audience: "everyone" | "admins" | "platform_admin" = "everyone") => ({ title, teaser: `${title} — the teaser.`, audience });

      // ── Proposing and the pending cap. ──
      const first = await propose(proposer, "A dark mode for long evenings. Please.");
      assert.equal(await status(first), "pending");
      const proposed = await lastAudit("feature_idea.proposed", first);
      assert.equal(proposed?.actor_user_id, proposer.userId);
      assert.doesNotMatch(JSON.stringify(proposed), /dark mode/i, "the audit row never carries the text");
      await propose(proposer, "Second idea");
      // Two concurrent requests for the third slot: exactly one wins.
      const race = await Promise.all([ideas.proposeIdea(pool, proposer.userId, "Third A"), ideas.proposeIdea(pool, proposer.userId, "Third B")]);
      assert.deepEqual(race.map((r) => r.status).sort(), ["ok", "too_many_pending"]);
      assert.equal((await ideas.proposeIdea(pool, proposer.userId, "Fourth")).status, "too_many_pending");

      // ── Withdraw: own pending only. ──
      const third = race.find((r) => r.status === "ok") as { status: "ok"; id: string };
      assert.equal((await ideas.withdrawIdea(pool, other.userId, third.id)).status, "not_found", "someone else's");
      assert.equal((await ideas.withdrawIdea(pool, proposer.userId, third.id)).status, "ok");
      assert.equal(await status(third.id), null);
      assert.ok(await lastAudit("feature_idea.withdrawn", third.id));

      // ── Approve: planned, the proposer's vote, event 19, idea_approved; a second decision conflicts. ──
      assert.equal((await ideas.approveIdea(pool, admin.userId, first, copy(`Dark mode ${stamp}`))).status, "ok");
      assert.equal(await status(first), "planned");
      assert.equal((await pool.query(`select 1 from feature_idea_votes where idea_id = $1 and user_id = $2`, [first, proposer.userId])).rows.length, 1);
      const approvedInbox = await inbox(proposer.userId, "feature_idea_reviewed");
      assert.equal(approvedInbox.at(-1)?.payload.message, `Your idea is planned: Dark mode ${stamp}.`);
      assert.equal(approvedInbox.at(-1)?.payload.link, "/whats-new#coming-soon");
      const approvedMail = await outbox(proposer.userId, "feature_idea_reviewed");
      assert.equal(approvedMail.at(-1)?.payload.subject, "Your feature idea is planned");
      assert.equal(approvedMail.at(-1)?.digest_due_at, null, "event 19 is never held");
      assert.deepEqual(await ledger(proposer.userId, "idea_approved"), [{ points: 10, item_type: null }]);
      assert.deepEqual((await lastAudit("feature_idea.approved", first))?.after, copy(`Dark mode ${stamp}`));
      assert.equal((await ideas.approveIdea(pool, admin.userId, first, copy("Again"))).status, "conflict");
      assert.equal((await ideas.declineIdea(pool, admin.userId, first, null)).status, "conflict");
      assert.equal((await ideas.approveIdea(pool, admin.userId, randomUUID(), copy("Ghost"))).status, "not_found");

      // ── Decline: the note reaches the proposer by e-mail. ──
      const declined = await propose(proposer, "Make the logo bigger");
      assert.equal((await ideas.declineIdea(pool, admin.userId, declined, "Out of scope for now.")).status, "ok");
      assert.equal(await status(declined), "declined");
      assert.match((await outbox(proposer.userId, "feature_idea_reviewed")).at(-1)!.payload.emailText, /Note from the reviewer: Out of scope for now\./);
      assert.deepEqual((await lastAudit("feature_idea.declined", declined))?.after, { note: "Out of scope for now." });

      // ── Merge: only into an entry the proposer can see; the vote moves; no award. ──
      const specs = [
        { key: `fi-public-${stamp}`, ids: ["GAP-901"], title: "Public teaser", teaser: "For everyone.", audience: "everyone" as const },
        { key: `fi-admin-${stamp}`, ids: ["GAP-902"], title: "Admin teaser", teaser: "For admins.", audience: "platform_admin" as const },
      ];
      const dup = await propose(voter, "Dark mode please");
      assert.equal((await ideas.mergeIdea(pool, admin.userId, dup, { kind: "spec", key: specs[1]!.key }, specs)).status, "not_visible");
      assert.equal((await ideas.mergeIdea(pool, admin.userId, dup, { kind: "spec", key: "fi-gone" }, specs)).status, "bad_target");
      assert.equal((await ideas.mergeIdea(pool, admin.userId, dup, { kind: "idea", id: first }, specs)).status, "ok");
      assert.equal(await status(dup), "merged");
      assert.equal((await pool.query(`select 1 from feature_idea_votes where idea_id = $1 and user_id = $2`, [first, voter.userId])).rows.length, 1, "the vote moved");
      assert.equal((await inbox(voter.userId, "feature_idea_reviewed")).at(-1)?.payload.message, `Your idea is already planned: Dark mode ${stamp}.`);
      assert.deepEqual(await ledger(voter.userId, "idea_approved"), [], "a merge earns nothing");
      const own = await ideas.listOwnIdeas(pool, voter.userId, specs);
      assert.equal(own.find((i) => i.id === dup)?.mergedTitle, `Dark mode ${stamp}`);

      // ── An admins-only idea, invisible to members. ──
      const adminIdea = await propose(nsAdmin, "Bulk triage shortcuts");
      assert.equal((await ideas.approveIdea(pool, admin.userId, adminIdea, copy(`Bulk shortcuts ${stamp}`, "admins"))).status, "ok");

      // ── The vote toggle. ──
      const specRef = { kind: "spec" as const, key: specs[0]!.key };
      const on = await ideas.toggleVote(pool, quiet, specRef, specs);
      assert.equal(on.status === "ok" && on.voted, true);
      assert.ok(await lastAudit("feature_idea.voted", `spec:${specs[0]!.key}`));
      const off = await ideas.toggleVote(pool, quiet, specRef, specs);
      assert.equal(off.status === "ok" && off.voted, false);
      assert.ok(await lastAudit("feature_idea.unvoted", `spec:${specs[0]!.key}`));
      assert.equal((await ideas.toggleVote(pool, quiet, { kind: "spec", key: "fi-retired" }, specs)).status, "not_found", "a retired key");
      assert.equal((await ideas.toggleVote(pool, quiet, { kind: "spec", key: specs[1]!.key }, specs)).status, "not_found", "outside the audience");
      assert.equal((await ideas.toggleVote(pool, quiet, { kind: "idea", id: adminIdea }, specs)).status, "not_found", "an admins-only idea");
      const pendingIdea = await propose(other, "Pending, not votable");
      assert.equal((await ideas.toggleVote(pool, quiet, { kind: "idea", id: pendingIdea }, specs)).status, "not_found", "a pending idea");
      for (const v of [quiet, leaver, digestFan]) assert.equal((await ideas.toggleVote(pool, v, { kind: "idea", id: first }, specs)).status, "ok");
      assert.equal((await ideas.toggleVote(pool, nsAdmin, { kind: "idea", id: adminIdea }, specs)).status, "ok", "an admin may vote on an admins-only idea");

      // ── The Coming soon read: audience, order, names read live. ──
      await pool.query(`update users set feature_ideas_named = false where id = $1`, [quiet.userId]);
      const mine = (s: Awaited<ReturnType<typeof ideas.getComingSoon>>) => s.entries.filter((e) => e.title.includes(stamp) || specs.some((x) => x.title === e.title));
      const seen = await ideas.getComingSoon(pool, quiet, true, specs);
      assert.equal(seen.enabled, true);
      assert.deepEqual(
        mine(seen).map((e) => e.title),
        [`Dark mode ${stamp}`, "Public teaser"],
        "by votes; the admins-only idea and the platform-admin teaser are not there",
      );
      const dark = seen.entries.find((e) => e.title === `Dark mode ${stamp}`) as ComingSoonEntry;
      assert.equal(dark.votes, 5, "proposer, merged voter, quiet, leaver, digest fan");
      assert.equal(dark.voted, true);
      assert.equal(dark.othersCount, 1);
      assert.equal(dark.othersIncludesYou, true, "the viewer's own unnamed vote");
      assert.ok(!dark.voters.some((v) => v.id === quiet.userId), "an opted-out voter is not named");
      assert.equal(dark.proposedBy?.id, proposer.userId);
      await pool.query(`update users set feature_ideas_named = false where id = $1`, [proposer.userId]);
      const unnamed = (await ideas.getComingSoon(pool, quiet, true, specs)).entries.find((e) => e.title === `Dark mode ${stamp}`) as ComingSoonEntry;
      assert.equal(unnamed.proposedBy, null, "the switch is read live");
      await pool.query(`update users set feature_ideas_named = true where id = $1`, [proposer.userId]);
      const asAdmin = await ideas.getComingSoon(pool, nsAdmin, true, specs);
      assert.ok(asAdmin.entries.some((e) => e.title === `Bulk shortcuts ${stamp}`), "admins see the admins-only idea");
      const offRead = await ideas.getComingSoon(pool, quiet, false, specs);
      assert.equal(offRead.enabled, false);
      assert.deepEqual(
        offRead.entries.map((e) => e.title),
        ["Public teaser"],
        "off: the specified teasers alone",
      );

      // ── Edit keeps votes and audits the diff. ──
      assert.equal((await ideas.editIdea(pool, admin.userId, first, { title: `Dark mode ${stamp}`, teaser: "Now easier on the eyes.", audience: "everyone" })).status, "ok");
      assert.deepEqual((await lastAudit("feature_idea.edited", first))?.after, { teaser: "Now easier on the eyes." });
      assert.equal((await pool.query(`select count(*)::int as n from feature_idea_votes where idea_id = $1`, [first])).rows[0].n, 5);
      assert.equal((await ideas.editIdea(pool, admin.userId, pendingIdea, copy("Nope"))).status, "conflict");

      // ── Admin lists. ──
      assert.ok((await ideas.countPendingIdeas(pool)) >= 2);
      const pendingTab = await ideas.listAdminIdeas(pool, "pending", specs);
      const row = pendingTab.ideas.find((i) => i.id === pendingIdea);
      assert.equal(row?.proposerScope, "everyone");
      assert.ok(pendingTab.targets.some((t) => t.id === `idea:${first}`) && pendingTab.targets.some((t) => t.id === `spec:${specs[1]!.key}`));
      const decidedTab = await ideas.listAdminIdeas(pool, "decided", specs);
      assert.ok(decidedTab.ideas.some((i) => i.id === declined) && decidedTab.ideas.some((i) => i.id === dup));

      // ── The planned delete: a choice is required; ticked → event 20, idea_shipped, Roadmapper. ──
      await pool.query(`update users set email_delivery = 'daily' where id = $1`, [digestFan.userId]);
      await pool.query(`update users set active = false where id = $1`, [leaver.userId]);
      assert.equal((await ideas.deleteIdea(pool, admin.userId, first, undefined)).status, "needs_choice");
      assert.equal((await ideas.toggleVote(pool, admin, { kind: "idea", id: first }, specs)).status, "ok", "the deleting admin voted too");
      assert.equal((await ideas.deleteIdea(pool, admin.userId, first, true)).status, "ok");
      assert.equal(await status(first), null);
      assert.equal((await pool.query(`select 1 from feature_idea_votes where idea_id = $1`, [first])).rows.length, 0, "the votes went with it");
      const shipped = `Dark mode ${stamp} is now available.`;
      assert.equal((await inbox(proposer.userId, "feature_available")).at(-1)?.payload.message, `${shipped} You proposed it.`);
      assert.equal((await inbox(voter.userId, "feature_available")).at(-1)?.payload.message, `${shipped} You upvoted it.`);
      assert.equal((await inbox(quiet.userId, "feature_available")).length, 1, "an opted-out voter is still told");
      assert.equal((await inbox(leaver.userId, "feature_available")).length, 0, "never a deactivated voter");
      assert.equal((await inbox(admin.userId, "feature_available")).length, 0, "never the actor");
      const held = (await outbox(digestFan.userId, "feature_available"))[0];
      assert.ok(held?.digest_due_at, "held for a daily digest");
      assert.deepEqual(held?.payload.digest, { kind: "feature", challengeNumber: "", challengeTitle: "", featureTitle: `Dark mode ${stamp}` });
      assert.equal((await outbox(voter.userId, "feature_available"))[0]?.payload.subject, `Now available: Dark mode ${stamp}`);
      assert.deepEqual(await ledger(proposer.userId, "idea_shipped"), [{ points: 25, item_type: null }]);
      assert.equal((await pool.query(`select tier from user_badges where user_id = $1 and badge_key = 'roadmapper'`, [proposer.userId])).rows[0]?.tier, 1);
      assert.deepEqual((await lastAudit("feature_idea.deleted", first))?.after, { notifyShipped: true });
      assert.equal((await pool.query(`select 1 from notifications where type = 'feature_available' and challenge_id is not null and user_id = $1`, [proposer.userId])).rows.length, 0, "it names no item");

      // A narrowed audience: the voter outside it is not told; unticked is silent.
      const narrowed = await propose(other, "Admin report export");
      await ideas.approveIdea(pool, admin.userId, narrowed, copy(`Report export ${stamp}`));
      await ideas.toggleVote(pool, voter, { kind: "idea", id: narrowed }, specs);
      await ideas.toggleVote(pool, nsAdmin, { kind: "idea", id: narrowed }, specs);
      await ideas.editIdea(pool, admin.userId, narrowed, copy(`Report export ${stamp}`, "admins"));
      const before18 = (await inbox(voter.userId, "feature_available")).length;
      assert.equal((await ideas.deleteIdea(pool, admin.userId, narrowed, true)).status, "ok");
      assert.equal((await inbox(voter.userId, "feature_available")).length, before18, "outside the narrowed audience");
      assert.equal((await inbox(nsAdmin.userId, "feature_available")).length, 1, "inside it");
      assert.equal((await inbox(other.userId, "feature_available")).length, 0, "a member proposer outside the narrowed audience is not told either");
      const silent = await propose(other, "Silent one");
      await ideas.approveIdea(pool, admin.userId, silent, copy(`Silent ${stamp}`));
      const silentBefore = (await inbox(other.userId, "feature_available")).length;
      assert.equal((await ideas.deleteIdea(pool, admin.userId, silent, false)).status, "ok");
      assert.equal((await inbox(other.userId, "feature_available")).length, silentBefore, "unticked is silent");
      assert.equal((await ledger(other.userId, "idea_shipped")).length, 1, "only the narrowed idea, which shipped — unticked earns nothing");

      // The spam delete sends nothing; a declined row is not deleted here.
      const spam = await propose(digestFan, "Buy cheap watches");
      assert.equal((await ideas.deleteIdea(pool, admin.userId, spam, undefined)).status, "ok");
      assert.equal(await status(spam), null);
      assert.equal((await inbox(digestFan.userId, "feature_idea_reviewed")).length, 0);
      assert.equal((await ideas.deleteIdea(pool, admin.userId, declined, undefined)).status, "conflict");

      // ── Erasure: pending/declined/merged go, a planned one stays without its text, votes stay. ──
      const keepPlanned = await propose(other, "Keep me planned");
      await ideas.approveIdea(pool, admin.userId, keepPlanned, copy(`Kept ${stamp}`));
      await ideas.toggleVote(pool, other, { kind: "spec", key: specs[0]!.key }, specs);
      assert.equal((await scrubUser(pool, admin.userId, other.userId)).status, "ok");
      assert.equal(await status(pendingIdea), null, "pending deleted");
      assert.equal(await status(keepPlanned), "planned");
      assert.equal((await pool.query<{ description: string | null }>(`select description from feature_ideas where id = $1`, [keepPlanned])).rows[0]?.description, null);
      assert.equal((await pool.query(`select 1 from feature_idea_votes where user_id = $1 and spec_key = $2`, [other.userId, specs[0]!.key])).rows.length, 1, "votes stay");
      const kept = (await ideas.getComingSoon(pool, quiet, true, specs)).entries.find((e) => e.title === `Kept ${stamp}`) as ComingSoonEntry;
      assert.equal(kept.proposedBy, null, "an erased proposer is never named");
      assert.equal(kept.othersCount, 1, "the erased voter is counted, unnamed");
      await ideas.deleteIdea(pool, admin.userId, keepPlanned, false);
      await ideas.deleteIdea(pool, admin.userId, adminIdea, false);

      // ── The migration's CHECKs. ──
      await assert.rejects(pool.query(`insert into feature_ideas (author_id, description, status, decided_at) values ($1, 'x', 'planned', now())`, [proposer.userId]), "planned without copy");
      await assert.rejects(pool.query(`insert into feature_idea_votes (user_id, spec_key, idea_id) values ($1, 'a', $2)`, [proposer.userId, declined]), "both targets");
      await assert.rejects(pool.query(`insert into feature_idea_votes (user_id) values ($1)`, [proposer.userId]), "neither target");

      // ── The switch is audited. ──
      await setFeatureIdeasEnabled(pool, false, admin.userId);
      const audited = await pool.query<{ after: unknown }>(
        `select after from audit_log where action = 'settings.feature_ideas_enabled_changed' and actor_user_id = $1 order by id desc limit 1`,
        [admin.userId],
      );
      assert.deepEqual(audited.rows[0]?.after, { enabled: false });
    } finally {
      if (adminId) await setFeatureIdeasEnabled(pool, true, adminId).catch(() => {});
      await pool.end();
    }
  },
);
