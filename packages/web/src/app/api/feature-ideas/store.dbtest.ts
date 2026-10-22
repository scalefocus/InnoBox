// Live-DB integration test (gated) for §38 feature ideas (INNOBOX_SPEC.md §38.14):
//   • proposing: stored pending and audited without its text; the fourth pending is refused, also
//     for two concurrent requests, but never for a platform admin; withdraw deletes a pending row,
//     409 once decided, 404 for others;
//   • approve: planned with the admin's copy, the proposer's vote, event 19 with its e-mail text,
//     idea_approved (10 points, item-less), audited — and a second decision is a conflict; a platform
//     admin approving their own proposal gets the vote but no event and no award;
//   • decline carries the note to event 19; merge moves the vote, refuses an entry outside the
//     proposer's audience (`not_visible`) and one that is not planned, awards nothing;
//   • the Coming soon read: audience-filtered, ordered by votes, entries without a proposer, the name
//     switch read live for the proposer and the voters, the viewer's own unnamed vote; who may
//     propose and the cap, whatever the proposals switch says;
//   • the vote toggle: on and off, audited, 404 for a pending or deleted entry or an audience the
//     viewer is outside of;
//   • edit keeps votes and audits the diff, seeded-style entries included; the planned delete: needs
//     a choice, event 20 to the proposer and voters (never the actor, a deactivated voter or one
//     outside a narrowed audience), held for a digest recipient, idea_shipped and Roadmapper — to
//     voters only and with no award for an entry without a proposer, no award for a self-approved
//     one — and silent when unticked; the spam delete sends nothing; a declined row is not deleted;
//   • erasure deletes pending/declined/merged rows, keeps a planned one without its text, keeps votes;
//   • the switch is audited, and the migrations' CHECKs hold.
// A second test (owner connection only, inside a rolled-back transaction) runs migration 0055 against
// a pre-0055 shape: the ten rows seeded in their former order, votes moved from their keys, merge
// targets rewritten, the key column and the teaser mirror dropped, and a re-run changes nothing.
// Self-skips when DATABASE_URL is unset. It flips the proposals switch and restores it to on.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ComingSoonEntry } from "./store";

const url = process.env.DATABASE_URL;
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

test("feature ideas: propose, review, votes, Coming soon, events 19–20, awards, delete, erasure, switch", { skip }, async () => {
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
      (
        await pool.query<{ actor_user_id: string; before: unknown; after: unknown }>(
          `select actor_user_id, before, after from audit_log where action = $1 and target_id = $2 order by id desc limit 1`,
          [action, targetId],
        )
      ).rows[0];
    const propose = async (who: { userId: string }, text: string, uncapped = false) => {
      const r = await ideas.proposeIdea(pool, who.userId, text, { uncapped });
      if (r.status !== "ok") throw new Error(`propose failed: ${r.status}`);
      return r.id;
    };
    const copy = (title: string, audience: "everyone" | "admins" | "platform_admin" = "everyone") => ({ title, teaser: `${title} — the teaser.`, audience });
    // An entry without a proposer, as migration 0055 seeds them.
    const seedEntry = async (title: string, audience: "everyone" | "admins" | "platform_admin", decidedAt: string) =>
      (
        await pool.query<{ id: string }>(
          `insert into feature_ideas (author_id, description, status, title, teaser, audience, decided_at, created_at)
           values (null, null, 'planned', $1, $2, $3, $4::timestamptz, $4::timestamptz) returning id`,
          [title, `${title} — the teaser.`, audience, decidedAt],
        )
      ).rows[0]!.id;

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

    // ── A platform admin: no pending cap; approving their own proposal earns nothing and tells no one. ──
    const own: string[] = [];
    for (let i = 0; i < 4; i += 1) own.push(await propose(admin, `Admin roadmap item ${i}`, true));
    assert.equal(own.length, 4, "a platform admin is never capped");
    assert.equal((await ideas.approveIdea(pool, admin.userId, own[0]!, copy(`Self-approved ${stamp}`))).status, "ok");
    assert.equal((await pool.query(`select 1 from feature_idea_votes where idea_id = $1 and user_id = $2`, [own[0], admin.userId])).rows.length, 1, "the vote is still added");
    assert.deepEqual(await ledger(admin.userId, "idea_approved"), [], "no award for approving one's own idea");
    assert.equal((await inbox(admin.userId, "feature_idea_reviewed")).length, 0, "no event 19 to the actor");
    for (const id of own.slice(1)) await ideas.deleteIdea(pool, admin.userId, id, undefined);

    // ── Decline: the note reaches the proposer by e-mail. ──
    const declined = await propose(proposer, "Make the logo bigger");
    assert.equal((await ideas.declineIdea(pool, admin.userId, declined, "Out of scope for now.")).status, "ok");
    assert.equal(await status(declined), "declined");
    assert.match((await outbox(proposer.userId, "feature_idea_reviewed")).at(-1)!.payload.emailText, /Note from the reviewer: Out of scope for now\./);
    assert.deepEqual((await lastAudit("feature_idea.declined", declined))?.after, { note: "Out of scope for now." });

    // Entries without a proposer, as the seeded ones: one for everyone, one for platform admins.
    const publicEntry = await seedEntry(`Public entry ${stamp}`, "everyone", "2026-01-01T00:00:01Z");
    const adminEntry = await seedEntry(`Admin entry ${stamp}`, "platform_admin", "2026-01-01T00:00:02Z");

    // ── Merge: only into a planned entry the proposer can see; the vote moves; no award. ──
    const dup = await propose(voter, "Dark mode please");
    assert.equal((await ideas.mergeIdea(pool, admin.userId, dup, adminEntry)).status, "not_visible");
    assert.equal((await ideas.mergeIdea(pool, admin.userId, dup, randomUUID())).status, "bad_target");
    assert.equal((await ideas.mergeIdea(pool, admin.userId, dup, declined)).status, "bad_target", "a declined row is no entry");
    assert.equal((await ideas.mergeIdea(pool, admin.userId, dup, first)).status, "ok");
    assert.equal(await status(dup), "merged");
    assert.equal((await pool.query<{ merged_into: string }>(`select merged_into from feature_ideas where id = $1`, [dup])).rows[0]?.merged_into, first, "the bare id");
    assert.equal((await pool.query(`select 1 from feature_idea_votes where idea_id = $1 and user_id = $2`, [first, voter.userId])).rows.length, 1, "the vote moved");
    assert.equal((await inbox(voter.userId, "feature_idea_reviewed")).at(-1)?.payload.message, `Your idea is already planned: Dark mode ${stamp}.`);
    assert.deepEqual(await ledger(voter.userId, "idea_approved"), [], "a merge earns nothing");
    const ownList = await ideas.listOwnIdeas(pool, voter.userId);
    assert.equal(ownList.find((i) => i.id === dup)?.mergedTitle, `Dark mode ${stamp}`);

    // ── An admins-only idea, invisible to members. ──
    const adminIdea = await propose(nsAdmin, "Bulk triage shortcuts");
    assert.equal((await ideas.approveIdea(pool, admin.userId, adminIdea, copy(`Bulk shortcuts ${stamp}`, "admins"))).status, "ok");

    // ── The vote toggle. ──
    const on = await ideas.toggleVote(pool, quiet, publicEntry);
    assert.equal(on.status === "ok" && on.voted, true);
    assert.ok(await lastAudit("feature_idea.voted", publicEntry));
    const off = await ideas.toggleVote(pool, quiet, publicEntry);
    assert.equal(off.status === "ok" && off.voted, false);
    assert.ok(await lastAudit("feature_idea.unvoted", publicEntry));
    assert.equal((await ideas.toggleVote(pool, quiet, randomUUID())).status, "not_found", "an unknown entry");
    assert.equal((await ideas.toggleVote(pool, quiet, adminEntry)).status, "not_found", "outside the audience");
    assert.equal((await ideas.toggleVote(pool, quiet, adminIdea)).status, "not_found", "an admins-only idea");
    const pendingIdea = await propose(other, "Pending, not votable");
    assert.equal((await ideas.toggleVote(pool, quiet, pendingIdea)).status, "not_found", "a pending idea");
    for (const v of [quiet, leaver, digestFan]) assert.equal((await ideas.toggleVote(pool, v, first)).status, "ok");
    assert.equal((await ideas.toggleVote(pool, nsAdmin, adminIdea)).status, "ok", "an admin may vote on an admins-only idea");

    // ── The Coming soon read: audience, order, entries without a proposer, names read live. ──
    await pool.query(`update users set feature_ideas_named = false where id = $1`, [quiet.userId]);
    const mine = (s: Awaited<ReturnType<typeof ideas.getComingSoon>>) => s.entries.filter((e) => e.title.includes(stamp));
    const seen = await ideas.getComingSoon(pool, quiet, true);
    assert.deepEqual(
      mine(seen).map((e) => e.title),
      [`Dark mode ${stamp}`, `Self-approved ${stamp}`, `Public entry ${stamp}`],
      "by votes (5, 1, 0); the admins-only idea and the platform-admin entry are not there",
    );
    const dark = seen.entries.find((e) => e.title === `Dark mode ${stamp}`) as ComingSoonEntry;
    assert.equal(dark.votes, 5, "proposer, merged voter, quiet, leaver, digest fan");
    assert.equal(dark.voted, true);
    assert.equal(dark.othersCount, 1);
    assert.equal(dark.othersIncludesYou, true, "the viewer's own unnamed vote");
    assert.ok(!dark.voters.some((v) => v.id === quiet.userId), "an opted-out voter is not named");
    assert.equal(dark.proposedBy?.id, proposer.userId);
    assert.ok(dark.approvedAt, "the approval time, for the page's re-sort");
    assert.equal(seen.entries.find((e) => e.id === publicEntry)?.proposedBy, null, "an entry without a proposer");
    assert.equal(seen.canPropose, true);
    assert.equal(seen.maxPending, 3);
    await pool.query(`update users set feature_ideas_named = false where id = $1`, [proposer.userId]);
    const unnamed = (await ideas.getComingSoon(pool, quiet, true)).entries.find((e) => e.title === `Dark mode ${stamp}`) as ComingSoonEntry;
    assert.equal(unnamed.proposedBy, null, "the switch is read live");
    await pool.query(`update users set feature_ideas_named = true where id = $1`, [proposer.userId]);
    const asAdmin = await ideas.getComingSoon(pool, nsAdmin, true);
    assert.ok(asAdmin.entries.some((e) => e.title === `Bulk shortcuts ${stamp}`), "admins see the admins-only idea");
    // Proposals closed: the list and votes are untouched; only a member may no longer propose.
    const closed = await ideas.getComingSoon(pool, quiet, false);
    assert.equal(closed.canPropose, false);
    assert.deepEqual(mine(closed).map((e) => e.title), mine(seen).map((e) => e.title), "the list is the same");
    const closedAdmin = await ideas.getComingSoon(pool, admin, false);
    assert.equal(closedAdmin.canPropose, true, "a platform admin may always propose");
    assert.equal(closedAdmin.maxPending, null, "and has no cap");
    assert.ok(closedAdmin.entries.some((e) => e.id === adminEntry), "a platform admin sees the platform-admin entry");

    // ── Edit keeps votes and audits the diff, an entry without a proposer included. ──
    assert.equal((await ideas.editIdea(pool, admin.userId, first, { title: `Dark mode ${stamp}`, teaser: "Now easier on the eyes.", audience: "everyone" })).status, "ok");
    assert.deepEqual((await lastAudit("feature_idea.edited", first))?.after, { teaser: "Now easier on the eyes." });
    assert.equal((await pool.query(`select count(*)::int as n from feature_idea_votes where idea_id = $1`, [first])).rows[0].n, 5);
    assert.equal((await ideas.editIdea(pool, admin.userId, pendingIdea, copy("Nope"))).status, "conflict");
    assert.equal((await ideas.editIdea(pool, admin.userId, publicEntry, { title: `Public entry ${stamp}`, teaser: "A new teaser.", audience: "everyone" })).status, "ok");
    assert.deepEqual((await lastAudit("feature_idea.edited", publicEntry))?.after, { teaser: "A new teaser." });

    // ── Admin lists. ──
    assert.ok((await ideas.countPendingIdeas(pool)) >= 2);
    const pendingTab = await ideas.listAdminIdeas(pool, "pending");
    const row = pendingTab.ideas.find((i) => i.id === pendingIdea);
    assert.equal(row?.proposerScope, "everyone");
    assert.ok(pendingTab.targets.some((t) => t.id === first) && pendingTab.targets.some((t) => t.id === adminEntry));
    const plannedTab = await ideas.listAdminIdeas(pool, "planned");
    assert.equal(plannedTab.ideas.find((i) => i.id === publicEntry)?.proposer, null, "the Planned tab lists entries without a proposer");
    const decidedTab = await ideas.listAdminIdeas(pool, "decided");
    assert.ok(decidedTab.ideas.some((i) => i.id === declined) && decidedTab.ideas.some((i) => i.id === dup));

    // ── The planned delete: a choice is required; ticked → event 20, idea_shipped, Roadmapper. ──
    await pool.query(`update users set email_delivery = 'daily' where id = $1`, [digestFan.userId]);
    await pool.query(`update users set active = false where id = $1`, [leaver.userId]);
    assert.equal((await ideas.deleteIdea(pool, admin.userId, first, undefined)).status, "needs_choice");
    assert.equal((await ideas.toggleVote(pool, admin, first)).status, "ok", "the deleting admin voted too");
    assert.equal((await ideas.deleteIdea(pool, admin.userId, first, true)).status, "ok");
    assert.equal(await status(first), null);
    assert.equal((await pool.query(`select 1 from feature_idea_votes where idea_id = $1`, [first])).rows.length, 0, "the votes went with it");
    assert.equal((await ideas.toggleVote(pool, quiet, first)).status, "not_found", "a deleted entry");
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

    // An entry without a proposer ships to its voters only, and earns no one anything.
    await ideas.toggleVote(pool, voter, publicEntry);
    const voterBefore = (await inbox(voter.userId, "feature_available")).length;
    assert.equal((await ideas.deleteIdea(pool, admin.userId, publicEntry, true)).status, "ok");
    assert.equal((await inbox(voter.userId, "feature_available")).at(-1)?.payload.message, `Public entry ${stamp} is now available. You upvoted it.`);
    assert.equal((await inbox(voter.userId, "feature_available")).length, voterBefore + 1);
    // A self-approved idea ships without an award.
    assert.equal((await ideas.deleteIdea(pool, admin.userId, own[0]!, true)).status, "ok");
    assert.deepEqual(await ledger(admin.userId, "idea_shipped"), [], "no award for a self-approved idea");

    // A narrowed audience: the voter outside it is not told; unticked is silent.
    const narrowed = await propose(other, "Admin report export");
    await ideas.approveIdea(pool, admin.userId, narrowed, copy(`Report export ${stamp}`));
    await ideas.toggleVote(pool, voter, narrowed);
    await ideas.toggleVote(pool, nsAdmin, narrowed);
    await ideas.editIdea(pool, admin.userId, narrowed, copy(`Report export ${stamp}`, "admins"));
    const beforeNarrowed = (await inbox(voter.userId, "feature_available")).length;
    assert.equal((await ideas.deleteIdea(pool, admin.userId, narrowed, true)).status, "ok");
    assert.equal((await inbox(voter.userId, "feature_available")).length, beforeNarrowed, "outside the narrowed audience");
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
    const otherEntry = await seedEntry(`Other entry ${stamp}`, "everyone", "2026-01-01T00:00:03Z");
    await ideas.toggleVote(pool, other, otherEntry);
    assert.equal((await scrubUser(pool, admin.userId, other.userId)).status, "ok");
    assert.equal(await status(pendingIdea), null, "pending deleted");
    assert.equal(await status(keepPlanned), "planned");
    assert.equal((await pool.query<{ description: string | null }>(`select description from feature_ideas where id = $1`, [keepPlanned])).rows[0]?.description, null);
    assert.equal((await pool.query(`select 1 from feature_idea_votes where user_id = $1 and idea_id = $2`, [other.userId, otherEntry])).rows.length, 1, "votes stay");
    const kept = (await ideas.getComingSoon(pool, quiet, true)).entries.find((e) => e.title === `Kept ${stamp}`) as ComingSoonEntry;
    assert.equal(kept.proposedBy, null, "an erased proposer is never named");
    assert.equal(kept.othersCount, 1, "the erased voter is counted, unnamed");
    for (const id of [keepPlanned, adminIdea, adminEntry, otherEntry]) await ideas.deleteIdea(pool, admin.userId, id, false);

    // ── The migrations' CHECKs. ──
    await assert.rejects(pool.query(`insert into feature_ideas (author_id, description, status, decided_at) values ($1, 'x', 'planned', now())`, [proposer.userId]), "planned without copy");
    await assert.rejects(pool.query(`insert into feature_ideas (author_id, description) values (null, 'x')`), "a pending row needs its author");
    await assert.rejects(pool.query(`insert into feature_idea_votes (user_id) values ($1)`, [proposer.userId]), "a vote needs its entry");

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
});

// The ten entries migration 0055 seeds, in their former order.
const SEEDED = [
  ["co-authors", "599302bc-d2a0-4a62-b076-055af9bd8dce", "Co-authors"],
  ["impact-tracking", "febbd673-37e8-49f4-9b8d-b4fb50a0ca11", "Impact tracking"],
  ["affects-me-too", "e64258fd-c86f-494d-8cc1-6487549b3fef", "This affects me too"],
  ["mark-as-duplicate", "7a7c21c4-f2ff-43f7-8275-9ff7945d4f62", "Mark as duplicate"],
  ["stuck-item-alerts", "714e2378-9db6-4f10-992e-bb82b2380015", "Stuck-item alerts"],
  ["implementation-board", "df81a49d-26ba-4734-87f4-5696450b4ea9", "Implementation board"],
  ["invite-a-solver", "f8b3ce3f-186a-4e95-83ae-fa61d6a07612", "Invite a solver"],
  ["campaigns", "90ca47b8-245d-4c22-913c-c820f1a78967", "Campaigns"],
  ["year-in-review", "b6ab8ab7-1aeb-4e45-9906-9d1d214510ca", "Your year in review"],
  ["namespace-pulse", "12ccadcd-0bb6-482f-97bc-930b0de60b92", "Namespace pulse"],
] as const;

test(
  "migration 0055: seeds the ten entries once, moves their votes and merge targets, drops the key column and the mirror",
  { skip: skip || (ownerUrl ? false : "TEST_OWNER_DATABASE_URL not set — migration cases self-skip") },
  async () => {
    const { Pool } = await import("pg");
    const { readFileSync } = await import("node:fs");
    const { dirname, join, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // packages/web/src/app/api/feature-ideas → repo root.
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
    const sql = readFileSync(join(repoRoot, "db", "migrations", "0055_coming_soon_in_db.sql"), "utf8");
    const ids = SEEDED.map(([, id]) => id);

    const pool = new Pool({ connectionString: ownerUrl });
    const client = await pool.connect();
    try {
      await client.query("begin");
      // The harness applied 0055 already: put back the pre-0055 shape, without the seeded rows.
      await client.query(`delete from feature_ideas where id = any($1::uuid[])`, [ids]);
      await client.query(`alter table feature_idea_votes add column spec_key text`);
      await client.query(`alter table feature_idea_votes alter column idea_id drop not null`);
      await client.query(`create table coming_soon_teasers (key text primary key, title text not null, audience text not null default 'everyone', seen_at timestamptz not null default now())`);
      const mk = async (label: string) =>
        (
          await client.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $1, $1) returning id`, [`dbtest-fi-mig-${label}`])
        ).rows[0]!.id;
      const a = await mk("a");
      const b = await mk("b");
      for (const [user, key] of [
        [a, "co-authors"],
        [a, "campaigns"],
        [b, "campaigns"],
        [a, "retired-key"],
      ] as const) {
        await client.query(`insert into feature_idea_votes (user_id, spec_key, created_at) values ($1, $2, timestamptz '2026-10-21 12:00:00+00')`, [user, key]);
      }
      const { rows: planned } = await client.query<{ id: string }>(
        `insert into feature_ideas (author_id, description, status, title, teaser, audience, decided_at) values ($1, 'x', 'planned', 'Planned', 'p', 'everyone', now()) returning id`,
        [a],
      );
      const mergedInto = async (target: string) =>
        (
          await client.query<{ id: string }>(
            `insert into feature_ideas (author_id, description, status, merged_into, decided_at) values ($1, 'dup', 'merged', $2, now()) returning id`,
            [b, target],
          )
        ).rows[0]!.id;
      const toSpec = await mergedInto("spec:campaigns");
      const toIdea = await mergedInto(`idea:${planned[0]!.id}`);

      await client.query(sql);

      const { rows: seeded } = await client.query<{ id: string; title: string; author_id: string | null; status: string }>(
        `select id, title, author_id, status from feature_ideas where id = any($1::uuid[]) order by decided_at`,
        [ids],
      );
      assert.deepEqual(
        seeded.map((r) => r.title),
        SEEDED.map(([, , title]) => title),
        "the ten, in their former order",
      );
      assert.ok(seeded.every((r) => r.author_id === null && r.status === "planned"), "planned, no proposer");
      const votesOn = async (id: string) =>
        (await client.query<{ user_id: string; created_at: Date }>(`select user_id, created_at from feature_idea_votes where idea_id = $1 order by user_id`, [id])).rows;
      const coAuthors = await votesOn(SEEDED[0][1]);
      assert.deepEqual(coAuthors.map((v) => v.user_id), [a]);
      assert.equal(coAuthors[0]!.created_at.toISOString(), "2026-10-21T12:00:00.000Z", "the vote keeps its time");
      assert.deepEqual((await votesOn(SEEDED[7][1])).map((v) => v.user_id).sort(), [a, b].sort());
      const column = await client.query(`select 1 from information_schema.columns where table_name = 'feature_idea_votes' and column_name = 'spec_key'`);
      assert.equal(column.rows.length, 0, "spec_key is gone, and with it the retired key's vote");
      assert.equal((await client.query<{ t: string | null }>(`select to_regclass('coming_soon_teasers')::text as t`)).rows[0]?.t, null, "the mirror is gone");
      const target = async (id: string) => (await client.query<{ merged_into: string }>(`select merged_into from feature_ideas where id = $1`, [id])).rows[0]?.merged_into;
      assert.equal(await target(toSpec), SEEDED[7][1], "spec:<key> → the seeded row");
      assert.equal(await target(toIdea), planned[0]!.id, "idea:<uuid> → the bare id");
      await client.query("savepoint not_null_check");
      await assert.rejects(client.query(`insert into feature_idea_votes (user_id) values ($1)`, [a]), "idea_id is required now");
      await client.query("rollback to savepoint not_null_check");

      // A re-run changes nothing — and never brings back an entry deleted since.
      await client.query(`delete from feature_ideas where id = $1`, [SEEDED[9][1]]);
      await client.query(sql);
      assert.equal((await client.query(`select 1 from feature_ideas where id = any($1::uuid[])`, [ids])).rows.length, 9, "the deleted entry stays deleted");
      assert.equal((await votesOn(SEEDED[7][1])).length, 2);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
      await pool.end();
    }
  },
);
