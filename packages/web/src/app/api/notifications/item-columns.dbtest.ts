// Live-DB integration test (gated) for what an inbox row is about, as columns (INNOBOX_SPEC.md §5
// `notifications`, §12.1 read-time gate, §10.4, migration 0051, v1.18):
//  - the trigger derives challenge_id / solution_id from every payload shape a writer uses —
//    solution parent (both ids), challenge parent, a comment row's challengeId, and the bare deep
//    link (`/challenges/<n>`, `…#SOL-<m>`) — and leaves both null for a row that names no item or
//    names one that does not exist;
//  - a value a caller supplies is overwritten, and a payload update (coalescing) re-derives;
//  - the bell list's unreadCount equals the §12.2 pulse count, under the same gates;
//  - a link-only row now follows the visibility and trash gates like a keyed one;
//  - opening a challenge marks its comment/hype rows read — the challenge's own AND its solutions'.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "§5/§12.1 notification item columns: derived on write, gate by primary key, same count everywhere",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const { getInbox, countUnread, listInboxPage } = await import("./store");
    const { markCommentNotificationsReadForChallenge } = await import("../../../lib/notify");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest ItemCols NS') returning id`, [
        `dbtest-itemcols-${stamp}`,
      ]);
      const nsId = ns[0]!.id;
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
          [`dbtest-itemcols-${label}-${stamp}`, `dbtest-itemcols-${label}-${stamp}@example.test`, `Dbtest ItemCols ${label}`, `itemcols-${label}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      const authorId = await mkUser("author");
      const viewer = { userId: await mkUser("viewer"), roles: buildRoleSet([], { globalNamespaceId: globalId }) };

      const mkChallenge = async (title: string) => {
        const { rows } = await pool.query<{ id: string; number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, 'org', $2, 'item columns fixture', $3, $4, 'valid') returning id, number::text`,
          [nsId, `${title} ${stamp}`, ia[0]!.id, authorId],
        );
        return rows[0]!;
      };
      const ch = await mkChallenge("ItemCols");
      const other = await mkChallenge("ItemCols other");
      const { rows: sol } = await pool.query<{ id: string; number: string }>(
        `insert into solutions (challenge_id, description, author_id, status) values ($1, 'sol', $2, 'in_review') returning id, number::text`,
        [ch.id, authorId],
      );
      const solution = sol[0]!;

      const insert = async (type: string, payload: Record<string, unknown>, extra: { challengeId?: string; solutionId?: string } = {}) => {
        const { rows } = await pool.query<{ id: string; challenge_id: string | null; solution_id: string | null }>(
          `insert into notifications (user_id, type, payload, challenge_id, solution_id) values ($1, $2, $3, $4, $5)
           returning id, challenge_id, solution_id`,
          [viewer.userId, type, JSON.stringify(payload), extra.challengeId ?? null, extra.solutionId ?? null],
        );
        return rows[0]!;
      };
      const msg = (m: string) => ({ message: `${m} ${stamp}` });

      // ── derivation, one payload shape at a time ──────────────────────────────────────────
      const bySolution = await insert("status_changed", { ...msg("sol"), link: `/challenges/${ch.number}#SOL-${solution.number}`, parentType: "solution", parentId: solution.id });
      assert.deepEqual([bySolution.challenge_id, bySolution.solution_id], [ch.id, solution.id], "a solution row carries its challenge too");

      const byChallenge = await insert("status_changed", { ...msg("ch"), link: `/challenges/${ch.number}`, parentType: "challenge", parentId: ch.id });
      assert.deepEqual([byChallenge.challenge_id, byChallenge.solution_id], [ch.id, null]);

      const commentOnSolution = await insert("comment_posted", {
        ...msg("comment"),
        link: `/challenges/${ch.number}#SOL-${solution.number}`,
        parentType: "solution",
        parentId: solution.id,
        challengeId: ch.id,
        count: 1,
      });
      assert.deepEqual([commentOnSolution.challenge_id, commentOnSolution.solution_id], [ch.id, solution.id]);

      const challengeIdOnly = await insert("comment_posted", { ...msg("cid"), link: "/x", challengeId: ch.id, count: 1 });
      assert.deepEqual([challengeIdOnly.challenge_id, challengeIdOnly.solution_id], [ch.id, null], "challengeId alone");

      const linkOnly = await insert("status_changed", { ...msg("link"), link: `/challenges/${ch.number}` });
      assert.deepEqual([linkOnly.challenge_id, linkOnly.solution_id], [ch.id, null], "a pre-target row resolves by its link");

      const solLinkOnly = await insert("status_changed", { ...msg("sollink"), link: `/challenges/${ch.number}#SOL-${solution.number}` });
      assert.deepEqual([solLinkOnly.challenge_id, solLinkOnly.solution_id], [ch.id, solution.id], "…and a solution link to both");

      const wrongSolLink = await insert("status_changed", { ...msg("wrongsol"), link: `/challenges/${other.number}#SOL-${solution.number}` });
      assert.deepEqual([wrongSolLink.challenge_id, wrongSolLink.solution_id], [other.id, null], "a SOL number under the wrong challenge is not that solution");

      const noItem = await insert("achievement_earned", { ...msg("ach"), link: "/me" });
      assert.deepEqual([noItem.challenge_id, noItem.solution_id], [null, null]);

      const ghost = await insert("status_changed", { ...msg("ghost"), link: "/challenges/999999999999", parentType: "challenge", parentId: randomUUID() });
      assert.deepEqual([ghost.challenge_id, ghost.solution_id], [null, null], "an item that does not exist resolves to nothing");

      const junk = await insert("status_changed", { ...msg("junk"), link: "/challenges/12abc", parentType: "solution", parentId: "not-a-uuid", challengeId: 42 });
      assert.deepEqual([junk.challenge_id, junk.solution_id], [null, null], "malformed keys never raise, never match");

      const forged = await insert("achievement_earned", { ...msg("forged"), link: "/me" }, { challengeId: other.id, solutionId: solution.id });
      assert.deepEqual([forged.challenge_id, forged.solution_id], [null, null], "a supplied value is overwritten — the columns are derived, never written");

      // A payload update (what coalescing does) re-derives; a read_at update leaves them alone.
      const { rows: moved } = await pool.query<{ challenge_id: string | null }>(
        `update notifications set payload = $2::jsonb where id = $1 returning challenge_id`,
        [noItem.id, JSON.stringify({ ...msg("moved"), link: `/challenges/${other.number}` })],
      );
      assert.equal(moved[0]!.challenge_id, other.id);

      // ── the list's unreadCount is the pulse count, under the same gates ──────────────────
      const inbox = await getInbox(pool, viewer);
      assert.equal(inbox.unreadCount, await countUnread(pool, viewer));
      assert.equal(inbox.unreadCount, inbox.notifications.filter((n) => !n.read).length, "fewer than 50 rows: the page holds them all");

      // ── a link-only row now follows the gates like a keyed one ───────────────────────────
      await pool.query(`update challenges set visibility = 'namespace' where id = $1`, [ch.id]);
      const hidden = new Set((await getInbox(pool, viewer)).notifications.map((n) => n.id));
      for (const r of [bySolution, byChallenge, commentOnSolution, challengeIdOnly, linkOnly, solLinkOnly]) {
        assert.equal(hidden.has(r.id), false, "every row about the narrowed challenge is hidden from a non-member");
      }
      assert.equal(hidden.has(noItem.id), true, "a row about another, visible challenge stays");
      assert.equal(hidden.has(ghost.id), true, "a row that names nothing resolvable is never gated");
      assert.equal((await getInbox(pool, viewer)).unreadCount, await countUnread(pool, viewer));
      // §25.5 agent view: the same column, restricted challenges left out.
      const agent = await listInboxPage(pool, viewer.userId, { limit: 50, offset: 0, orgVisibleOnly: true });
      assert.equal(agent.notifications.some((n) => n.id === linkOnly.id), false);
      await pool.query(`update challenges set visibility = 'org' where id = $1`, [ch.id]);

      // Trash: a trashed solution hides its rows; its challenge's own rows stay.
      await pool.query(`update solutions set trashed_at = now(), trashed_by = $2, trash_reason = 'item columns fixture' where id = $1`, [solution.id, authorId]);
      const afterTrash = new Set((await getInbox(pool, viewer)).notifications.map((n) => n.id));
      assert.equal(afterTrash.has(bySolution.id), false);
      assert.equal(afterTrash.has(solLinkOnly.id), false);
      assert.equal(afterTrash.has(byChallenge.id), true);
      await pool.query(`update solutions set trashed_at = null, trashed_by = null, trash_reason = null where id = $1`, [solution.id]);

      // ── opening the challenge reads its comment rows, the solution's included ────────────
      await markCommentNotificationsReadForChallenge(pool, viewer.userId, ch.id);
      const { rows: readState } = await pool.query<{ id: string; read: boolean }>(
        `select id, read_at is not null as read from notifications where id = any($1::uuid[])`,
        [[commentOnSolution.id, challengeIdOnly.id, bySolution.id]],
      );
      const read = new Map(readState.map((r) => [r.id, r.read]));
      assert.equal(read.get(commentOnSolution.id), true, "a comment on one of its solutions");
      assert.equal(read.get(challengeIdOnly.id), true, "a comment on the challenge");
      assert.equal(read.get(bySolution.id), false, "not a comment row — untouched");

      // The old per-type payload indexes are gone; the column indexes exist.
      const { rows: idx } = await pool.query<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'notifications'`);
      const names = new Set(idx.map((r) => r.indexname));
      for (const n of ["notifications_user_challenge_unread_idx", "notifications_challenge_idx", "notifications_solution_idx"]) assert.ok(names.has(n), n);
      for (const n of ["notifications_comment_challenge_idx", "notifications_hyped_challenge_idx"]) assert.equal(names.has(n), false, n);
    } finally {
      await pool.end();
    }
  },
);
