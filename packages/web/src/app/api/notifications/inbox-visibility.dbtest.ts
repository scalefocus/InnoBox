// Live-DB integration test (gated) for the §12.1 read-time visibility gate on the inbox
// (INNOBOX_SPEC.md §12.1 "The inbox applies the same gate at read time", §4.3, invariant 2):
//  - a row written while the recipient could see the challenge is hidden from the bell list and
//    the unread count once the challenge is narrowed to `namespace` and they are not a member —
//    and stays for a member, a namespace admin and a platform admin;
//  - a row about a solution on that challenge (parentType = solution) follows its challenge;
//  - restoring `org` brings the rows back exactly as they were — mark-all-read left them alone;
//  - `awaiting_triage`/`withdrawn` rows follow the state rule (author or namespace admin only);
//  - a row that names no item is unaffected throughout.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§12.1 inbox read-time gate: rows about a challenge the viewer can no longer see are hidden, and return with access",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { getInbox, markAllRead } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest InboxVis NS') returning id`, [
        `dbtest-inboxvis-${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
          [`dbtest-inboxvis-${label}-${stamp}`, `dbtest-inboxvis-${label}-${stamp}@example.test`, `Dbtest InboxVis ${label}`, `inboxvis-${label}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "member" | "namespace_admin" | "platform_admin"; namespaceId: string | null }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });
      const authorId = await mkUser("author");
      // The follower is NOT a member of the restricted namespace; the member is.
      const follower = { userId: await mkUser("follower"), roles: roles([]) };
      const member = { userId: await mkUser("member"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const nsAdmin = { userId: await mkUser("nsadmin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };
      const platformAdmin = { userId: await mkUser("pa"), roles: roles([{ role: "platform_admin", namespaceId: null }]) };
      const viewers = [follower, member, nsAdmin, platformAdmin];

      // An org-visible challenge in the namespace, with one solution.
      const { rows: ch } = await pool.query<{ id: string; number: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'inbox gate fixture', $3, $4, 'valid') returning id, number::text`,
        [nsId, `InboxVis ${stamp}`, ia[0]!.id, authorId],
      );
      const challengeId = ch[0]!.id;
      const chNum = ch[0]!.number;
      const { rows: sol } = await pool.query<{ id: string; number: string }>(
        `insert into solutions (challenge_id, description, author_id, status) values ($1, 'sol', $2, 'in_review') returning id, number::text`,
        [challengeId, authorId],
      );
      const solutionId = sol[0]!.id;

      // Every viewer gets the same four rows, written while the challenge was org-visible.
      const insert = async (userId: string, type: string, payload: Record<string, unknown>) => {
        const { rows } = await pool.query<{ id: string }>(`insert into notifications (user_id, type, payload) values ($1, $2, $3) returning id`, [
          userId,
          type,
          JSON.stringify(payload),
        ]);
        return rows[0]!.id;
      };
      const rowsOf = new Map<string, { byChallenge: string; byParent: string; bySolution: string; noItem: string }>();
      for (const v of viewers) {
        rowsOf.set(v.userId, {
          // The comment-row shape: challengeId beside the parent keys.
          byChallenge: await insert(v.userId, "comment_posted", {
            message: `c ${stamp}`,
            link: `/challenges/${chNum}`,
            parentType: "challenge",
            parentId: challengeId,
            challengeId,
          }),
          // A status row: parentType + parentId only.
          byParent: await insert(v.userId, "status_changed", { message: `s ${stamp}`, link: `/challenges/${chNum}`, parentType: "challenge", parentId: challengeId }),
          // About the solution: resolved to its challenge.
          bySolution: await insert(v.userId, "status_changed", {
            message: `sol ${stamp}`,
            link: `/challenges/${chNum}#SOL-${sol[0]!.number}`,
            parentType: "solution",
            parentId: solutionId,
          }),
          // Names no item at all (an achievement): never gated.
          noItem: await insert(v.userId, "achievement_earned", { message: `a ${stamp}`, link: "/me" }),
        });
      }
      const ids = (v: { userId: string }) => rowsOf.get(v.userId)!;
      const shown = async (v: typeof follower) => {
        const inbox = await getInbox(pool, v);
        const r = ids(v);
        const has = (id: string) => inbox.notifications.some((n) => n.id === id);
        return { byChallenge: has(r.byChallenge), byParent: has(r.byParent), bySolution: has(r.bySolution), noItem: has(r.noItem), unread: inbox.unreadCount };
      };
      const ALL = { byChallenge: true, byParent: true, bySolution: true, noItem: true, unread: 4 };
      const ONLY_NO_ITEM = { byChallenge: false, byParent: false, bySolution: false, noItem: true, unread: 1 };

      // ── org-visible: everyone sees all four ──
      for (const v of viewers) assert.deepEqual(await shown(v), ALL, `org-visible: every row shows for ${v.userId}`);

      // ── narrowed to the namespace: the non-member loses the three item rows, nobody else does ──
      await pool.query(`update challenges set visibility = 'namespace' where id = $1`, [challengeId]);
      assert.deepEqual(await shown(follower), ONLY_NO_ITEM, "non-member: item rows and their unread count are hidden; the item-less row stays");
      assert.deepEqual(await shown(member), ALL, "a namespace member still sees everything");
      assert.deepEqual(await shown(nsAdmin), ALL, "the namespace admin still sees everything");
      assert.deepEqual(await shown(platformAdmin), ALL, "a platform admin sees everything");

      // Mark-all-read leaves the hidden rows alone, like rows about the trash.
      await markAllRead(pool, follower);
      assert.equal((await shown(follower)).unread, 0);

      // ── access returns: the rows are back exactly as they were (still unread) ──
      await pool.query(`update challenges set visibility = 'org' where id = $1`, [challengeId]);
      const back = await getInbox(pool, follower);
      assert.deepEqual(await shown(follower), { ...ALL, unread: 3 }, "all four rows are back; the three hidden ones are still unread");
      for (const id of [ids(follower).byChallenge, ids(follower).byParent, ids(follower).bySolution]) {
        assert.equal(back.notifications.find((n) => n.id === id)!.read, false, "a hidden row was not marked read");
      }
      assert.equal(back.notifications.find((n) => n.id === ids(follower).noItem)!.read, true, "the visible row was marked read");

      // ── `people`: only the access list, reviewers and the assignee — a member is out too ──
      await pool.query(`update challenges set visibility = 'people' where id = $1`, [challengeId]);
      assert.equal((await shown(member)).byParent, false, "people: a plain member no longer sees the row");
      assert.equal((await shown(nsAdmin)).byParent, true, "people: the namespace admin (a reviewer) still does");
      const listed = { userId: member.userId, roles: buildRoleSet([{ role: "member", namespaceId: nsId }], { globalNamespaceId: globalId, accessListChallengeIds: [challengeId] }) };
      assert.deepEqual(await shown(listed), { ...ALL, unread: 4 }, "people: a member on the access list sees the rows again");
      await pool.query(`update challenges set visibility = 'org' where id = $1`, [challengeId]);

      // ── the state rule replaces the namespace rule: awaiting_triage is the author's and the
      //    namespace admins' — a member of an org-visible challenge loses the row, a platform admin
      //    keeps it, and so does a non-member AUTHOR ──
      await pool.query(`update challenges set status = 'awaiting_triage' where id = $1`, [challengeId]);
      assert.equal((await shown(member)).byParent, false, "awaiting_triage: a member who is not the author loses the row");
      assert.equal((await shown(follower)).byParent, false, "awaiting_triage: a non-member loses the row");
      assert.equal((await shown(nsAdmin)).byParent, true, "awaiting_triage: the namespace admin keeps it");
      assert.equal((await shown(platformAdmin)).byParent, true, "awaiting_triage: a platform admin keeps it");
      const authorViewer = { userId: authorId, roles: roles([]) };
      const authorRow = await insert(authorId, "status_changed", { message: `own ${stamp}`, link: `/challenges/${chNum}`, parentType: "challenge", parentId: challengeId });
      assert.ok((await getInbox(pool, authorViewer)).notifications.some((n) => n.id === authorRow), "awaiting_triage: the author (no namespace grant) keeps their own row");
      await pool.query(`update challenges set status = 'withdrawn' where id = $1`, [challengeId]);
      assert.equal((await shown(member)).byChallenge, false, "withdrawn: same rule");
      assert.ok((await getInbox(pool, authorViewer)).notifications.some((n) => n.id === authorRow), "withdrawn: the author keeps their own row");
      await pool.query(`update challenges set status = 'valid' where id = $1`, [challengeId]);
      assert.deepEqual(await shown(member), ALL, "valid + org again: everything is back for the member");

      // ── the trash rule still applies on top (a platform admin sees everything BUT the trash) ──
      // challenges_trash_chk: the three trash columns are set and cleared together.
      await pool.query(`update challenges set trashed_at = now(), trashed_by = $2, trash_reason = 'inbox gate fixture' where id = $1`, [challengeId, platformAdmin.userId]);
      assert.deepEqual(await shown(platformAdmin), ONLY_NO_ITEM, "trashed: hidden even from a platform admin");
      await pool.query(`update challenges set trashed_at = null, trashed_by = null, trash_reason = null where id = $1`, [challengeId]);
      assert.deepEqual(await shown(platformAdmin), ALL);
    } finally {
      await pool.end();
    }
  },
);
