// Live-DB integration test (gated) for the 15 MCP tools (INNOBOX_SPEC.md §25.4–§25.8, §25.12):
//   • RBAC and visibility, negative cases included: a namespace-restricted challenge is invisible to
//     every tool for an outsider, and to everyone while the restricted switch is off;
//   • anonymous authors are masked in every result; the "via agent" client name is masked on an
//     anonymous item and shown otherwise; mcp_client_name is stored on what a tool creates;
//   • writes go through the API's own store functions: the same audit rows (plus source/client),
//     notifications, follows and §23 awards — via_mcp, Co-Pilot, Agent of Change, Human in the
//     Loop, and the self-reveal replay copying via_mcp;
//   • only the author's own edit and resubmit — never another person's item.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "MCP tools: visibility, restricted switch, masking, via agent, audit, notifications, awards",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { buildRoleSet, DEFAULT_MCP_SETTINGS } = await import("@innobox/shared");
    const store = await import("../../app/api/challenges/store");
    const { listComments } = await import("../../app/api/comments/store");
    const { findTool, runTool } = await import("./tools");
    type ToolContext = import("./tools").ToolContext;

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: nsRows } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest MCP NS') returning id`, [`dbtest-mcp-${stamp}`]);
      const nsId = nsRows[0]!.id;
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
          `dbtest-mcpt-${label}-${stamp}`,
          `dbtest-mcpt-${label}-${stamp}@example.test`,
          `Dbtest mcpt ${label} ${stamp}`,
        ]);
        return rows[0]!.id;
      };
      const roles = new Map<string, ReturnType<typeof buildRoleSet>>();
      const viewer = (id: string, grants: { role: "member" | "namespace_admin" | "platform_admin" | "committee"; namespaceId: string | null }[]) => {
        const r = buildRoleSet(grants, { globalNamespaceId: globalId });
        roles.set(id, r);
        return { userId: id, roles: r };
      };
      const member = viewer(await mkUser("member"), [{ role: "member", namespaceId: nsId }]);
      const outsider = viewer(await mkUser("outsider"), []);
      const nsAdmin = viewer(await mkUser("nsadmin"), [{ role: "namespace_admin", namespaceId: nsId }]);
      // §12.1 event 1 goes to the namespace's admins, resolved from role_mappings: give nsAdmin a real mapping.
      const groupExt = `dbtest-mcpt-admins-${stamp}`;
      const { rows: grp } = await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [groupExt]);
      await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [grp[0]!.id, nsAdmin.userId]);
      await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, 'namespace_admin', $2)`, [groupExt, nsId]);

      const areas = await store.listActiveImpactAreas(pool);
      const internal = areas.find((a) => a.name === "Internal")!;
      const CLIENT = `Dbtest Client ${stamp}`;
      const ctx = (v: { userId: string; roles: ReturnType<typeof buildRoleSet> }, restrictedShared: boolean): ToolContext => ({
        pool,
        viewer: { ...v, orgVisibleOnly: !restrictedShared },
        principal: { userId: v.userId, grantId: randomUUID(), clientRowId: randomUUID(), clientName: CLIENT },
        settings: { ...DEFAULT_MCP_SETTINGS, enabled: true, restrictedContentEnabled: restrictedShared },
        baseUrl: "https://innobox.example.com",
        resolveRoles: async (id: string) => roles.get(id) ?? buildRoleSet([], { globalNamespaceId: globalId }),
      });
      const call = async (c: ToolContext, name: string, args: Record<string, unknown> = {}) => {
        const tool = findTool(`innobox_${name}`);
        assert.ok(tool, name);
        return runTool(tool!, c, args);
      };
      const data = (r: Awaited<ReturnType<typeof call>>) => {
        assert.ok(r.ok, r.ok ? "" : `${r.status} ${r.message}`);
        return (r as { ok: true; data: Record<string, unknown> }).data;
      };
      const statusOf = (r: Awaited<ReturnType<typeof call>>) => (r.ok ? 200 : r.status);
      const audit = async (targetId: string) =>
        (await pool.query<{ action: string; after: Record<string, unknown> }>(`select action, after from audit_log where target_id = $1 order by id`, [targetId])).rows;

      // A namespace-restricted challenge (made in the browser) and an org-visible one.
      const restricted = await store.createChallenge(pool, member, {
        impactAreaId: internal.id,
        namespaceId: nsId,
        title: `Restricted mcpt ${stamp}`,
        description: "restricted body",
        clientName: null,
        visibility: "namespace",
        isAnonymous: false,
      });
      assert.equal(restricted.status, "ok");
      if (restricted.status !== "ok") throw new Error();
      const rNum = restricted.challenge.number.replace("CH-", "");
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, rNum, "valid")).status, "ok");

      // ── §25.5: restricted switch OFF hides it from everyone, the member included ──
      for (const v of [member, nsAdmin, outsider]) {
        const c = ctx(v, false);
        assert.equal(statusOf(await call(c, "get_challenge", { number: rNum })), 404, "get_challenge");
        const hits = data(await call(c, "search_challenges", { query: `Restricted mcpt ${stamp}` })).challenges as unknown[];
        assert.equal(hits.length, 0, "search");
        assert.equal(statusOf(await call(c, "list_comments", { parentType: "challenge", number: rNum })), 404, "list_comments");
        assert.equal(statusOf(await call(c, "post_comment", { parentType: "challenge", number: rNum, body: "x" })), 404, "post_comment");
        assert.equal(statusOf(await call(c, "set_follow", { parentType: "challenge", number: rNum, following: true })), 404, "set_follow");
        assert.equal(statusOf(await call(c, "propose_solution", { challengeNumber: rNum, description: "x" })), 404, "propose");
        const similar = data(await call(c, "find_similar_challenges", { title: `Restricted mcpt ${stamp}`, description: "restricted body" })).similar as { number: string }[];
        assert.ok(!similar.some((s) => s.number === restricted.challenge.number), "similar");
      }
      const mine = data(await call(ctx(member, false), "list_my_items")).challenges as { number: string }[];
      assert.ok(!mine.some((c) => c.number === restricted.challenge.number), "even the author's own items");
      const refused = await call(ctx(member, false), "submit_challenge", { title: "x", description: "y", impactAreaId: internal.id, namespaceId: nsId, visibility: "namespace" });
      assert.deepEqual(refused, { ok: false, status: 403, message: "Namespace-restricted challenges can't be created through an agent here — use the browser." });
      // The switch governs MCP only: the web still shows it to the member.
      assert.ok(await store.getChallengeByNumber(pool, member, rNum));

      // ── switch ON: exactly what the person sees in the browser ──
      assert.equal(data(await call(ctx(member, true), "get_challenge", { number: rNum })).title, `Restricted mcpt ${stamp}`);
      assert.equal(statusOf(await call(ctx(outsider, true), "get_challenge", { number: rNum })), 404, "an outsider still never sees it");
      assert.equal(statusOf(await call(ctx(outsider, true), "post_comment", { parentType: "challenge", number: rNum, body: "x" })), 404);

      // ── submit_challenge: via agent, audit, follow, notification, awards ──
      const sub = data(
        await call(ctx(member, false), "submit_challenge", {
          title: `Agent submitted ${stamp}`,
          description: "Through MCP",
          impactAreaId: internal.id,
          namespaceId: nsId,
          similarAcknowledged: ["CH-1"],
        }),
      );
      assert.equal(sub.status, "awaiting_triage");
      const aNum = String(sub.number).replace("CH-", "");
      assert.equal(sub.url, `https://innobox.example.com/challenges/${aNum}`);
      const { rows: created } = await pool.query<{ id: string; mcp_client_name: string }>(`select id, mcp_client_name from challenges where number = $1`, [aNum]);
      assert.equal(created[0]!.mcp_client_name, CLIENT);
      const aId = created[0]!.id;
      const createdAudit = (await audit(aId)).find((r) => r.action === "challenge.created")!;
      assert.equal(createdAudit.after.source, "mcp");
      assert.equal(createdAudit.after.client, CLIENT);
      assert.deepEqual(createdAudit.after.similarAcknowledged, ["CH-1"]);
      const { rows: follows } = await pool.query(`select 1 from follows where user_id = $1 and parent_id = $2`, [member.userId, aId]);
      assert.equal(follows.length, 1, "the author follows it");
      const { rows: event1 } = await pool.query(`select 1 from notifications where user_id = $1 and type = 'challenge_submitted' and payload->>'parentId' = $2`, [nsAdmin.userId, aId]);
      assert.equal(event1.length, 1, "event 1 reaches the namespace admin");
      const detail = await store.getChallengeByNumber(pool, nsAdmin, aNum);
      assert.deepEqual(detail?.viaAgent, { client: CLIENT }, "the web shows via agent with the client");
      const ledger = async (userId: string) =>
        (await pool.query<{ reason: string; via_mcp: boolean }>(`select reason, via_mcp from gamification_ledger where user_id = $1 order by id`, [userId])).rows;
      assert.deepEqual(await ledger(member.userId), [
        { reason: "challenge_submitted", via_mcp: false },
        { reason: "challenge_validated", via_mcp: false },
        { reason: "challenge_submitted", via_mcp: true },
      ]);
      const badges = async (userId: string) => (await pool.query<{ badge_key: string }>(`select badge_key from user_badges where user_id = $1 order by badge_key`, [userId])).rows.map((r) => r.badge_key);
      assert.ok((await badges(member.userId)).includes("co_pilot"));

      // ── edit: only the author, inside the window; audited with the source ──
      assert.equal(statusOf(await call(ctx(outsider, true), "edit_challenge", { number: aNum, title: "hijack" })), 404, "an outsider cannot even see it (awaiting triage)");
      assert.equal(statusOf(await call(ctx(nsAdmin, true), "edit_challenge", { number: aNum, title: "admin edit" })), 403, "only the author edits");
      assert.equal(data(await call(ctx(member, true), "edit_challenge", { number: aNum, title: `Agent edited ${stamp}` })).title, `Agent edited ${stamp}`);
      const edited = (await audit(aId)).find((r) => r.action === "challenge.edited")!;
      assert.equal(edited.after.title, `Agent edited ${stamp}`);
      assert.equal(edited.after.source, "mcp");

      // ── resubmit: the author's own, from needs_improvement only ──
      assert.equal(statusOf(await call(ctx(member, true), "resubmit", { parentType: "challenge", number: aNum })), 409);
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, aNum, "needs_improvement")).status, "ok");
      assert.equal(statusOf(await call(ctx(nsAdmin, true), "resubmit", { parentType: "challenge", number: aNum })), 403, "not another person's item");
      assert.equal(data(await call(ctx(member, true), "resubmit", { parentType: "challenge", number: aNum })).status, "in_review");
      const resubmitted = (await audit(aId)).filter((r) => r.action === "challenge.status_changed").at(-1)!;
      assert.equal(resubmitted.after.trigger, "author_resubmit");
      assert.equal(resubmitted.after.source, "mcp");

      // ── propose: only while valid; the parent's validation is in the browser ──
      assert.equal(statusOf(await call(ctx(outsider, true), "propose_solution", { challengeNumber: aNum, description: "early" })), 409);
      assert.equal((await store.setChallengeStatus(pool, nsAdmin, aNum, "valid")).status, "ok");
      assert.ok((await badges(member.userId)).includes("human_in_the_loop"), "an agent submission reached valid");
      const sol = data(await call(ctx(outsider, true), "propose_solution", { challengeNumber: aNum, description: "An agent idea", anonymous: true }));
      const sNum = String(sol.number).replace("SOL-", "");
      assert.equal(sol.anonymous, true);
      // Anonymous: masked everywhere, the client name hidden on the tag, no award until self-reveal.
      // A proposed solution is visible to its author and the reviewers (§4.3) — read as the admin.
      const asMember = data(await call(ctx(nsAdmin, true), "get_challenge", { number: aNum }));
      const solSummary = (asMember.solutions as { number: string; author: string }[]).find((s) => s.number === sol.number)!;
      assert.equal(solSummary.author, "Anonymous");
      assert.equal(data(await call(ctx(nsAdmin, true), "get_solution", { number: sNum })).author, "Anonymous");
      assert.equal(statusOf(await call(ctx(member, true), "get_solution", { number: sNum })), 404, "a proposed solution is hidden from others");
      assert.ok(!JSON.stringify(asMember).includes(outsider.userId), "no user id ever leaves a tool");
      const webSolution = (await store.getChallengeByNumber(pool, nsAdmin, aNum))!.solutions.find((s) => s.number === sol.number)!;
      assert.deepEqual(webSolution.viaAgent, { client: null });
      assert.equal((await ledger(outsider.userId)).length, 0);
      assert.equal((await store.selfRevealSolution(pool, outsider, sNum)).status, "ok");
      assert.deepEqual(await ledger(outsider.userId), [{ reason: "solution_proposed", via_mcp: true }], "the replay copies via_mcp from the item");
      assert.ok((await badges(outsider.userId)).includes("agent_of_change"));

      // ── comments and follows ──
      assert.ok(data(await call(ctx(outsider, true), "post_comment", { parentType: "challenge", number: aNum, body: "Agent comment" })).id);
      const webComments = (await listComments(pool, member, "challenge", aId))!;
      assert.deepEqual(webComments.at(-1)!.viaAgent, { client: CLIENT });
      const toolComments = data(await call(ctx(member, true), "list_comments", { parentType: "challenge", number: aNum })).comments as {
        id: string;
        body: string;
        threadRootId: string | null;
        replyToId: string | null;
      }[];
      const agentComment = toolComments.at(-1)!;
      assert.equal(agentComment.body, "Agent comment");
      // §10.2 replies: replyTo answers a comment; the thread fields come back; a bad target is a 422.
      const reply = data(await call(ctx(member, true), "post_comment", { parentType: "challenge", number: aNum, body: "Agent reply", replyTo: agentComment.id }));
      assert.equal(reply.replyToId, agentComment.id);
      assert.equal(reply.threadRootId, agentComment.id);
      const threaded = data(await call(ctx(member, true), "list_comments", { parentType: "challenge", number: aNum })).comments as { body: string; replyToId: string | null }[];
      assert.equal(threaded.find((c) => c.body === "Agent reply")?.replyToId, agentComment.id);
      assert.equal(statusOf(await call(ctx(member, true), "post_comment", { parentType: "challenge", number: aNum, body: "x", replyTo: randomUUID() })), 422);
      const { rows: commentNote } = await pool.query(`select 1 from notifications where user_id = $1 and type = 'comment_posted' and payload->>'parentId' = $2`, [member.userId, aId]);
      assert.equal(commentNote.length, 1, "event 6 reaches the author");
      assert.equal(data(await call(ctx(outsider, true), "set_follow", { parentType: "challenge", number: aNum, following: true })).following, true);
      assert.equal(data(await call(ctx(outsider, true), "set_follow", { parentType: "challenge", number: aNum, following: true })).following, true, "idempotent");
      assert.equal(data(await call(ctx(outsider, true), "set_follow", { parentType: "challenge", number: aNum, following: false })).following, false);

      // ── notifications: listed, never marked read ──
      const inbox = data(await call(ctx(member, true), "list_my_notifications", { unreadOnly: true })).notifications as { message: string; url: string | null }[];
      assert.ok(inbox.length > 0);
      assert.ok(inbox.every((n) => n.url === null || n.url.startsWith("https://innobox.example.com/")));
      const { rows: unread } = await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and read_at is null`, [member.userId]);
      assert.equal(Number(unread[0]!.n), inbox.length >= 25 ? Number(unread[0]!.n) : inbox.length, "nothing was marked read");
      // A notification about the restricted challenge is hidden while the switch is off.
      await pool.query(`insert into notifications (user_id, type, payload) values ($1, 'status_changed', $2)`, [
        member.userId,
        JSON.stringify({ message: "restricted note", link: `/challenges/${rNum}`, parentType: "challenge", parentId: restricted.challenge.id }),
      ]);
      const offInbox = data(await call(ctx(member, false), "list_my_notifications", {})).notifications as { message: string }[];
      assert.ok(!offInbox.some((n) => n.message === "restricted note"));
      const onInbox = data(await call(ctx(member, true), "list_my_notifications", {})).notifications as { message: string }[];
      assert.ok(onInbox.some((n) => n.message === "restricted note"));

      // ── reference data and argument errors ──
      const ref = data(await call(ctx(member, false), "get_reference_data"));
      assert.ok((ref.namespaces as { id: string }[]).some((n) => n.id === nsId));
      assert.equal(ref.restrictedContentShared, false);
      assert.ok(!(data(await call(ctx(outsider, false), "get_reference_data")).namespaces as { id: string }[]).some((n) => n.id === nsId), "only namespaces the person may submit to");
      assert.deepEqual(await call(ctx(member, true), "get_challenge", { number: "abc" }), { ok: false, status: 400, message: "number must be a challenge number such as CH-12" });
      assert.equal(statusOf(await call(ctx(member, true), "search_challenges", { pageSize: 26 })), 400, "at most 25 per page");
    } finally {
      await pool.end();
    }
  },
);
