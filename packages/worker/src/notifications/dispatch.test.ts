// Unit tests for the §12 notification dispatch sweep, against a fake Pool. Graph/SMTP
// sends are exercised via injected fakes (sendGraphMail/nodemailer aren't mocked at the
// module level — instead the test drives the smaller, directly-testable branches: opt-out
// skip, and the failed-row bookkeeping when no transport is configured at all).
//
// The outbox query LEFT JOINs users, so each fake outbox row carries its recipient's
// email/email_notifications_enabled directly (a "missing user" row just has both null).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeOutboxEmail,
  emailRetryDelayMinutes,
  emailRetryDelaySeconds,
  MAX_EMAIL_ATTEMPTS,
  renderOutboxEmail,
  runNotificationSweep,
} from "./dispatch.js";

interface FakeRow {
  [key: string]: unknown;
}

function makeFakePool(outbox: FakeRow[]) {
  const updates: { sql: string; params: unknown[] }[] = [];
  const selects: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("from notification_outbox")) {
        selects.push({ sql, params });
        return { rows: outbox, rowCount: outbox.length };
      }
      if (sql.startsWith("update notification_outbox")) {
        updates.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, updates, selects };
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
      email: "a@example.com",
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
      email: "a@example.com",
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

test("runNotificationSweep: a submitter row is not subject to any user preference", async () => {
  const { pool, updates } = makeFakePool([
    {
      id: "o1",
      user_id: null,
      recipient_email: "ann@example.org",
      type: "public_submission_accepted",
      payload: { subject: "Your submission is under review", message: "Thanks.", link: "" },
      attempts: 0,
      email: null,
      email_notifications_enabled: null,
    },
  ]);
  // No transport here, so delivery fails — the point is that it was attempted, not skipped.
  const summary = await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.deepEqual(summary, { sent: 0, skippedOptOut: 0, failed: 1 });
  assert.match(updates[0]!.sql, /status = 'failed'/);
});

test("emailRetryDelayMinutes: exponential 1, 2, 4, 8 … minutes, capped at 60", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map(emailRetryDelayMinutes), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
  assert.equal(emailRetryDelayMinutes(-1), 1, "a nonsensical count never yields a sub-minute delay");
});

test("runNotificationSweep: a failure backs off next_attempt_at by the row's attempt count", async () => {
  const { pool, updates } = makeFakePool([
    {
      id: "o1",
      user_id: "u1",
      type: "comment_posted",
      payload: { message: "hi", link: "/challenges/1" },
      attempts: 3,
      email: "a@example.com",
      email_notifications_enabled: true,
    },
  ]);
  await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.sql, /next_attempt_at = now\(\) \+ make_interval\(secs => \$3::int\)/);
  assert.equal(updates[0]!.params[2], 8 * 60, "the 4th failure waits 8 minutes");
});

test("emailRetryDelaySeconds: the backoff, or a 429's Retry-After when that is later", () => {
  assert.equal(emailRetryDelaySeconds(0), 60, "no Retry-After: the plain backoff");
  assert.equal(emailRetryDelaySeconds(0, 300), 300, "a Retry-After past the backoff wins");
  assert.equal(emailRetryDelaySeconds(3, 30), 8 * 60, "a Retry-After shorter than the backoff never pulls the retry forward");
  assert.equal(emailRetryDelaySeconds(6, 7200), 7200, "Retry-After is honored even past the 60-minute backoff cap");
  assert.equal(emailRetryDelaySeconds(0, 90.2), 91, "a fractional Retry-After rounds up, never early");
  assert.equal(emailRetryDelaySeconds(1, Number.NaN), 120, "a nonsensical Retry-After leaves the backoff alone");
});

test("runNotificationSweep: only due failed rows below the attempt cap are selected", async () => {
  const { pool, selects } = makeFakePool([]);
  await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.equal(selects.length, 1);
  assert.match(selects[0]!.sql, /o\.next_attempt_at is null or o\.next_attempt_at <= now\(\)/);
  assert.equal(selects[0]!.params[1], MAX_EMAIL_ATTEMPTS);
});

// §24.7: an outside submitter's row carries its own fixed subject and links nowhere but, for the
// confirmation only, the public confirm page; a user's row keeps the "innobox: <message>" form.
test("composeOutboxEmail: submitter rows use their own subject and link only when they carry one", () => {
  const base = "https://innobox.example.com";
  const confirm = composeOutboxEmail(
    { recipient_email: "ann@example.org", payload: { subject: "Confirm your submission", message: "Please confirm:", link: "/submit/confirm#tok" } },
    base,
  );
  assert.deepEqual(confirm, { subject: "Confirm your submission", body: "Please confirm:\n\nhttps://innobox.example.com/submit/confirm#tok" });
  const accepted = composeOutboxEmail({ recipient_email: "ann@example.org", payload: { subject: "Your submission is under review", message: "Thanks.", link: "" } }, base);
  assert.deepEqual(accepted, { subject: "Your submission is under review", body: "Thanks." });
  const user = composeOutboxEmail({ recipient_email: null, payload: { message: "CH-1 moved.", link: "/challenges/1" } }, base);
  assert.deepEqual(user, { subject: "innobox: CH-1 moved.", body: "CH-1 moved.\n\nhttps://innobox.example.com/challenges/1" });
});

// §12.1 event 15: a user's row may carry its own fixed subject; the body and link are unchanged.
test("composeOutboxEmail: a user row with its own subject (event 15) keeps it", () => {
  const shared = composeOutboxEmail(
    {
      recipient_email: null,
      payload: { subject: "A challenge has been shared with you", message: 'CH-7 "Faster onboarding" (submitted by Anonymous) has been shared with you.', link: "/challenges/7" },
    },
    "https://innobox.example.com",
  );
  assert.equal(shared.subject, "A challenge has been shared with you");
  assert.equal(shared.body, 'CH-7 "Faster onboarding" (submitted by Anonymous) has been shared with you.\n\nhttps://innobox.example.com/challenges/7');
});

// §24.7: an outside submitter has no account, so no submitter mail carries the "Manage email
// notifications" footer — in either part, with or without the admin wrapper. A user's mail does.
test("renderOutboxEmail: submitter mails carry no manage-notifications footer; user mails do", () => {
  const base = "https://innobox.example.com";
  const wrapper = "<div>[SYSTEM MESSAGE]</div>";
  const confirm = { recipient_email: "ann@example.org", payload: { subject: "Confirm your submission", message: "Please confirm:", link: "/submit/confirm#tok" } };
  const declined = { recipient_email: "ann@example.org", payload: { subject: "About your submission", message: "Not taken further.", link: "" } };
  const user = { recipient_email: null, payload: { message: "CH-1 moved.", link: "/challenges/1" } };
  for (const w of [wrapper, null]) {
    for (const row of [confirm, declined]) {
      const mail = renderOutboxEmail(row, w, base);
      assert.ok(!mail.text.includes("Manage email notifications"), `text, wrapper=${w}`);
      assert.ok(!mail.html.includes("Manage email notifications"), `html, wrapper=${w}`);
      assert.ok(!mail.text.includes("/profile") && !mail.html.includes("/profile"));
    }
    const confirmMail = renderOutboxEmail(confirm, w, base);
    assert.ok(confirmMail.text.includes(`${base}/submit/confirm#tok`), "the confirm link survives");
    const userMail = renderOutboxEmail(user, w, base);
    assert.ok(userMail.text.includes(`Manage email notifications: ${base}/profile`));
    assert.ok(userMail.html.includes("Manage email notifications"));
  }
});
