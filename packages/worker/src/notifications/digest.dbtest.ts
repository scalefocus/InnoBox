// Live-DB integration test (gated) for the §12.1 digest job: a held row is not dispatched before
// its slot (by either sweep); at the slot the job drops rows that were read or are no longer
// visible, and sends the rest as ONE e-mail (here: one failed attempt, backed off together, since
// no transport is configured); rows released by a switch back to immediate go out the same way;
// and with the e-mail switch off the held rows are discarded. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "digest job: held until the slot, drops read and invisible rows, one e-mail per recipient",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { runDigestSweep } = await import("./digest.js");
    const { runNotificationSweep } = await import("./dispatch.js");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const transport = { graphEnv: null, smtpEnv: null, baseUrl: "https://innobox.example.com", batchSize: 1000, userBatch: 1000 };
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const { rows: ns } = await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, 'Dbtest Digest NS') returning id`, [
        `dbtest-digest-${stamp}`,
      ]);
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string, emailOn = true) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email, email_delivery, email_notifications_enabled)
           values ($1, $2, $3, $4, 'daily', $5) returning id`,
          [`dbtest-dj-${label}-${stamp}`, `dbtest-dj-${label}-${stamp}@example.test`, `Dbtest DJ ${label}`, `dj-${label}-${stamp}@example.test`, emailOn],
        );
        return rows[0]!.id;
      };
      const reader = await mkUser("reader");
      const muted = await mkUser("muted", false);
      const mkChallenge = async (title: string, namespaceId: string, visibility: "org" | "namespace") => {
        const { rows } = await pool.query<{ id: string; number: string }>(
          `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
           values ($1, $2, $3, 'digest job', $4, $5, 'valid') returning id, number::text`,
          [namespaceId, visibility, title, ia[0]!.id, muted],
        );
        return rows[0]!;
      };
      const open1 = await mkChallenge(`Open one ${stamp}`, g[0]!.id, "org");
      const open2 = await mkChallenge(`Open two ${stamp}`, g[0]!.id, "org");
      const hidden = await mkChallenge(`Hidden ${stamp}`, ns[0]!.id, "namespace"); // reader is no member

      /** What lib/notify.ts writes for a held event: the inbox row, then the held outbox row. */
      const hold = async (userId: string, challenge: { id: string; number: string }, label: string, due: string) => {
        const payload = { message: `${label} ${stamp}`, link: `/challenges/${challenge.number}`, parentType: "challenge", parentId: challenge.id };
        const { rows: n } = await pool.query<{ id: string }>(`insert into notifications (user_id, type, payload) values ($1, 'status_changed', $2) returning id`, [
          userId,
          JSON.stringify(payload),
        ]);
        const { rows: o } = await pool.query<{ id: string }>(
          `insert into notification_outbox (user_id, type, payload, digest_due_at) values ($1, 'status_changed', $2, now() + $3::interval) returning id`,
          [
            userId,
            JSON.stringify({
              ...payload,
              notificationId: n[0]!.id,
              digest: { kind: "status", challengeNumber: challenge.number, challengeTitle: `t`, statusLabel: "In review" },
            }),
            due,
          ],
        );
        return { inboxId: n[0]!.id, outboxId: o[0]!.id };
      };
      const outbox = async (id: string) =>
        (await pool.query<{ status: string; attempts: number; last_error: string | null }>(`select status, attempts, last_error from notification_outbox where id = $1`, [id]))
          .rows[0]!;

      const keepA = await hold(reader, open1, "keep a", "1 hour");
      const keepB = await hold(reader, open2, "keep b", "1 hour");
      const read = await hold(reader, open1, "read", "1 hour");
      const invisible = await hold(reader, hidden, "invisible", "1 hour");
      const discard = await hold(muted, open1, "discard", "1 hour");

      // Before the slot: neither sweep touches a held row.
      await runNotificationSweep(pool, transport);
      await runDigestSweep(pool, transport);
      for (const r of [keepA, keepB, read, invisible, discard]) assert.equal((await outbox(r.outboxId)).status, "pending", "held until its slot");

      // The slot comes; meanwhile the reader has read one of the updates in the inbox.
      await pool.query(`update notifications set read_at = now() where id = $1`, [read.inboxId]);
      await pool.query(`update notification_outbox set digest_due_at = now() - interval '1 second' where user_id = any($1::uuid[])`, [[reader, muted]]);
      const summary = await runDigestSweep(pool, transport);

      assert.equal((await outbox(read.outboxId)).status, "sent", "a read update is dropped, not sent again");
      assert.equal((await outbox(invisible.outboxId)).status, "sent", "an item the recipient can no longer see is dropped");
      assert.equal((await outbox(discard.outboxId)).status, "sent", "e-mail switch off: discarded at the slot");
      const a = await outbox(keepA.outboxId);
      const b = await outbox(keepB.outboxId);
      assert.equal(a.status, "failed", "no transport configured: the digest send fails and backs off");
      assert.equal(b.status, "failed");
      assert.equal(a.attempts, 1);
      assert.equal(b.attempts, 1);
      assert.ok(summary.failed >= 1);
      assert.ok(summary.dropped >= 2);
      assert.ok(summary.discarded >= 1);

      // One e-mail per recipient: the reader's two kept rows were one attempt, backed off together.
      const { rows: due } = await pool.query<{ next: Date }>(
        `select distinct next_attempt_at as next from notification_outbox where id = any($1::uuid[])`,
        [[keepA.outboxId, keepB.outboxId]],
      );
      assert.equal(due.length, 1, "both rows share the one digest's retry time");

      // A backed-off digest is not retried early, by the job or by the per-event sweep.
      await runDigestSweep(pool, transport);
      await runNotificationSweep(pool, transport);
      assert.equal((await outbox(keepA.outboxId)).attempts, 1);

      // A switch back to immediate releases held rows at once (setEmailDelivery makes them due
      // now) — they still go out as a digest, never one by one through the per-event sweep.
      const released = await hold(reader, open2, "released", "1 week");
      await pool.query(`update users set email_delivery = 'immediate' where id = $1`, [reader]);
      await pool.query(`update notification_outbox set digest_due_at = now() where id = $1`, [released.outboxId]);
      await runNotificationSweep(pool, transport);
      assert.equal((await outbox(released.outboxId)).attempts, 0, "the per-event sweep leaves a released row to the digest job");
      await runDigestSweep(pool, transport);
      assert.equal((await outbox(released.outboxId)).attempts, 1, "the digest job sends it");
    } finally {
      await pool.end();
    }
  },
);

test(
  "digest job §45.5: an innovation board member's held notices pass the send-time check while the item is still in review — and are dropped once they leave the board",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { runDigestSweep } = await import("./digest.js");

    const pool = new Pool({ connectionString: url });
    const onBoard: string[] = [];
    try {
      const stamp = randomUUID().slice(0, 8);
      const transport = { graphEnv: null, smtpEnv: null, baseUrl: "https://innobox.example.com", batchSize: 1000, userBatch: 1000 };
      const { rows: g } = await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`);
      const { rows: ia } = await pool.query<{ id: string }>(`select id from impact_areas where active and name <> 'Client' limit 1`);
      const mkUser = async (label: string) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email, email_delivery) values ($1, $2, $3, $4, 'daily') returning id`,
          [`dbtest-djb-${label}-${stamp}`, `dbtest-djb-${label}-${stamp}@example.test`, `Dbtest DJB ${label}`, `djb-${label}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      const author = await mkUser("author");
      const staying = await mkUser("staying"); // on the board at the slot
      const leaving = await mkUser("leaving"); // taken off the board before the slot
      const outsider = await mkUser("outsider"); // never on the board — the control
      await pool.query(`insert into innovation_board_members (user_id) select u from unnest($1::uuid[]) as u`, [[staying, leaving]]);
      onBoard.push(staying, leaving);

      // An org challenge still in triage, and a proposed solution on an open one.
      const { rows: triage } = await pool.query<{ id: string; number: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'board digest', $3, $4, 'awaiting_triage') returning id, number::text`,
        [g[0]!.id, `Board triage ${stamp}`, ia[0]!.id, author],
      );
      const { rows: open } = await pool.query<{ id: string; number: string }>(
        `insert into challenges (namespace_id, visibility, title, description, impact_area_id, author_id, status)
         values ($1, 'org', $2, 'board digest', $3, $4, 'valid') returning id, number::text`,
        [g[0]!.id, `Board open ${stamp}`, ia[0]!.id, author],
      );
      const { rows: sol } = await pool.query<{ id: string }>(`insert into solutions (challenge_id, description, author_id, status) values ($1, 'board digest', $2, 'proposed') returning id`, [
        open[0]!.id,
        author,
      ]);

      /** A held row as lib/notify.ts writes it for the board route of events 1 and 2, already due. */
      const hold = async (userId: string, type: string, kind: "challenge" | "solution", parentType: "challenge" | "solution", parentId: string, number: string) => {
        const payload = { message: `${kind} ${stamp}`, link: `/challenges/${number}`, parentType, parentId };
        const { rows: n } = await pool.query<{ id: string }>(`insert into notifications (user_id, type, payload) values ($1, $2, $3) returning id`, [userId, type, JSON.stringify(payload)]);
        const { rows: o } = await pool.query<{ id: string }>(
          `insert into notification_outbox (user_id, type, payload, digest_due_at) values ($1, $2, $3, now() - interval '1 second') returning id`,
          [userId, type, JSON.stringify({ ...payload, notificationId: n[0]!.id, digest: { kind, challengeNumber: number, challengeTitle: "t" } })],
        );
        return o[0]!.id;
      };
      const rowsOf = async (userId: string) => ({
        challenge: await hold(userId, "challenge_submitted", "challenge", "challenge", triage[0]!.id, triage[0]!.number),
        solution: await hold(userId, "solution_proposed", "solution", "solution", sol[0]!.id, open[0]!.number),
      });
      const kept = await rowsOf(staying);
      const lost = await rowsOf(leaving);
      const never = await rowsOf(outsider);
      await pool.query(`delete from innovation_board_members where user_id = $1`, [leaving]);

      await runDigestSweep(pool, transport);
      const status = async (id: string) => (await pool.query<{ status: string }>(`select status from notification_outbox where id = $1`, [id])).rows[0]!.status;
      // No transport is configured, so a row that goes INTO a digest ends `failed` (one attempt,
      // backed off); a row dropped by the send-time visibility check is marked `sent`.
      assert.equal(await status(kept.challenge), "failed", "a member's new-challenge notice is kept while the challenge awaits triage");
      assert.equal(await status(kept.solution), "failed", "and their new-solution notice while the solution is still proposed");
      assert.equal(await status(lost.challenge), "sent", "dropped once the person is off the board");
      assert.equal(await status(lost.solution), "sent");
      assert.equal(await status(never.challenge), "sent", "the control: a non-member cannot see either");
      assert.equal(await status(never.solution), "sent");
    } finally {
      if (onBoard.length > 0) await pool.query(`delete from innovation_board_members where user_id = any($1::uuid[])`, [onBoard]).catch(() => {});
      await pool.end();
    }
  },
);
