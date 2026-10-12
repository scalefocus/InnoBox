// Live-DB integration test (gated) for the /api/users directory search (INNOBOX_SPEC.md
// §7.3) — extracted into its own store.ts as part of the route/store split. Also the §7.3
// assignee gate: the per-challenge picker returns only users who can see the challenge (its SQL
// pinned here to canSeeChallenge over the users' SCIM-resolved roles), and the assign paths
// refuse anyone else. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "searchActiveUsers: matches by name or email, case-insensitive, excludes inactive users",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { searchActiveUsers } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);

      const { rows: activeRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, active) values ($1, $2, $3, $4, true) returning id`,
        [`dbtest-users-active-${stamp}`, `dbtest-users-active-${stamp}@example.test`, `Dbtest UserSearch ${stamp}`, `usersearch-${stamp}@example.test`],
      );
      const activeId = activeRows[0]!.id;

      const { rows: inactiveRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, active) values ($1, $2, $3, $4, false) returning id`,
        [`dbtest-users-inactive-${stamp}`, `dbtest-users-inactive-${stamp}@example.test`, `Dbtest UserSearch Inactive ${stamp}`, `usersearch-inactive-${stamp}@example.test`],
      );
      const inactiveId = inactiveRows[0]!.id;

      const byName = await searchActiveUsers(pool, `usersearch ${stamp}`);
      assert.ok(byName.some((u) => u.id === activeId));
      assert.equal(byName.some((u) => u.id === inactiveId), false, "an inactive user must never be returned");

      const byEmail = await searchActiveUsers(pool, `usersearch-${stamp}@`);
      assert.ok(byEmail.some((u) => u.id === activeId));

      const byLowercase = await searchActiveUsers(pool, `DBTEST usersearch ${stamp}`.toLowerCase());
      assert.ok(byLowercase.some((u) => u.id === activeId), "search must be case-insensitive");

      const noMatch = await searchActiveUsers(pool, `no-such-user-${stamp}`);
      assert.deepEqual(noMatch, []);
    } finally {
      await pool.end();
    }
  },
);

test(
  "searchUsersForAdmin: includes inactive users and flags scrubbed ones (unlike searchActiveUsers)",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { searchUsersForAdmin } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, active) values ($1, $2, $3, $4, false) returning id`,
        [`dbtest-admin-inactive-${stamp}`, `dbtest-admin-inactive-${stamp}@example.test`, `Dbtest AdminSearch ${stamp}`, `adminsearch-${stamp}@example.test`],
      );
      const inactiveId = rows[0]!.id;

      const found = await searchUsersForAdmin(pool, `adminsearch ${stamp}`);
      const hit = found.find((u) => u.id === inactiveId);
      assert.ok(hit, "admin search must include inactive users");
      assert.equal(hit!.active, false);
      assert.equal(hit!.scrubbed, false);
    } finally {
      await pool.end();
    }
  },
);

test(
  "scrubUser: de-identifies the row, deactivates, stamps scrubbed_at, audits, and is idempotent-guarded",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { scrubUser, searchUsersForAdmin } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);

      // An admin actor for the audit FK, and the victim carrying PII.
      const { rows: adminRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, active) values ($1, $2, $3, $4, true) returning id`,
        [`dbtest-scrub-admin-${stamp}`, `dbtest-scrub-admin-${stamp}@example.test`, `Dbtest ScrubAdmin ${stamp}`, `scrubadmin-${stamp}@example.test`],
      );
      const adminId = adminRows[0]!.id;

      const { rows: victimRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, department, job_title, office_location, active, scim_synced,
                            triage_seen_at, challenges_seen_at, system_log_seen_at, quick_start_seen_at,
                            email_notifications_enabled, notify_followed_comments, notify_followed_status, notify_followed_solutions)
           values ($1, $2, $3, $4, 'Engineering', 'Staff Engineer', 'Sofia', true, true,
                   now(), now(), now(), now(), false, false, false, false) returning id`,
        [`dbtest-scrub-victim-${stamp}`, `dbtest-scrub-victim-${stamp}@example.test`, `Dbtest ScrubVictim ${stamp}`, `scrubvictim-${stamp}@example.test`],
      );
      const victimId = victimRows[0]!.id;

      const first = await scrubUser(pool, adminId, victimId);
      assert.equal(first.status, "ok");

      const { rows: after } = await pool.query<{
        display_name: string;
        user_name: string;
        email: string | null;
        department: string | null;
        job_title: string | null;
        office_location: string | null;
        active: boolean;
        scim_synced: boolean;
        scrubbed_at: Date | null;
        external_id: string;
      }>(
        `select display_name, user_name, email, department, job_title, office_location, active, scim_synced, scrubbed_at, external_id
           from users where id = $1`,
        [victimId],
      );
      const row = after[0]!;
      assert.equal(row.display_name, "Deleted User", "display name must be de-identified (cascades to content)");
      assert.equal(row.user_name, `deleted-${victimId}`, "user_name replaced with a non-PII token");
      assert.equal(row.email, null);
      assert.equal(row.department, null);
      assert.equal(row.job_title, null);
      assert.equal(row.office_location, null, "§13.8 directory profile is scrubbed like the photo");
      assert.equal(row.active, false, "account is deactivated");
      assert.equal(row.scim_synced, false, "SCIM sync is disabled so it is not re-provisioned");
      assert.ok(row.scrubbed_at, "scrubbed_at is stamped so reconciliation never restores it");
      assert.equal(row.external_id, `dbtest-scrub-victim-${stamp}`, "the id/external_id link is preserved for the audit trail");

      const { rows: auditRows } = await pool.query<{ n: string }>(
        `select count(*)::text as n from audit_log where action = 'user.scrubbed' and target_id = $1 and actor_user_id = $2`,
        [victimId, adminId],
      );
      assert.equal(auditRows[0]!.n, "1", "the erasure is itself audited");

      // §3: the per-user seen markers are nulled and the notification preferences reset to
      // their column defaults — none of the user's own choices survive on the row.
      const { rows: prefs } = await pool.query<{
        triage_seen_at: Date | null;
        challenges_seen_at: Date | null;
        system_log_seen_at: Date | null;
        quick_start_seen_at: Date | null;
        email_notifications_enabled: boolean;
        notify_followed_comments: boolean;
        notify_followed_status: boolean;
        notify_followed_solutions: boolean;
      }>(
        `select triage_seen_at, challenges_seen_at, system_log_seen_at, quick_start_seen_at,
                email_notifications_enabled, notify_followed_comments, notify_followed_status, notify_followed_solutions
           from users where id = $1`,
        [victimId],
      );
      const p = prefs[0]!;
      assert.equal(p.triage_seen_at, null, "triage seen marker nulled");
      assert.equal(p.challenges_seen_at, null, "challenges seen marker nulled");
      assert.equal(p.system_log_seen_at, null, "system-log seen marker nulled");
      assert.equal(p.quick_start_seen_at, null, "quick-start seen marker nulled");
      assert.equal(p.email_notifications_enabled, true, "e-mail opt-out reset to the column default");
      assert.equal(p.notify_followed_comments, true, "comment preference reset to the column default");
      assert.equal(p.notify_followed_status, true, "status preference reset to the column default");
      assert.equal(p.notify_followed_solutions, true, "solution preference reset to the column default");

      const second = await scrubUser(pool, adminId, victimId);
      assert.equal(second.status, "already_scrubbed", "a second scrub is refused");

      const missing = await scrubUser(pool, adminId, randomUUID());
      assert.equal(missing.status, "not_found");

      const found = await searchUsersForAdmin(pool, `scrubvictim ${stamp}`);
      const hit = found.find((u) => u.id === victimId);
      // display_name/email are wiped, so the victim is no longer findable by their old PII —
      // that is the point of erasure. This asserts the negative to document the behavior.
      assert.equal(hit, undefined, "a scrubbed user is no longer findable by their former name/email");
    } finally {
      await pool.end();
    }
  },
);

test(
  "getUserCard: returns the directory profile, flags deactivated, and 404s on an unknown id (§13.8)",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { getUserCard } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);

      // A fully-populated active user, a user with NO directory fields at all, and an inactive one.
      const { rows: fullRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email, department, job_title, office_location, active)
           values ($1, $2, $3, $4, 'R&D', 'Staff Engineer', 'Sofia — Bulgaria Tower', true) returning id`,
        [`dbtest-card-full-${stamp}`, `dbtest-card-full-${stamp}@example.test`, `Dbtest CardFull ${stamp}`, `cardfull-${stamp}@example.test`],
      );
      const fullId = fullRows[0]!.id;

      const { rows: bareRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, active) values ($1, $2, $3, true) returning id`,
        [`dbtest-card-bare-${stamp}`, `dbtest-card-bare-${stamp}@example.test`, `Dbtest CardBare ${stamp}`],
      );
      const bareId = bareRows[0]!.id;

      const { rows: goneRows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, job_title, active) values ($1, $2, $3, 'Analyst', false) returning id`,
        [`dbtest-card-gone-${stamp}`, `dbtest-card-gone-${stamp}@example.test`, `Dbtest CardGone ${stamp}`],
      );
      const goneId = goneRows[0]!.id;

      const full = await getUserCard(pool, fullId);
      assert.deepEqual(full, {
        userId: fullId,
        displayName: `Dbtest CardFull ${stamp}`,
        jobTitle: "Staff Engineer",
        officeLocation: "Sofia — Bulgaria Tower",
        department: "R&D",
        deactivated: false,
        scrubbed: false,
      });

      const bare = await getUserCard(pool, bareId);
      // All three empty — the card collapses to "No directory information."
      assert.equal(bare?.jobTitle, null);
      assert.equal(bare?.department, null);
      assert.equal(bare?.officeLocation, null);
      assert.equal(bare?.scrubbed, false);

      const gone = await getUserCard(pool, goneId);
      assert.equal(gone?.deactivated, true, "a SCIM-deactivated user is flagged");
      assert.equal(gone?.jobTitle, "Analyst", "deactivation keeps the directory profile (only the photo is dropped)");

      assert.equal(await getUserCard(pool, randomUUID()), null, "unknown id → null (the route turns it into a 404)");
    } finally {
      await pool.end();
    }
  },
);

test(
  "getUserCard: a scrubbed tombstone exposes no directory information (§13.8)",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { getUserCard } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      // Directory columns present on the row but scrubbed_at set: the read side must still null
      // them out, so a tombstone can never leak a title/office even if a writer left values behind.
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, department, job_title, office_location, active, scrubbed_at)
           values ($1, $2, 'Deleted User', 'R&D', 'Staff Engineer', 'Sofia', false, now()) returning id`,
        [`dbtest-card-scrubbed-${stamp}`, `dbtest-card-scrubbed-${stamp}@example.test`],
      );
      const id = rows[0]!.id;

      const card = await getUserCard(pool, id);
      assert.equal(card?.scrubbed, true);
      assert.equal(card?.displayName, "Deleted User");
      assert.equal(card?.jobTitle, null);
      assert.equal(card?.department, null);
      assert.equal(card?.officeLocation, null);
    } finally {
      await pool.end();
    }
  },
);

test(
  "assignee gate: the picker offers, and assignment accepts, only users who can see the challenge",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool, randomUUID } = await importDeps();
    const { buildRoleSet, canSeeChallenge } = await import("@innobox/shared");
    type Role = "platform_admin" | "namespace_admin" | "committee" | "member";
    const { searchActiveUsers } = await import("./store");
    const { getAssignmentAudience, setChallengeAssignee } = await import("../challenges/store");
    const { bulkAssign } = await import("../admin/triage/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest Assignable NS') returning id`,
        [`dbtest-assignable-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);

      // Roles come from SCIM-synced group membership through role_mappings (invariant 1): each
      // user below gets one group mapped to their role, and the expected RoleSet mirrors it.
      const grantsOf = new Map<string, { role: Role; namespaceId: string | null }[]>();
      const mkUser = async (label: string, role: Role | null) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-assignable-${label}-${stamp}`, `dbtest-assignable-${label}-${stamp}@example.test`, `Dbtest Assignable ${label} ${stamp}`],
        );
        const id = rows[0]!.id;
        const grants = role ? [{ role, namespaceId: role === "platform_admin" ? null : nsId }] : [];
        if (role) {
          const groupExternalId = `dbtest-assignable-${label}-${stamp}`;
          const { rows: gr } = await pool.query<{ id: string }>(
            `insert into groups (external_id, display_name, scim_synced) values ($1, $2, true) returning id`,
            [groupExternalId, `Dbtest Assignable ${label}`],
          );
          await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [gr[0]!.id, id]);
          await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, $2, $3)`, [
            groupExternalId,
            role,
            grants[0]!.namespaceId,
          ]);
        }
        grantsOf.set(id, grants);
        return id;
      };
      const rolesOf = async (userId: string) => buildRoleSet(grantsOf.get(userId) ?? [], { globalNamespaceId: globalId });

      const authorId = await mkUser("author", null);
      const adminId = await mkUser("nsadmin", "namespace_admin");
      const committeeId = await mkUser("committee", "committee");
      const memberId = await mkUser("member", "member");
      const platformId = await mkUser("platform", "platform_admin");
      const outsiderId = await mkUser("outsider", null);
      const everyone = [authorId, adminId, committeeId, memberId, platformId, outsiderId];
      const admin = { userId: adminId, roles: await rolesOf(adminId) };
      // Audiences are read as the platform admin: an admin of every namespace, global included (the
      // filtered picker answers only an admin of the challenge's namespace).
      const platform = { userId: platformId, roles: await rolesOf(platformId) };
      // Every fixture user's name carries the stamp, so this query matches exactly the six.
      const q = stamp;
      const offeredIds = async (audience: Parameters<typeof searchActiveUsers>[2]) =>
        new Set((await searchActiveUsers(pool, q, audience)).map((u) => u.id).filter((id) => everyone.includes(id)));

      const mk = async (namespaceId: string, visibility: "org" | "namespace", status: string) => {
        const { rows } = await pool.query<{ number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, $2, $3, 'assignable fixture', $4, $5, $6) returning number::text`,
          [namespaceId, visibility, `Assignable ${visibility} ${status} ${stamp}`, ia[0]!.id, authorId, status],
        );
        return rows[0]!.number;
      };
      const restrictedTriage = await mk(nsId, "namespace", "awaiting_triage");
      const openTriage = await mk(nsId, "org", "awaiting_triage");
      const restricted = await mk(nsId, "namespace", "in_review");
      const openOrg = await mk(nsId, "org", "in_review");
      const restrictedGlobal = await mk(globalId, "namespace", "valid"); // global: every user is a member

      // The picker's SQL agrees with canSeeChallenge for every user and every case.
      for (const number of [restrictedTriage, openTriage, restricted, openOrg, restrictedGlobal]) {
        const audience = await getAssignmentAudience(pool, platform, number);
        assert.ok(audience, `the platform admin gets the audience of CH-${number}`);
        const expected = new Set<string>();
        for (const id of everyone) if (canSeeChallenge({ userId: id, roles: await rolesOf(id) }, audience!)) expected.add(id);
        assert.deepEqual(await offeredIds(audience!), expected, `picker for ${audience!.visibility}/${audience!.status} CH-${number}`);
      }
      // Spot checks on the reference itself, so the loop above cannot pass vacuously.
      assert.deepEqual(
        await offeredIds((await getAssignmentAudience(pool, admin, restrictedTriage))!),
        new Set([authorId, adminId, platformId]),
        "awaiting triage: the author and the namespace's admins only",
      );
      assert.deepEqual(
        await offeredIds((await getAssignmentAudience(pool, admin, restricted))!),
        new Set([adminId, committeeId, memberId, platformId]),
        "namespace-visible: members of the namespace (any role) and platform admins",
      );
      assert.equal((await offeredIds((await getAssignmentAudience(pool, admin, openOrg))!)).size, everyone.length);
      assert.equal((await offeredIds(undefined)).size, everyone.length, "without a challenge the directory is unfiltered");

      // A challenge the caller cannot see yields no audience (existence-not-disclosed), and neither
      // does one they can see but may not assign (the filtered list would expose roles).
      const outsider = { userId: outsiderId, roles: await rolesOf(outsiderId) };
      assert.equal(await getAssignmentAudience(pool, outsider, restricted), null);
      assert.equal(await getAssignmentAudience(pool, { userId: memberId, roles: await rolesOf(memberId) }, restricted), null);
      assert.equal(await getAssignmentAudience(pool, { userId: authorId, roles: await rolesOf(authorId) }, restrictedTriage), null);
      assert.ok(await getAssignmentAudience(pool, admin, restricted), "the namespace's own admin gets it");
      assert.equal(await getAssignmentAudience(pool, admin, restrictedGlobal), null, "not an admin of the global namespace");
      assert.equal(await getAssignmentAudience(pool, admin, "999999999"), null);

      // Single assignment: refused for a user who cannot see the challenge, accepted for one who can.
      assert.equal((await setChallengeAssignee(pool, admin, restricted, outsiderId, rolesOf)).status, "assignee_cannot_see");
      assert.equal((await setChallengeAssignee(pool, admin, restrictedTriage, memberId, rolesOf)).status, "assignee_cannot_see");
      const assigneeOf = async (number: string) =>
        (await pool.query<{ assignee_id: string | null }>(`select assignee_id from challenges where number = $1`, [number])).rows[0]!.assignee_id;
      assert.equal(await assigneeOf(restricted), null, "a refused assignment changes nothing");
      assert.equal((await setChallengeAssignee(pool, admin, restricted, memberId, rolesOf)).status, "ok");
      // Unassigning needs no visibility check.
      assert.equal((await setChallengeAssignee(pool, admin, openTriage, null, rolesOf)).status, "ok");

      // Bulk: a per-item outcome, while the rest of the selection proceeds.
      const outcomes = await bulkAssign(pool, admin, [restricted, openOrg], outsiderId, rolesOf);
      assert.deepEqual(outcomes, [
        { number: `CH-${restricted}`, status: "assignee_cannot_see" },
        { number: `CH-${openOrg}`, status: "ok" },
      ]);
      assert.equal(await assigneeOf(restricted), memberId, "the refused item keeps its assignee");
      assert.equal(await assigneeOf(openOrg), outsiderId);
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
