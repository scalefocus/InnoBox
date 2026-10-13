// Unit tests for the §12.1 digest job's pure halves: which held rows are dropped before rendering
// (read, gone, invisible, malformed), how a kept row becomes a digest update (a coalesced comment
// row counts all its comments), and that both sweeps keep apart — the per-event sweep never
// selects a held row, the digest job only due held rows. Live-DB behaviour is in digest.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { heldRowDropReason, runDigestSweep, toDigestUpdate, type HeldRow } from "./digest.js";
import { runNotificationSweep } from "./dispatch.js";

const row = (over: Partial<HeldRow> = {}): HeldRow => ({
  id: "o1",
  attempts: 0,
  created_at: new Date("2026-10-12T10:00:00Z"),
  payload: {
    message: "m",
    link: "/challenges/1",
    parentType: "challenge",
    parentId: "c1",
    notificationId: "n1",
    digest: { kind: "status", challengeNumber: "1", challengeTitle: "T", statusLabel: "In review" },
  },
  inbox_id: "n1",
  inbox_read_at: null,
  inbox_at: new Date("2026-10-12T10:00:00Z"),
  inbox_count: null,
  ...over,
});

test("heldRowDropReason: a visible, unread row with digest facts goes in", () => {
  assert.equal(heldRowDropReason(row(), true), null);
});

test("heldRowDropReason: read, gone, invisible and malformed rows are dropped", () => {
  assert.equal(heldRowDropReason(row({ inbox_read_at: new Date() }), true), "read", "already read in the inbox — not a second copy");
  assert.equal(heldRowDropReason(row({ inbox_id: null }), true), "gone", "the inbox row went with its item");
  assert.equal(heldRowDropReason(row(), false), "invisible", "no longer visible to the recipient");
  assert.equal(heldRowDropReason(row({ payload: { parentType: "challenge", parentId: "c1" } }), true), "malformed");
});

test("toDigestUpdate: a coalesced comment row counts every comment and is as recent as the latest", () => {
  const u = toDigestUpdate(
    row({
      payload: { digest: { kind: "comment", challengeNumber: "1", challengeTitle: "T" } },
      inbox_count: 4,
      inbox_at: new Date("2026-10-12T12:00:00Z"),
    }),
  );
  assert.equal(u.count, 4);
  assert.equal(u.at.toISOString(), "2026-10-12T12:00:00.000Z");
  assert.equal(u.kind, "comment");
});

test("toDigestUpdate: any other row counts once, at the later of its own and its inbox row's time", () => {
  const u = toDigestUpdate(row({ inbox_count: 9, inbox_at: new Date("2026-10-12T09:00:00Z") }));
  assert.equal(u.count, 1, "only comment rows carry a count");
  assert.equal(u.at.toISOString(), "2026-10-12T10:00:00.000Z");
});

function recordingPool() {
  const selects: string[] = [];
  return {
    selects,
    pool: {
      query: async (sql: string) => {
        selects.push(sql);
        return { rows: [], rowCount: 0 };
      },
    },
  };
}

test("the per-event sweep never selects a row held for a digest", async () => {
  const { pool, selects } = recordingPool();
  await runNotificationSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.match(selects[0]!, /o\.digest_due_at is null/);
});

test("the digest job selects only held rows whose slot has come", async () => {
  const { pool, selects } = recordingPool();
  const summary = await runDigestSweep(pool as never, { graphEnv: null, smtpEnv: null, baseUrl: "https://x" });
  assert.deepEqual(summary, { sent: 0, rowsSent: 0, dropped: 0, discarded: 0, failed: 0 });
  assert.match(selects[0]!, /o\.digest_due_at <= now\(\)/);
});
