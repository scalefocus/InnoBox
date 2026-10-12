// Live-DB integration test (gated) for the SQL twins of canSeeChallenge / canSeeSolution
// (INNOBOX_SPEC.md §4.3, §13.4, invariant 2): pushChallengeVisibilityConditions and
// pushSolutionVisibilityConditions must agree with the JS predicates the detail page uses.
//   - The state rule REPLACES the namespace rule: an author who has lost membership of a restricted
//     namespace still finds their own awaiting_triage/withdrawn item in the gallery, the new-count
//     and search — and nobody outside the author and the namespace's admins does.
//   - A `proposed` solution's narrowing runs inside the ranked query, so hidden matches can never
//     fill the candidate limit ahead of a visible one.
// Self-skips when DATABASE_URL is unset; like the other suites it leaves its rows behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChallengeStatus } from "@innobox/shared";

const url = process.env.DATABASE_URL;

test(
  "challenge visibility SQL: the state rule replaces the namespace rule for the author (gallery, new-count, search)",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, canSeeChallenge } = await import("@innobox/shared");
    const { countNewChallenges, listChallenges } = await import("./store");
    const { search } = await import("../search/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const token = `zv${stamp}`;
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(
        `insert into namespaces (slug, display_name) values ($1, 'Dbtest VisSQL NS') returning id`,
        [`dbtest-vissql-${stamp}`],
      );
      const nsId = nsRows[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-vissql-${label}-${stamp}`, `dbtest-vissql-${label}-${stamp}@example.test`, `Dbtest VisSQL ${label}`],
        );
        return rows[0]!.id;
      };
      const roles = (grants: { role: "namespace_admin" | "committee" | "member"; namespaceId: string }[]) =>
        buildRoleSet(grants, { globalNamespaceId: globalId });

      // The author has LOST membership of the namespace: no grants left.
      const author = { userId: await mkUser("author"), roles: roles([]) };
      // A control with the same (empty) roles: everything the author sees beyond it is their own.
      const control = { userId: await mkUser("control"), roles: roles([]) };
      const member = { userId: await mkUser("member"), roles: roles([{ role: "member", namespaceId: nsId }]) };
      const nsAdmin = { userId: await mkUser("admin"), roles: roles([{ role: "namespace_admin", namespaceId: nsId }]) };

      const mk = async (label: string, status: ChallengeStatus) => {
        const { rows } = await pool.query<{ number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, 'namespace', $2, 'vissql fixture', $3, $4, $5) returning number::text`,
          [nsId, `${label} ${token}`, ia[0]!.id, author.userId, status],
        );
        return { number: `CH-${rows[0]!.number}`, status };
      };
      const triage = await mk("Awaiting", "awaiting_triage");
      const withdrawn = await mk("Withdrawn", "withdrawn");
      const valid = await mk("Valid", "valid");
      const all = [triage, withdrawn, valid];

      // The JS predicate is the reference: each viewer's SQL view must match it exactly.
      const expected = (v: typeof author) =>
        all
          .filter((c) => canSeeChallenge(v, { namespaceId: nsId, visibility: "namespace", status: c.status, authorId: author.userId }))
          .map((c) => c.number)
          .sort();
      assert.deepEqual(expected(author), [triage.number, withdrawn.number].sort(), "fixture sanity: JS shows the author both");

      for (const [name, v] of [
        ["author", author],
        ["control", control],
        ["member", member],
        ["namespace admin", nsAdmin],
      ] as const) {
        const found = (await search(pool, v, token)).challenges.map((c) => c.number).sort();
        assert.deepEqual(found, expected(v), `search agrees with canSeeChallenge for the ${name}`);
      }

      // Gallery: the author's "mine" tab lists their awaiting_triage and withdrawn items.
      const mine = (await listChallenges(pool, author, { tab: "mine", sort: "newest" })).map((c) => c.number);
      assert.ok(mine.includes(triage.number), "own awaiting_triage item in the gallery");
      assert.ok(mine.includes(withdrawn.number), "own withdrawn item in the gallery");
      assert.ok(!mine.includes(valid.number), "the namespace rule still hides the valid item after the membership loss");

      // New-count: exactly the author's two own items more than an identical viewer.
      assert.equal((await countNewChallenges(pool, author)) - (await countNewChallenges(pool, control)), 2);
    } finally {
      await pool.end();
    }
  },
);

test(
  "solution visibility SQL: hidden proposed matches never displace a visible one before the search limit",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { search } = await import("../search/store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().replace(/-/g, "").slice(0, 10);
      const token = `zp${stamp}`;
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`,
          [`dbtest-solsql-${label}-${stamp}`, `dbtest-solsql-${label}-${stamp}@example.test`, `Dbtest SolSQL ${label}`],
        );
        return rows[0]!.id;
      };
      const proposer = await mkUser("proposer");
      const assigneeId = await mkUser("assignee");
      const outsider = { userId: await mkUser("outsider"), roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      const assignee = { userId: assigneeId, roles: buildRoleSet([], { globalNamespaceId: globalId }) };

      const { rows: ch } = await pool.query<{ id: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, assignee_id)
         values ($1, 'org', $2, 'solsql fixture', $3, $4, 'valid', $5) returning id`,
        [globalId, `SolSQL parent ${stamp}`, ia[0]!.id, proposer, assigneeId],
      );
      const challengeId = ch[0]!.id;

      // More hidden `proposed` matches than the search's candidate limit (50), each ranking ABOVE
      // the visible one (the term repeated), so a post-limit filter would return nothing.
      const heavy = Array.from({ length: 8 }, () => token).join(" ");
      for (let i = 0; i < 60; i++) {
        await pool.query(
          `insert into solutions (challenge_id, description, author_id, status) values ($1, $2, $3, 'proposed')`,
          [challengeId, `hidden ${i} ${heavy}`, proposer],
        );
      }
      const { rows: vis } = await pool.query<{ number: string }>(
        `insert into solutions (challenge_id, description, author_id, status) values ($1, $2, $3, 'in_review') returning number::text`,
        [challengeId, `visible ${token}`, proposer],
      );
      const visibleNumber = `SOL-${vis[0]!.number}`;

      const forOutsider = (await search(pool, outsider, token)).solutions;
      assert.deepEqual(
        forOutsider.map((s) => s.number),
        [visibleNumber],
        "the outsider gets the one visible match and none of the proposed ones",
      );

      // The challenge's assignee may see proposed solutions — they rank first for them.
      const forAssignee = (await search(pool, assignee, token)).solutions;
      assert.ok(forAssignee.length > 1, "the assignee sees proposed matches");
      assert.ok(forAssignee.some((s) => s.status === "proposed"));
    } finally {
      await pool.end();
    }
  },
);
