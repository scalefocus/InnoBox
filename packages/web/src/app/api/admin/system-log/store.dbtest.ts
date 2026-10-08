// Live-DB integration test (gated) for the §14.7 system log store: capture, listing with every
// filter, the export cap + total, the unseen badge marker, and the GDPR scrub of actor snapshots.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "system log store: capture, filters, search, export cap, unseen marker, scrub",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { countUnseenSystemEvents, exportSystemEvents, listSystemEvents, markSystemLogSeen, recordSystemEvent, scrubSystemEventsForUser } =
      await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const { rows: u } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
        [`dbtest-syslog-${stamp}`, `dbtest-syslog-${stamp}@example.test`, `Dbtest Syslog ${stamp}`, `syslog-${stamp}@example.test`],
      );
      const userId = u[0]!.id;
      const { rows: admin } = await pool.query<{ id: string }>(
        `insert into users (external_id, user_name, display_name, email) values ($1, $2, $3, $4) returning id`,
        [`dbtest-syslog-admin-${stamp}`, `dbtest-syslog-admin-${stamp}@example.test`, `Dbtest Syslog Admin ${stamp}`, `syslog-admin-${stamp}@example.test`],
      );
      const adminId = admin[0]!.id;

      // The badge counts everything before this admin has ever opened the page.
      const unseenBefore = await countUnseenSystemEvents(pool, adminId);
      await markSystemLogSeen(pool, adminId);
      assert.equal(await countUnseenSystemEvents(pool, adminId), 0, "opening the page clears the badge");
      assert.ok(unseenBefore >= 0);

      const marker = `marker-${stamp}`;
      await recordSystemEvent(pool, {
        status: 403,
        method: "get",
        route: "/api/admin/audit",
        path: "/api/admin/audit",
        userId,
        actorName: `Dbtest Syslog ${stamp}`,
        actorEmail: `syslog-${stamp}@example.test`,
        message: `forbidden ${marker}\nsecond line must go`,
        source: "web",
        durationMs: 12.6,
      });
      await recordSystemEvent(pool, {
        status: 503,
        method: "POST",
        route: "/api/challenges/[number]",
        path: "/api/challenges/[number]",
        message: `upstream down ${marker}`,
        errorCode: "TypeError",
        requestId: `req-${stamp}`,
        source: "web",
      });
      await recordSystemEvent(pool, {
        status: 401,
        method: "GET",
        route: "/scim/v2/*",
        path: "/scim/v2/Users",
        message: `scim token ${marker}`,
        source: "worker",
      });

      assert.equal(await countUnseenSystemEvents(pool, adminId), 3, "three new events since the admin last looked");

      const all = await listSystemEvents(pool, { status: "all", q: marker });
      assert.equal(all.total, 3);
      assert.equal(all.events.length, 3);
      assert.equal(all.hasMore, false);
      assert.equal(all.events[0]!.source, "worker", "newest first");
      const forbidden = all.events.find((e) => e.status === 403)!;
      assert.equal(forbidden.method, "GET", "method is normalised to upper case");
      assert.equal(forbidden.message, `forbidden ${marker}`, "one sanitized line");
      assert.equal(forbidden.durationMs, 13);
      assert.equal(forbidden.userId, userId);
      assert.equal(forbidden.actorEmail, `syslog-${stamp}@example.test`);
      const down = all.events.find((e) => e.status === 503)!;
      assert.equal(down.errorCode, "TypeError");
      assert.equal(down.requestId, `req-${stamp}`);
      assert.equal(down.path, "/api/challenges/[number]", "a masked path survives as the template");

      const only5xx = await listSystemEvents(pool, { status: "5xx", q: marker });
      assert.deepEqual(only5xx.events.map((e) => e.status), [503]);
      const only403 = await listSystemEvents(pool, { status: "403", q: marker });
      assert.deepEqual(only403.events.map((e) => e.status), [403]);
      const byUser = await listSystemEvents(pool, { status: "all", userId });
      assert.ok(byUser.events.every((e) => e.userId === userId));
      assert.ok(byUser.events.some((e) => e.message === `forbidden ${marker}`));
      const byEmail = await listSystemEvents(pool, { status: "all", q: `syslog-${stamp}@example` });
      assert.equal(byEmail.total, 1, "search covers the actor e-mail");
      const byCode = await listSystemEvents(pool, { status: "all", q: "TypeErr" });
      assert.ok(byCode.events.some((e) => e.requestId === `req-${stamp}`), "search covers the error code");
      const future = await listSystemEvents(pool, { status: "all", q: marker, from: new Date(Date.now() + 60_000).toISOString() });
      assert.equal(future.total, 0, "the From bound excludes everything older");
      const escaped = await listSystemEvents(pool, { status: "all", q: `%${marker}` });
      assert.equal(escaped.total, 0, "LIKE metacharacters in the search are literal");

      // Paging: pages of 2 over 3 rows.
      const p1 = await listSystemEvents(pool, { status: "all", q: marker }, { limit: 2, offset: 0 });
      assert.equal(p1.events.length, 2);
      assert.equal(p1.hasMore, true);
      const p2 = await listSystemEvents(pool, { status: "all", q: marker }, { limit: 2, offset: 2 });
      assert.equal(p2.events.length, 1);
      assert.equal(p2.hasMore, false);
      const p3 = await listSystemEvents(pool, { status: "all", q: marker }, { limit: 2, offset: 4 });
      assert.equal(p3.events.length, 0);
      assert.equal(p3.total, 3, "an empty page past the end still reports the total");

      // Export: the cap trims the rows but the total still says how many matched.
      const capped = await exportSystemEvents(pool, { status: "all", q: marker }, 2);
      assert.equal(capped.rows.length, 2);
      assert.equal(capped.totalMatching, 3);
      assert.equal(capped.rows[0]!.source, "worker", "newest first");

      // GDPR scrub: the actor snapshot goes, the event itself stays.
      const scrubbed = await scrubSystemEventsForUser(pool, userId);
      assert.equal(scrubbed, 1);
      const afterScrub = await listSystemEvents(pool, { status: "403", q: marker });
      assert.equal(afterScrub.total, 1);
      assert.equal(afterScrub.events[0]!.userId, null);
      assert.equal(afterScrub.events[0]!.actorName, null);
      assert.equal(afterScrub.events[0]!.actorEmail, null);
      assert.equal((await listSystemEvents(pool, { status: "all", q: `syslog-${stamp}@example` })).total, 0, "the e-mail is no longer searchable");
    } finally {
      await pool.end();
    }
  },
);
