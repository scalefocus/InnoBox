// E-mails to an outside submitter (INNOBOX_SPEC.md §24.7): ordinary `notification_outbox` rows
// with `recipient_email` set and no `user_id`, swept by the worker through the normal transport,
// wrapper and retry policy. They are never held for a digest and no user preference applies. The
// row carries the submission id so an erasure (§24.8) can withdraw anything still unsent: no mail
// goes out once the contact details are gone. Relative imports only (no `@/`) so the gated
// .dbtest.ts suites run under the plain node runner.
import type { Pool, PoolClient } from "pg";
import { submitterOutboxType, type SubmitterEmail } from "@innobox/shared";

type Db = Pool | PoolClient;

/** Queue one submitter e-mail. A null address (already erased) queues nothing. */
export async function enqueueSubmitterEmail(db: Db, submissionId: string, email: string | null, mail: SubmitterEmail): Promise<void> {
  if (!email) return;
  await db.query(`insert into notification_outbox (recipient_email, type, payload) values ($1, $2, $3::jsonb)`, [
    email,
    submitterOutboxType(mail.kind),
    JSON.stringify({ subject: mail.subject, message: mail.message, link: mail.link, submissionId }),
  ]);
}

/** Drop every outbox row addressed to a submission's submitter (§24.8 erasure, §10.3 purge): the
 *  unsent ones must not go out, and the sent ones would keep the address. */
export async function withdrawSubmitterEmails(db: Db, submissionId: string): Promise<void> {
  await db.query(`delete from notification_outbox where recipient_email is not null and payload->>'submissionId' = $1`, [submissionId]);
}
