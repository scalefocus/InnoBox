// Live-DB integration test (gated) for the §24.8 retention job (INNOBOX_SPEC.md §24.8): unconfirmed
// rows go 7 days after creation, declined rows lose the contact details 90 days after the
// decision, accepted rows once their erase date has passed — and not before; each erasure is
// audited with `trigger: "retention"` and takes queued mail with it; a stale unsent confirmation
// mail is dropped. Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "public submission retention: deletes, erases and audits on schedule",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { runPublicIntakeRetention } = await import("./retention.js");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const now = new Date();
      const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      const mk = async (label: string, status: string, extra: { created?: Date; decided?: Date | null; due?: Date | null }) => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into public_submissions
             (status, title, description, submitter_name, submitter_email, company, confirm_expires_at, pow_salt,
              created_at, confirmed_at, decided_at, contact_erase_due_at)
           values ($1, $2, 'd', 'Ret Name', $3, 'Ret Co', now(), $4, $5, $6, $7, $8)
           returning id`,
          [
            status,
            `Ret ${label} ${stamp}`,
            `ret.${label}.${stamp}@outside.example`,
            `${randomUUID().replace(/-/g, "").slice(0, 24)}?expires=${Date.now()}`,
            extra.created ?? now,
            status === "unconfirmed" ? null : (extra.created ?? now),
            extra.decided ?? null,
            extra.due ?? null,
          ],
        );
        const id = rows[0]!.id;
        await pool.query(`insert into notification_outbox (recipient_email, type, payload) values ($1, 'public_submission_accepted', $2::jsonb)`, [
          `ret.${label}.${stamp}@outside.example`,
          JSON.stringify({ subject: "s", message: "m", link: "", submissionId: id }),
        ]);
        return id;
      };

      const oldUnconfirmed = await mk("old-unconfirmed", "unconfirmed", { created: daysAgo(8) });
      const freshUnconfirmed = await mk("fresh-unconfirmed", "unconfirmed", { created: daysAgo(6) });
      const oldDeclined = await mk("old-declined", "declined", { created: daysAgo(100), decided: daysAgo(91) });
      const freshDeclined = await mk("fresh-declined", "declined", { created: daysAgo(100), decided: daysAgo(89) });
      const dueAccepted = await mk("due-accepted", "accepted", { created: daysAgo(200), decided: daysAgo(199), due: daysAgo(1) });
      const openAccepted = await mk("open-accepted", "accepted", { created: daysAgo(200), decided: daysAgo(199), due: null });
      const stale = await pool.query<{ id: string }>(
        `insert into notification_outbox (recipient_email, type, payload, created_at) values ($1, 'public_submission_confirm', $2::jsonb, now() - interval '25 hours') returning id`,
        [`ret.stale.${stamp}@outside.example`, JSON.stringify({ subject: "s", message: "m", link: "/submit/confirm#t", submissionId: freshUnconfirmed })],
      );

      const summary = await runPublicIntakeRetention(pool, now);
      assert.ok(summary.deletedUnconfirmed >= 1);
      assert.ok(summary.erased >= 2);
      assert.ok(summary.expiredConfirmMails >= 1);

      const row = async (id: string) =>
        (await pool.query<{ submitter_name: string | null; submitter_email: string | null; company: string; contact_erased_at: Date | null }>(
          `select submitter_name, submitter_email, company, contact_erased_at from public_submissions where id = $1`,
          [id],
        )).rows[0];
      assert.equal(await row(oldUnconfirmed), undefined, "unconfirmed after 7 days: deleted");
      assert.ok(await row(freshUnconfirmed), "unconfirmed within 7 days: kept");
      for (const id of [oldDeclined, dueAccepted]) {
        const r = (await row(id))!;
        assert.equal(r.submitter_name, null);
        assert.equal(r.submitter_email, null);
        assert.ok(r.contact_erased_at);
        assert.equal(r.company, "Ret Co", "the company stays");
        const { rows: mail } = await pool.query(`select 1 from notification_outbox where payload->>'submissionId' = $1`, [id]);
        assert.equal(mail.length, 0, "queued mail goes with the address");
        const { rows: audit } = await pool.query(`select actor_user_id, after from audit_log where target_id = $1 and action = 'public_submission.contact_erased'`, [id]);
        assert.equal(audit.length, 1);
        assert.equal(audit[0].actor_user_id, null);
        assert.deepEqual(audit[0].after, { trigger: "retention" });
      }
      for (const id of [freshDeclined, openAccepted]) assert.ok((await row(id))!.submitter_email, "not due yet: kept");
      assert.equal((await pool.query(`select 1 from notification_outbox where id = $1`, [stale.rows[0]!.id])).rows.length, 0, "a stale confirmation mail is dropped");

      // Idempotent: a second run erases nothing new and writes no second audit row.
      await runPublicIntakeRetention(pool, now);
      const { rows: again } = await pool.query(`select count(*)::int as n from audit_log where target_id = $1 and action = 'public_submission.contact_erased'`, [oldDeclined]);
      assert.equal(again[0].n, 1);
    } finally {
      await pool.end();
    }
  },
);
