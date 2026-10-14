// The §24.8 retention job for public submissions (INNOBOX_SPEC.md §24.8). Data minimization for
// people with no other relationship to the platform:
//   - unconfirmed rows are deleted 7 days after they were created;
//   - declined rows lose the submitter's name and e-mail 90 days after the decision;
//   - accepted rows lose them once `contact_erase_due_at` (90 days after the challenge first
//     reached solved or rejected) has passed — an open challenge keeps them.
// Every erasure is audited as `public_submission.contact_erased` with `trigger: "retention"` (no
// name, no e-mail), and takes any mail still queued for that address with it. The company and the
// submission's own text are kept: they are the challenge's content, not contact data.
// Also drops confirmation e-mails that never went out within their 24-hour link life — the link
// holds the token. Runs on the worker's hourly housekeeping cadence; every step is idempotent and
// day-granular, so running it more often than daily changes nothing.
import type { Pool, PoolClient } from "pg";
import { appendAudit, retentionCutoffs } from "@innobox/shared";

export interface PublicIntakeRetentionSummary {
  deletedUnconfirmed: number;
  erased: number;
  expiredConfirmMails: number;
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function runPublicIntakeRetention(pool: Pool, now: Date = new Date()): Promise<PublicIntakeRetentionSummary> {
  const { unconfirmedBefore, declinedBefore } = retentionCutoffs(now);

  const deletedUnconfirmed = await inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `delete from public_submissions where status = 'unconfirmed' and created_at < $1 returning id`,
      [unconfirmedBefore],
    );
    if (rows.length > 0) {
      await client.query(`delete from notification_outbox where recipient_email is not null and payload->>'submissionId' = any($1::text[])`, [
        rows.map((r) => r.id),
      ]);
    }
    return rows.length;
  });

  const erased = await inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `update public_submissions
          set submitter_name = null, submitter_email = null, requested_emails = '{}', requested_teams = '{}', contact_erased_at = $3
        where contact_erased_at is null
          and ((status = 'declined' and decided_at < $1)
            or (status = 'accepted' and contact_erase_due_at is not null and contact_erase_due_at <= $2))
        returning id`,
      [declinedBefore, now, now],
    );
    if (rows.length === 0) return 0;
    await client.query(`delete from notification_outbox where recipient_email is not null and payload->>'submissionId' = any($1::text[])`, [
      rows.map((r) => r.id),
    ]);
    // Audit rows last in the transaction (the chain trigger's advisory lock, db/migrations/README).
    for (const r of rows) {
      await appendAudit(client, {
        actorUserId: null,
        action: "public_submission.contact_erased",
        targetType: "public_submission",
        targetId: r.id,
        after: { trigger: "retention" },
      });
    }
    return rows.length;
  });

  const expired = await pool.query(
    `delete from notification_outbox
      where recipient_email is not null and type = 'public_submission_confirm' and status <> 'sent'
        and created_at < $1::timestamptz - interval '24 hours'`,
    [now],
  );

  return { deletedUnconfirmed, erased, expiredConfirmMails: expired.rowCount ?? 0 };
}
