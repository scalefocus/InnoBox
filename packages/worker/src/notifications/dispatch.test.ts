// Unit tests for the §12 notification dispatch sweep, against a fake Pool. Graph/SMTP
// sends are exercised via injected fakes (sendGraphMail/nodemailer aren't mocked at the
// module level — instead the test drives the smaller, directly-testable branches: opt-out
// skip, and the failed-row bookkeeping when no transport is configured at all).
//
// The outbox query LEFT JOINs users, so each fake outbox row carries its recipient's
// email/email_notifications_enabled directly (a "missing user" row just has both null).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runNotificationSweep } from "./dispatch.js";

interface FakeRow {
  [key: string]: unknown;
}

function makeFakePool(outbox: FakeRow[]) {
  const updates: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from notification_outbox")) {
        return { rows: outbox, rowCount: outbox.length };
      }
      if (sql.startsWith("update notification_outbox")) {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, updates };
}

test("runNotificationSweep: no pending rows returns a zeroed summary without querying users", async () => {
  const { pool } = makeFakePool([]);
  const summary = await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.deepEqual(summary, { sent: 0, skippedOptOut: 0, failed: 0 });
});

test("runNotificationSweep: opted-out user marks the row sent without attempting delivery", async () => {
  const { pool, updates } = makeFakePool([
    {
      id: "o1",
      user_id: "u1",
      type: "comment_posted",
      payload: { message: "hi", link: "/challenges/1" },
      attempts: 0,
      email: "a@b.com",
      email_notifications_enabled: false,
    },
  ]);
  const summary = await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.deepEqual(summary, { sent: 0, skippedOptOut: 1, failed: 0 });
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.sql, /status = 'sent'/);
});

test("runNotificationSweep: user with no email is treated as opted-out (skipped, not failed)", async () => {
  const { pool } = makeFakePool([
    {
      id: "o1",
      user_id: "u1",
      type: "comment_posted",
      payload: { message: "hi", link: "/challenges/1" },
      attempts: 0,
      email: null,
      email_notifications_enabled: true,
    },
  ]);
  const summary = await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.deepEqual(summary, { sent: 0, skippedOptOut: 1, failed: 0 });
});

test("runNotificationSweep: no transport configured marks the row failed with attempts incremented", async () => {
  const { pool, updates } = makeFakePool([
    {
      id: "o1",
      user_id: "u1",
      type: "comment_posted",
      payload: { message: "hi", link: "/challenges/1" },
      attempts: 2,
      email: "a@b.com",
      email_notifications_enabled: true,
    },
  ]);
  const summary = await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.deepEqual(summary, { sent: 0, skippedOptOut: 0, failed: 1 });
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.sql, /status = 'failed'/);
  assert.match(updates[0]!.sql, /attempts = attempts \+ 1/);
});

test("runNotificationSweep: a missing user row (deleted between write and sweep) is skipped, not failed", async () => {
  const { pool } = makeFakePool([
    {
      id: "o1",
      user_id: "ghost",
      type: "comment_posted",
      payload: { message: "hi", link: "/challenges/1" },
      attempts: 0,
      email: null,
      email_notifications_enabled: null,
    },
  ]);
  const summary = await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.deepEqual(summary, { sent: 0, skippedOptOut: 1, failed: 0 });
});
