// Live-DB integration test (gated) for the discussion summary (INNOBOX_SPEC.md §22.13): the 10-
// comment threshold; egress (pseudonyms, text only, deleted comments excluded); one cached result
// per thread state — served without a call, stale after a new or edited comment; visibility of the
// cached result (only readers of the item); the per-person limits; restricted items; a withdrawn
// item gets none; the §10.3 cascade. The provider is a local stub. Self-skips when DATABASE_URL
// is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "discussion summary: threshold, egress, caching, staleness, visibility, limits, lifecycle",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const support = await import("../dbtest-support");
    const { getSummary, summarize } = await import("./store");
    const { deleteSolution } = await import("../../challenges/delete");

    const pool = new Pool({ connectionString: url });
    const stub = await support.startProviderStub();
    try {
      const key = randomBytes(32);
      const ai = support.testAiClient(pool, key);
      await support.configureAi(pool, key, stub.baseUrl);
      await support.setSwitch(pool, "ai_discussion_summary_enabled", true);
      await support.setSwitch(pool, "ai_restricted_content_enabled", false);
      stub.reply(() => ({ text: JSON.stringify({ summary: "They agree OCR helps.", openQuestions: ["Who pays?"] }) }));

      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const { rows: n } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $1) returning id`, [`dbtest-sum-${stamp}`]);
      const nsId = n[0]!.id;
      const mkUser = async (name: string) =>
        (await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [`dbtest-sum-${name}-${stamp}`, `dbtest-sum-${name}-${stamp}@example.test`, `Dbtest Sum ${name}`])).rows[0]!.id;
      const authorId = await mkUser("author");
      const aliceId = await mkUser("alice");
      const bobId = await mkUser("bob");
      const roles = (ns: string | null) => buildRoleSet(ns ? [{ role: "member", namespaceId: ns }] : [], { globalNamespaceId: globalId });
      const reader = { userId: aliceId, roles: roles(nsId) };
      const outsider = { userId: bobId, roles: roles(null) };
      const platform = { userId: await mkUser("platform"), roles: buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }) };

      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const mkChallenge = async (title: string, visibility: string, ns: string) =>
        (
          await pool.query<{ id: string; number: string }>(
            `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status, is_anonymous)
             values ($1, $2, $3, 'text', $4, $5, 'valid', true) returning id, number::text`,
            [ns, visibility, title, ia[0]!.id, authorId],
          )
        ).rows[0]!;
      const comment = async (parentType: string, parentId: string, author: string, body: string) =>
        (await pool.query<{ id: string }>(`insert into comments (parent_type, parent_id, author_id, body) values ($1, $2, $3, $4) returning id`, [parentType, parentId, author, body])).rows[0]!.id;

      const ch = await mkChallenge("Invoice matching", "org", globalId);
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) ids.push(await comment("challenge", ch.id, [authorId, aliceId, bobId][i % 3]!, `comment ${i}`));

      // 9 comments: below the threshold.
      let view = await getSummary(pool, ai, reader, "challenge", ch.number);
      assert.equal(view?.available, true);
      assert.equal(view?.eligible, false);
      assert.equal((await summarize(pool, ai, reader, "challenge", ch.number)).status, "too_short");

      // A deleted comment does not count and is never sent.
      const deletedId = await comment("challenge", ch.id, bobId, "SECRET deleted text");
      await pool.query(`update comments set deleted_at = now() where id = $1`, [deletedId]);
      assert.equal((await getSummary(pool, ai, reader, "challenge", ch.number))?.eligible, false);
      ids.push(await comment("challenge", ch.id, aliceId, "comment 9"));

      // 10 visible: a summary is made; the prompt holds pseudonyms and text only.
      const first = await summarize(pool, ai, reader, "challenge", ch.number);
      assert.equal(first.status, "ok");
      if (first.status === "ok") assert.equal(first.cached, false);
      const sent = stub.calls.at(-1)!.user;
      assert.ok(sent.includes("Participant A: comment 0") && sent.includes("Participant B: comment 1") && sent.includes("Participant C: comment 2"));
      assert.ok(!sent.includes("SECRET") && !sent.includes("Dbtest Sum"), "no deleted text, no names");
      assert.ok(sent.includes("Invoice matching"));

      // Cached: served without a call, to any reader of the item.
      const calls = stub.calls.length;
      const again = await summarize(pool, ai, platform, "challenge", ch.number);
      assert.equal(again.status === "ok" && again.cached, true);
      assert.equal(stub.calls.length, calls);
      view = await getSummary(pool, ai, outsider, "challenge", ch.number);
      assert.equal(view?.summary?.summary, "They agree OCR helps.", "an org-visible item's summary reaches every reader");
      assert.equal(view?.summary?.stale, false);

      // A new comment → stale; an edit → stale; Refresh makes a new one.
      await comment("challenge", ch.id, bobId, "comment 10");
      assert.equal((await getSummary(pool, ai, reader, "challenge", ch.number))?.summary?.stale, true);
      assert.equal((await summarize(pool, ai, reader, "challenge", ch.number)).status, "ok");
      assert.equal((await getSummary(pool, ai, reader, "challenge", ch.number))?.summary?.stale, false);
      await pool.query(`update comments set body = 'comment 0, edited', edited_at = now() where id = $1`, [ids[0]]);
      assert.equal((await getSummary(pool, ai, reader, "challenge", ch.number))?.summary?.stale, true);

      // Visibility: a namespace-only item's summary never reaches a non-member.
      const hidden = await mkChallenge("Restricted thread", "namespace", nsId);
      for (let i = 0; i < 10; i++) await comment("challenge", hidden.id, i % 2 ? aliceId : authorId, `r ${i}`);
      assert.equal((await getSummary(pool, ai, reader, "challenge", hidden.number))?.available, false, "restricted content may not be sent");
      assert.equal((await summarize(pool, ai, reader, "challenge", hidden.number)).status, "unavailable");
      await support.setSwitch(pool, "ai_restricted_content_enabled", true);
      assert.equal((await summarize(pool, ai, reader, "challenge", hidden.number)).status, "ok");
      assert.equal(await getSummary(pool, ai, outsider, "challenge", hidden.number), null, "a non-member never reaches it");
      assert.equal((await summarize(pool, ai, outsider, "challenge", hidden.number)).status, "not_found");
      await support.setSwitch(pool, "ai_restricted_content_enabled", false);

      // Limits: 10 a minute per person (counted from ai_usage).
      await pool.query(
        `insert into ai_usage (feature, user_id, provider, model, latency_ms, ok)
         select 'discussion_summary', $1, 'openwebui', 'stub-model', 1, true from generate_series(1, 10)`,
        [aliceId],
      );
      assert.equal((await summarize(pool, ai, reader, "challenge", ch.number)).status, "minute");

      // A solution thread; deleting the solution takes its summary with it (§10.3 cascade).
      const { rows: s } = await pool.query<{ id: string; number: string }>(
        `insert into solutions (challenge_id, author_id, description, status) values ($1, $2, 'OCR', 'valid') returning id, number::text`,
        [ch.id, authorId],
      );
      for (let i = 0; i < 10; i++) await comment("solution", s[0]!.id, i % 2 ? bobId : authorId, `s ${i}`);
      const solView = await summarize(pool, ai, platform, "solution", s[0]!.number);
      assert.equal(solView.status, "ok");
      assert.ok(stub.calls.at(-1)!.user.includes("A solution to: Invoice matching"));
      const storage = {
        putObject: async () => {},
        getObject: async () => new Uint8Array(),
        getObjectStream: async () => ({ body: new Blob([]).stream(), contentLength: 0 }),
        deleteObject: async () => {},
        createMultipartUpload: async () => "mpu-1",
        uploadPart: async () => {},
        listParts: async () => [],
        completeMultipartUpload: async () => {},
        abortMultipartUpload: async () => {},
      };
      const del = await deleteSolution({ pool, storage }, platform, s[0]!.number, "dbtest cascade");
      assert.equal(del.status === "ok" && del.counts.aiResults, 1);

      // A withdrawn challenge gets none — and its summary is gone.
      await pool.query(`update challenges set status = 'withdrawn' where id = $1`, [ch.id]);
      const { deleteWithdrawnAiResults } = await import("@innobox/shared/ai");
      await deleteWithdrawnAiResults(pool);
      view = await getSummary(pool, ai, platform, "challenge", ch.number);
      assert.equal(view?.available, false);
      assert.equal(view?.summary, null);

      // Switch off → unavailable.
      await support.setSwitch(pool, "ai_discussion_summary_enabled", false);
      assert.equal((await summarize(pool, ai, platform, "challenge", hidden.number)).status, "unavailable");
    } finally {
      await pool.query(`delete from ai_integration`).catch(() => {});
      await support.setSwitch(pool, "ai_discussion_summary_enabled", false).catch(() => {});
      await support.setSwitch(pool, "ai_restricted_content_enabled", false).catch(() => {});
      await stub.close();
      await pool.end();
    }
  },
);

// Regression: comments written within the same millisecond keep their real order. A JS Date only
// holds milliseconds, so sorting on it tied them and fell back to their random ids, which
// reordered the thread and the participant letters (a flaky CI failure). Here the times differ
// by microseconds and the ids run the other way, so an id tie-break would reverse the thread.
test(
  "discussion summary: comments within one millisecond keep their microsecond order",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID, randomBytes } = await import("node:crypto");
    const { buildRoleSet } = await import("@innobox/shared");
    const support = await import("../dbtest-support");
    const { summarize } = await import("./store");

    const pool = new Pool({ connectionString: url });
    const stub = await support.startProviderStub();
    try {
      const key = randomBytes(32);
      const ai = support.testAiClient(pool, key);
      await support.configureAi(pool, key, stub.baseUrl);
      await support.setSwitch(pool, "ai_discussion_summary_enabled", true);
      stub.reply(() => ({ text: JSON.stringify({ summary: "Ordered.", openQuestions: [] }) }));

      const stamp = randomUUID().slice(0, 8);
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const globalId = g[0]!.id;
      const mkUser = async (name: string) =>
        (await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [`dbtest-sumus-${name}-${stamp}`, `dbtest-sumus-${name}-${stamp}@example.test`, `Dbtest SumUs ${name}`])).rows[0]!.id;
      const users = [await mkUser("a"), await mkUser("b"), await mkUser("c")];
      const reader = { userId: users[0]!, roles: buildRoleSet([], { globalNamespaceId: globalId }) };
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where name = 'Internal'`);
      const { rows: ch } = await pool.query<{ id: string; number: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'text', $3, $4, 'valid') returning id, number::text`,
        [globalId, `Same millisecond ${stamp}`, ia[0]!.id, users[0]],
      );
      // One random prefix per run, then ids that DESCEND while the times ascend by 1 µs each: the
      // earliest comment has the largest id, all ten within the same millisecond.
      const prefix = randomUUID().slice(0, 8);
      for (let i = 0; i < 10; i++) {
        await pool.query(
          `insert into comments (id, parent_type, parent_id, author_id, body, created_at)
           values ($1, 'challenge', $2, $3, $4, '2026-10-13T10:00:00.000100Z'::timestamptz + make_interval(secs => $5::double precision / 1000000))`,
          [`${prefix}-0000-4000-8000-${String(999 - i).padStart(12, "0")}`, ch[0]!.id, users[i % 3], `comment ${i}`, i],
        );
      }

      const out = await summarize(pool, ai, reader, "challenge", ch[0]!.number);
      assert.equal(out.status, "ok");
      const sent = stub.calls.at(-1)!.user;
      const positions = Array.from({ length: 10 }, (_, i) => sent.indexOf(`comment ${i}`));
      assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!)), "the thread keeps its microsecond order");
      assert.ok(sent.includes("Participant A: comment 0") && sent.includes("Participant B: comment 1") && sent.includes("Participant C: comment 2"));
    } finally {
      await pool.query(`delete from ai_integration`).catch(() => {});
      await support.setSwitch(pool, "ai_discussion_summary_enabled", false).catch(() => {});
      await stub.close();
      await pool.end();
    }
  },
);
