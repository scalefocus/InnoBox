// Live-DB integration test (gated) for challenges shared with specific people (INNOBOX_SPEC.md §4.3
// `people`, §7.3, §12.1 event 15, §15). Proves end to end, as the least-privilege app role:
//   - the visibility change to `people` writes the access list (users and pending e-mails) and
//     audits it without ever writing an address into the append-only log;
//   - the JS gate, its SQL twin (gallery, search) and the detail page agree: the list, the
//     namespace's admins and committee and the assignee see it — a plain namespace member does not
//     — and nobody sees it while it is in triage;
//   - event 15 fires once per entry when the challenge leaves triage, auto-follows the recipient,
//     carries its own subject, and never re-fires on a re-saved list;
//   - a pending e-mail binds when a user with that address is created, with its own event 15;
//   - assigning someone not on the list adds them (stamped, no event 15), and the assignee picker
//     offers everyone;
//   - only the item's admins get the list in the detail payload;
//   - switching away from `people` clears the list and records what was removed.
// Self-skips when DATABASE_URL is unset; like the other suites it leaves its rows behind.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§4.3 people visibility: list, gate and SQL twin, event 15, binding, assignment auto-add, clearing",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { bindPendingAccess, buildRoleSet } = await import("@innobox/shared");
    const store = await import("./store");
    const { search } = await import("../search/store");
    const { searchActiveUsers } = await import("../users/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const token = `zpv${stamp}`;
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest People NS') returning id`,
        [`dbtest-people-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, email, display_name) values ($1, $2, $2, $3) returning id`,
          [`dbtest-people-${label}-${stamp}`, `dbtest-people-${label}-${stamp}@example.test`, `Dbtest People ${label} ${stamp}`],
        );
        return rows[0]!.id;
      };
      type Grant = { role: "namespace_admin" | "committee" | "member"; namespaceId: string };
      // Roles as resolveRolesForUser builds them: the grants plus the user's access-list entries,
      // re-read from the database each time (a request resolves them afresh).
      const viewer = async (userId: string, grants: Grant[] = []) => {
        const { rows } = await pool.query<{ challenge_id: string }>(`select challenge_id from challenge_access where user_id = $1`, [userId]);
        return { userId, roles: buildRoleSet(grants, { globalNamespaceId: globalId, accessListChallengeIds: rows.map((r) => r.challenge_id) }) };
      };

      const authorId = await mkUser("author");
      const adminId = await mkUser("admin");
      const committeeId = await mkUser("committee");
      const memberId = await mkUser("member");
      const listedId = await mkUser("listed");
      const outsiderId = await mkUser("outsider");
      const pendingEmail = `dbtest-people-pending-${stamp}@example.test`;
      const admin = await viewer(adminId, [{ role: "namespace_admin", namespaceId: nsId }]);

      const { rows: created } = await pool.query<{ id: string; number: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'people fixture', $3, $4, 'awaiting_triage') returning id, number::text`,
        [nsId, `Shared ${token}`, ia[0]!.id, authorId],
      );
      const challengeId = created[0]!.id;
      const number = created[0]!.number;

      // ── Share with one user and one address that names nobody yet ────────────────────────
      assert.deepEqual(
        await store.setChallengeVisibility(pool, admin, number, "people", { userIds: [], emails: [] }),
        { status: "invalid_access", error: "Add at least one person, or choose a different visibility." },
        "an empty list is refused",
      );
      const shared = await store.setChallengeVisibility(pool, admin, number, "people", { userIds: [listedId], emails: [pendingEmail.toUpperCase()] });
      assert.equal(shared.status, "ok");
      if (shared.status === "ok") {
        assert.equal(shared.challenge.visibility, "people");
        assert.equal(shared.challenge.access?.length, 2, "the admin sees the list");
      }
      const { rows: entries } = await pool.query<{ user_id: string | null; email: string | null; notified_at: Date | null }>(
        `select user_id, email, notified_at from challenge_access where challenge_id = $1 order by user_id nulls last`,
        [challengeId],
      );
      assert.deepEqual(
        entries.map((e) => [e.user_id, e.email]),
        [
          [listedId, null],
          [null, pendingEmail],
        ],
        "a user entry and a lower-cased pending entry",
      );
      const { rows: audits } = await pool.query<{ action: string; after: Record<string, unknown> }>(
        `select action, after from audit_log where target_id = $1 order by id`,
        [challengeId],
      );
      const accessAudit = audits.find((a) => a.action === "challenge.access_changed");
      assert.ok(accessAudit, "the list change is audited");
      assert.deepEqual(accessAudit!.after, { added: { userIds: [listedId], pending: 1 }, removed: { userIds: [], pending: 0 }, via: "editor" });
      assert.ok(!JSON.stringify(audits.map((a) => a.after)).includes("@"), "no address ever reaches the audit log");

      // ── In triage the list grants nothing, and nobody is told ─────────────────────────────
      assert.equal(await store.getChallengeByNumber(pool, await viewer(listedId), number), null, "listed, in triage");
      const shareCount = async (userId: string) =>
        Number((await pool.query(`select count(*) from notifications where user_id = $1 and type = 'challenge_shared' and payload->>'parentId' = $2`, [userId, challengeId])).rows[0].count);
      assert.equal(await shareCount(listedId), 0, "no event 15 while in triage");

      // ── Leaving triage: event 15, auto-follow, the fixed subject ──────────────────────────
      assert.equal((await store.setChallengeStatus(pool, admin, number, "in_review")).status, "ok");
      assert.equal(await shareCount(listedId), 1, "event 15 on leaving triage");
      const { rows: outbox } = await pool.query<{ payload: { subject: string; message: string } }>(
        `select payload from notification_outbox where user_id = $1 and type = 'challenge_shared'`,
        [listedId],
      );
      assert.equal(outbox[0]?.payload.subject, "A challenge has been shared with you");
      assert.match(outbox[0]!.payload.message, new RegExp(`CH-${number} "Shared ${token}" \\(submitted by Dbtest People author`));
      const { rows: follows } = await pool.query(`select 1 from follows where user_id = $1 and parent_type = 'challenge' and parent_id = $2`, [listedId, challengeId]);
      assert.equal(follows.length, 1, "the recipient is auto-followed");

      // ── Who sees it now: the JS gate, the detail payload, the SQL twin ────────────────────
      const listed = await viewer(listedId);
      const committee = await viewer(committeeId, [{ role: "committee", namespaceId: nsId }]);
      const member = await viewer(memberId, [{ role: "member", namespaceId: nsId }]);
      const outsider = await viewer(outsiderId);
      const listedDetail = await store.getChallengeByNumber(pool, listed, number);
      assert.ok(listedDetail, "listed: visible");
      assert.equal(listedDetail!.access, null, "listed: the list is the admins' business");
      assert.ok(await store.getChallengeByNumber(pool, committee, number), "committee: visible");
      assert.equal((await store.getChallengeByNumber(pool, committee, number))!.access, null, "committee: no list");
      assert.equal(await store.getChallengeByNumber(pool, member, number), null, "a plain namespace member: hidden");
      assert.equal(await store.getChallengeByNumber(pool, outsider, number), null, "outsider: hidden");
      for (const [name, v, visible] of [
        ["listed", listed, true],
        ["committee", committee, true],
        ["member", member, false],
        ["outsider", outsider, false],
      ] as const) {
        const found = (await search(pool, v, token)).challenges.map((c) => c.number);
        assert.equal(found.includes(`CH-${number}`), visible, `search agrees with the gate for the ${name}`);
        const listedIn = (await store.listChallenges(pool, v, { tab: "open", sort: "newest" })).map((c) => c.number);
        assert.equal(listedIn.includes(`CH-${number}`), visible, `the gallery agrees with the gate for the ${name}`);
      }

      // ── Re-saving the same list never re-notifies ─────────────────────────────────────────
      assert.equal((await store.setChallengeVisibility(pool, admin, number, "people", { userIds: [listedId], emails: [pendingEmail] })).status, "ok");
      assert.equal(await shareCount(listedId), 1, "no second event 15");

      // ── A pending address binds when that person is set up ────────────────────────────────
      const { rows: newcomer } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, email, display_name) values ($1, $2, $3, 'Dbtest People newcomer') returning id`,
        [`dbtest-people-newcomer-${stamp}`, `newcomer-${stamp}@corp.example.test`, pendingEmail],
      );
      const newcomerId = newcomer[0]!.id;
      assert.deepEqual(await bindPendingAccess(pool, newcomerId), [challengeId]);
      const { rows: bound } = await pool.query(`select 1 from challenge_access where challenge_id = $1 and (email is not null or user_id = $2)`, [challengeId, newcomerId]);
      assert.equal(bound.length, 1, "the pending entry now names the user, and no pending entry is left");
      assert.equal(await shareCount(newcomerId), 1, "event 15 for the newly bound person");
      assert.ok(await store.getChallengeByNumber(pool, await viewer(newcomerId), number), "the newcomer can open it");
      assert.deepEqual(await bindPendingAccess(pool, newcomerId), [], "binding again finds nothing");
      const { rows: bindAudit } = await pool.query<{ after: { via: string } }>(
        `select after from audit_log where target_id = $1 and action = 'challenge.access_changed' order by id desc limit 1`,
        [challengeId],
      );
      assert.equal(bindAudit[0]?.after.via, "binding");

      // ── Assignment: the picker offers everyone, and assigning adds to the list ─────────────
      const audience = await store.getAssignmentAudience(pool, admin, number);
      assert.ok(audience, "the admin may assign");
      const offered = (await searchActiveUsers(pool, `Dbtest People outsider ${stamp}`, audience!)).map((u) => u.id);
      assert.deepEqual(offered, [outsiderId], "someone not on the list is offered");
      const resolveRoles = async (id: string) => (await viewer(id)).roles;
      const assigned = await store.setChallengeAssignee(pool, admin, number, outsiderId, resolveRoles);
      assert.equal(assigned.status, "ok");
      const { rows: auto } = await pool.query<{ notified_at: Date | null }>(`select notified_at from challenge_access where challenge_id = $1 and user_id = $2`, [challengeId, outsiderId]);
      assert.ok(auto[0]?.notified_at, "the assignee is on the list, stamped as notified");
      assert.equal(await shareCount(outsiderId), 0, "no event 15 — event 7 tells them");
      const { rows: assignAudit } = await pool.query<{ after: { via: string } }>(
        `select after from audit_log where target_id = $1 and action = 'challenge.access_changed' order by id desc limit 1`,
        [challengeId],
      );
      assert.equal(assignAudit[0]?.after.via, "assignment");
      // Unassigning does not take them off the list.
      assert.equal((await store.setChallengeAssignee(pool, admin, number, null, resolveRoles)).status, "ok");
      assert.ok(await store.getChallengeByNumber(pool, await viewer(outsiderId), number), "still listed after the unassign");

      // ── Switching away clears the list and records what went ──────────────────────────────
      const cleared = await store.setChallengeVisibility(pool, admin, number, "namespace");
      assert.equal(cleared.status, "ok");
      const { rows: left } = await pool.query(`select 1 from challenge_access where challenge_id = $1`, [challengeId]);
      assert.equal(left.length, 0, "the list is gone");
      const { rows: visAudit } = await pool.query<{ after: { visibility: string; removedAccess?: { userIds: string[]; pending: number } } }>(
        `select after from audit_log where target_id = $1 and action = 'challenge.visibility_changed' order by id desc limit 1`,
        [challengeId],
      );
      assert.equal(visAudit[0]?.after.visibility, "namespace");
      assert.deepEqual([...(visAudit[0]?.after.removedAccess?.userIds ?? [])].sort(), [listedId, newcomerId, outsiderId].sort());
      assert.equal(visAudit[0]?.after.removedAccess?.pending, 0);
      assert.equal(await store.getChallengeByNumber(pool, await viewer(listedId), number), null, "the former list sees nothing");
      assert.ok(await store.getChallengeByNumber(pool, member, number), "namespace-only: the member sees it again");
    } finally {
      await pool.end();
    }
  },
);

test(
  "§7.3 people visibility: in triage the ordinary assignment gate holds",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const store = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest People triage') returning id`, [
        `dbtest-peoplet-${stamp}`,
      ]);
      const nsId = nsRows[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) =>
        (
          await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $1, $2) returning id`, [
            `dbtest-peoplet-${label}-${stamp}`,
            `Dbtest PeopleT ${label}`,
          ])
        ).rows[0]!.id;
      const authorId = await mkUser("author");
      const outsiderId = await mkUser("outsider");
      const admin = { userId: await mkUser("admin"), roles: buildRoleSet([{ role: "namespace_admin", namespaceId: nsId }], { globalNamespaceId: globalId }) };
      const { rows } = await pool.query<{ id: string; number: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'people', 'In triage', 'people fixture', $2, $3, 'awaiting_triage') returning id, number::text`,
        [nsId, ia[0]!.id, authorId],
      );
      const resolveRoles = async () => buildRoleSet([], { globalNamespaceId: globalId });
      assert.deepEqual(await store.setChallengeAssignee(pool, admin, rows[0]!.number, outsiderId, resolveRoles), { status: "assignee_cannot_see" });
      const { rows: access } = await pool.query(`select 1 from challenge_access where challenge_id = $1`, [rows[0]!.id]);
      assert.equal(access.length, 0, "nobody was added");
    } finally {
      await pool.end();
    }
  },
);
