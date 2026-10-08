// Live-DB integration test (gated) for the GDPR erasure's optional successor (INNOBOX_SPEC.md §3
// "Optional successor for open assignments", §12.1 event 12, §15): visible non-terminal
// assignments move in the scrub transaction, invisible and terminal ones stay, each move writes
// one ordinary challenge.assigned audit row, the successor gets exactly one summary item, bad
// successors are refused before anything changes, and a failing scrub rolls the moves back.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool as PoolType, PoolClient } from "pg";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL not set — live-DB suite self-skips";

async function importDeps() {
  const { Pool } = await import("pg");
  const { randomUUID } = await import("node:crypto");
  const shared = await import("@innobox/shared");
  return { Pool, randomUUID, shared };
}

/** Users, a restricted namespace and a role resolver for one scenario. */
async function setup(pool: PoolType, label: string) {
  const { randomUUID, shared } = await importDeps();
  const stamp = randomUUID().slice(0, 8);
  const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
  const globalId = g[0]!.id;
  const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Erasure NS') returning id`, [
    `dbtest-er-${label}-${stamp}`,
  ]);
  const nsId = ns[0]!.id;
  const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
  const impactAreaId = ia[0]!.id;

  const mkUser = async (who: string, opts: { active?: boolean; scrubbed?: boolean } = {}) => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into users (external_id, user_name, display_name, email, active, scrubbed_at)
         values ($1, $2, $3, $4, $5, case when $6 then now() else null end) returning id`,
      [`dbtest-er-${who}-${stamp}`, `dbtest-er-${who}-${stamp}@example.test`, `Dbtest ${who} ${stamp}`, `er-${who}-${stamp}@example.test`, opts.active ?? true, opts.scrubbed ?? false],
    );
    return rows[0]!.id;
  };
  const adminId = await mkUser("admin");
  const victimId = await mkUser("victim");
  const successorId = await mkUser("successor");
  const authorId = await mkUser("author");

  // Roles as SCIM membership would resolve them: the admin is a platform admin, everyone else
  // holds only the implicit global membership (so a namespace-restricted item is invisible).
  const resolveRoles = async (userId: string) =>
    shared.buildRoleSet(userId === adminId ? [{ role: "platform_admin", namespaceId: null }] : [], { globalNamespaceId: globalId });

  const mkChallenge = async (opts: { visibility?: "org" | "namespace"; status: string; author?: string; assignee: string; title: string }) => {
    const { rows } = await pool.query<{ id: string; number: string }>(
      `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, assignee_id, status)
         values ($1, $2, $3, 'erasure dbtest', $4, $5, $6, $7) returning id, number::text as number`,
      [nsId, opts.visibility ?? "org", `${opts.title} ${stamp}`, impactAreaId, opts.author ?? authorId, opts.assignee, opts.status],
    );
    return { id: rows[0]!.id, number: `CH-${rows[0]!.number}`, title: `${opts.title} ${stamp}` };
  };

  return { stamp, adminId, victimId, successorId, authorId, mkUser, mkChallenge, resolveRoles };
}

async function assigneeOf(pool: PoolType, challengeId: string): Promise<string | null> {
  const { rows } = await pool.query<{ assignee_id: string | null }>(`select assignee_id from challenges where id = $1`, [challengeId]);
  return rows[0]!.assignee_id;
}

async function isScrubbed(pool: PoolType, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ scrubbed: boolean }>(`select scrubbed_at is not null as scrubbed from users where id = $1`, [userId]);
  return rows[0]!.scrubbed;
}

test("erasure hand-over: moves visible non-terminal assignments, skips invisible + terminal, audits each move, one notification", { skip }, async () => {
  const { Pool, shared } = await importDeps();
  const { scrubUser } = await import("./store");
  const { notifyAssignmentsTransferred } = await import("./erasure-reassignment");
  const pool = new Pool({ connectionString: url });
  try {
    const s = await setup(pool, "move");
    // Moves: org-visible, non-terminal. One authored by the victim (authorship must not move).
    const inReview = await s.mkChallenge({ status: "in_review", assignee: s.victimId, title: "In review", author: s.victimId });
    const valid = await s.mkChallenge({ status: "valid", assignee: s.victimId, title: "Valid" });
    // Skipped (not visible to the successor): namespace-restricted, and awaiting_triage.
    const restricted = await s.mkChallenge({ visibility: "namespace", status: "in_review", assignee: s.victimId, title: "Restricted" });
    const untriaged = await s.mkChallenge({ status: "awaiting_triage", assignee: s.victimId, title: "Untriaged" });
    // Terminal: keep the erased row as historical assignee, never listed.
    const solved = await s.mkChallenge({ status: "solved", assignee: s.victimId, title: "Solved" });
    const rejected = await s.mkChallenge({ status: "rejected", assignee: s.victimId, title: "Rejected" });
    const withdrawn = await s.mkChallenge({ status: "withdrawn", assignee: s.victimId, title: "Withdrawn" });
    // Someone else's assignment is never touched.
    const others = await s.mkChallenge({ status: "in_review", assignee: s.authorId, title: "Others" });

    const result = await scrubUser(pool, s.adminId, s.victimId, { successorId: s.successorId, resolveRoles: s.resolveRoles });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.deepEqual(result.reassignment, {
      successorId: s.successorId,
      moved: [
        { number: inReview.number, title: inReview.title },
        { number: valid.number, title: valid.title },
      ],
      skipped: [
        { number: restricted.number, title: restricted.title, reason: "not_visible" },
        { number: untriaged.number, title: untriaged.title, reason: "not_visible" },
      ],
    });

    assert.equal(await assigneeOf(pool, inReview.id), s.successorId);
    assert.equal(await assigneeOf(pool, valid.id), s.successorId);
    for (const c of [restricted, untriaged, solved, rejected, withdrawn]) assert.equal(await assigneeOf(pool, c.id), s.victimId, `${c.title} stays`);
    assert.equal(await assigneeOf(pool, others.id), s.authorId);

    // Authorship never moves; status untouched; edited_at not stamped.
    const { rows: moved } = await pool.query<{ author_id: string; status: string; edited_at: Date | null }>(
      `select author_id, status, edited_at from challenges where id = $1`,
      [inReview.id],
    );
    assert.equal(moved[0]!.author_id, s.victimId);
    assert.equal(moved[0]!.status, "in_review");
    assert.equal(moved[0]!.edited_at, null);

    // The successor is auto-followed to what moved, and only that.
    const { rows: follows } = await pool.query<{ parent_id: string }>(
      `select parent_id from follows where user_id = $1 and parent_type = 'challenge'`,
      [s.successorId],
    );
    assert.deepEqual(follows.map((f) => f.parent_id).sort(), [inReview.id, valid.id].sort());

    // One ordinary challenge.assigned row per move, the §7.3 shape, actor = the admin.
    const { rows: audits } = await pool.query<{ target_id: string; actor_user_id: string; before: unknown; after: unknown }>(
      `select target_id, actor_user_id, before, after from audit_log
        where action = 'challenge.assigned' and target_id = any($1::text[])`,
      [[inReview.id, valid.id, restricted.id, untriaged.id, solved.id, rejected.id, withdrawn.id]],
    );
    assert.equal(audits.length, 2);
    for (const a of audits) {
      assert.ok([inReview.id, valid.id].includes(a.target_id));
      assert.equal(a.actor_user_id, s.adminId);
      assert.deepEqual(a.before, { assigneeId: s.victimId });
      assert.deepEqual(a.after, { assigneeId: s.successorId });
    }

    const { rows: scrubAudit } = await pool.query<{ after: Record<string, unknown> }>(
      `select after from audit_log where action = 'user.scrubbed' and target_id = $1`,
      [s.victimId],
    );
    assert.equal(scrubAudit.length, 1);
    assert.equal(scrubAudit[0]!.after.reassignedTo, s.successorId);
    assert.equal(scrubAudit[0]!.after.reassignedCount, 2);
    assert.equal(scrubAudit[0]!.after.skippedCount, 2);

    // §12.1 event 12: exactly one summary item (+ one outbox row) for the successor, none for
    // anyone else; the message never names the erased person.
    await notifyAssignmentsTransferred({ pool, actorId: s.adminId, resolveRoles: s.resolveRoles }, result.reassignment!);
    const { rows: notes } = await pool.query<{ user_id: string; payload: Record<string, unknown> }>(
      `select user_id, payload from notifications where type = 'assignments_transferred' and user_id = any($1::uuid[])`,
      [[s.successorId, s.victimId, s.adminId, s.authorId]],
    );
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.user_id, s.successorId);
    assert.equal(notes[0]!.payload.count, 2);
    assert.deepEqual(notes[0]!.payload.numbers, [inReview.number, valid.number]);
    assert.equal(notes[0]!.payload.link, `/challenges/${inReview.number.replace("CH-", "")}`);
    assert.equal(notes[0]!.payload.message, shared.assignmentsTransferredMessage([inReview.number, valid.number]));
    assert.ok(!String(notes[0]!.payload.message).includes(`victim ${s.stamp}`));
    const { rows: outbox } = await pool.query<{ n: string }>(
      `select count(*)::text as n from notification_outbox where type = 'assignments_transferred' and user_id = $1`,
      [s.successorId],
    );
    assert.equal(outbox[0]!.n, "1");
    // No event-7 items were sent per move.
    const { rows: perMove } = await pool.query<{ n: string }>(
      `select count(*)::text as n from notifications where type = 'challenge_assigned' and user_id = $1`,
      [s.successorId],
    );
    assert.equal(perMove[0]!.n, "0");
  } finally {
    await pool.end();
  }
});

test("erasure hand-over: an admin naming themselves sees everything and gets no notification", { skip }, async () => {
  const { Pool } = await importDeps();
  const { scrubUser } = await import("./store");
  const { notifyAssignmentsTransferred } = await import("./erasure-reassignment");
  const pool = new Pool({ connectionString: url });
  try {
    const s = await setup(pool, "self");
    const restricted = await s.mkChallenge({ visibility: "namespace", status: "needs_improvement", assignee: s.victimId, title: "Restricted" });
    const untriaged = await s.mkChallenge({ status: "awaiting_triage", assignee: s.victimId, title: "Untriaged" });

    const result = await scrubUser(pool, s.adminId, s.victimId, { successorId: s.adminId, resolveRoles: s.resolveRoles });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.reassignment!.moved.length, 2, "a platform admin sees restricted and untriaged items");
    assert.equal(result.reassignment!.skipped.length, 0);
    assert.equal(await assigneeOf(pool, restricted.id), s.adminId);
    assert.equal(await assigneeOf(pool, untriaged.id), s.adminId);

    await notifyAssignmentsTransferred({ pool, actorId: s.adminId, resolveRoles: s.resolveRoles }, result.reassignment!);
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from notifications where type = 'assignments_transferred' and user_id = $1`,
      [s.adminId],
    );
    assert.equal(rows[0]!.n, "0", "actors never notify themselves");
  } finally {
    await pool.end();
  }
});

test("erasure without a successor keeps open assignments on the de-identified row", { skip }, async () => {
  const { Pool } = await importDeps();
  const { scrubUser } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const s = await setup(pool, "none");
    const open = await s.mkChallenge({ status: "in_review", assignee: s.victimId, title: "Open" });
    const result = await scrubUser(pool, s.adminId, s.victimId);
    assert.deepEqual(result, { status: "ok", reassignment: null });
    assert.equal(await assigneeOf(pool, open.id), s.victimId);
    const { rows } = await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'user.scrubbed' and target_id = $1`, [s.victimId]);
    assert.equal(rows[0]!.after.reassignedTo, null);
    assert.equal(rows[0]!.after.reassignedCount, 0);
    assert.equal(rows[0]!.after.skippedCount, 0);
  } finally {
    await pool.end();
  }
});

test("erasure hand-over: refuses the erased user, unknown, inactive and scrubbed successors before any change", { skip }, async () => {
  const { Pool, randomUUID } = await importDeps();
  const { scrubUser } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const s = await setup(pool, "refuse");
    const open = await s.mkChallenge({ status: "in_review", assignee: s.victimId, title: "Open" });
    const inactiveId = await s.mkUser("inactive", { active: false });
    const scrubbedId = await s.mkUser("scrubbed", { active: false, scrubbed: true });

    for (const [label, successorId] of [
      ["the erased user", s.victimId],
      ["an unknown id", randomUUID()],
      ["an inactive user", inactiveId],
      ["a scrubbed user", scrubbedId],
    ] as const) {
      const result = await scrubUser(pool, s.adminId, s.victimId, { successorId, resolveRoles: s.resolveRoles });
      assert.equal(result.status, "invalid_successor", label);
      assert.equal(await isScrubbed(pool, s.victimId), false, `${label}: nothing was erased`);
      assert.equal(await assigneeOf(pool, open.id), s.victimId, `${label}: nothing moved`);
    }
    const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where target_id = $1`, [s.victimId]);
    assert.equal(rows[0]!.n, "0", "no user.scrubbed row for a refused erasure");

    // An unknown erased user stays a 404 even with a successor named.
    const missing = await scrubUser(pool, s.adminId, randomUUID(), { successorId: s.successorId, resolveRoles: s.resolveRoles });
    assert.equal(missing.status, "not_found");
  } finally {
    await pool.end();
  }
});

test("erasure hand-over: everything rolls back when the scrub fails after the moves", { skip }, async () => {
  const { Pool } = await importDeps();
  const { scrubUser } = await import("./store");
  const pool = new Pool({ connectionString: url });
  try {
    const s = await setup(pool, "rollback");
    const open = await s.mkChallenge({ status: "in_review", assignee: s.victimId, title: "Open" });

    // A pool whose transaction client fails the final user.scrubbed audit insert — i.e. AFTER
    // the hand-over has already moved the assignment inside the transaction.
    const failing = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, prop) {
            if (prop === "query") {
              return (text: unknown, params?: unknown[]) => {
                if (typeof text === "string" && text.includes("insert into audit_log") && Array.isArray(params) && params[1] === "user.scrubbed") {
                  return Promise.reject(new Error("simulated scrub failure"));
                }
                return (target.query as (t: unknown, p?: unknown[]) => Promise<unknown>)(text, params);
              };
            }
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }) as PoolClient;
      },
    } as unknown as PoolType;

    await assert.rejects(
      scrubUser(failing, s.adminId, s.victimId, { successorId: s.successorId, resolveRoles: s.resolveRoles }),
      /simulated scrub failure/,
    );
    assert.equal(await isScrubbed(pool, s.victimId), false, "the de-identification rolled back");
    assert.equal(await assigneeOf(pool, open.id), s.victimId, "the move rolled back");
    const { rows: audits } = await pool.query<{ n: string }>(
      `select count(*)::text as n from audit_log where action = 'challenge.assigned' and target_id = $1`,
      [open.id],
    );
    assert.equal(audits[0]!.n, "0", "the move's audit row rolled back");
    const { rows: follows } = await pool.query<{ n: string }>(`select count(*)::text as n from follows where user_id = $1`, [s.successorId]);
    assert.equal(follows[0]!.n, "0", "the auto-follow rolled back");
  } finally {
    await pool.end();
  }
});
