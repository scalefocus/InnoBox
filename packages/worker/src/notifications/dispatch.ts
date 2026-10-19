// The §12 e-mail delivery sweep: drains pending notification_outbox rows, sending via the
// Graph service account (preferred) or the SMTP fallback, in that order. In-app delivery
// already happened at write time (a separate `notifications` row) — this sweep is e-mail
// only, and honors the per-user opt-out (§12.2: in-app is always on, opt-out affects
// e-mail only). Never throws mid-batch: a single bad row is marked failed and the sweep
// continues, exactly like reconciliation's per-item error isolation. Rows HELD for an e-mail
// digest (digest_due_at set, §12.1) are never picked up here — ./digest.ts sends them, through
// the same transport (deliverEmail) and retry policy.
import type { Pool } from "pg";
import nodemailer from "nodemailer";
import {
  ensureFreshAccessToken,
  getEmailWrapperHtml,
  GraphSendError,
  renderEmailText,
  renderWrappedEmailHtml,
  sendGraphMail,
  textToHtmlFragment,
  type EmailRenderOptions,
  type GraphMailEnv,
} from "@innobox/shared";

import type { SmtpEnv } from "@innobox/shared";
export type { SmtpEnv };

export interface DispatchSummary {
  sent: number;
  skippedOptOut: number;
  failed: number;
}

interface OutboxRow {
  id: string;
  /** Null on a §24.7 row addressed to an outside submitter (`recipient_email` set instead). */
  user_id: string | null;
  recipient_email: string | null;
  type: string;
  payload: { message: string; link: string; subject?: string; [key: string]: unknown };
  attempts: number;
  email: string | null;
  email_notifications_enabled: boolean | null;
  /** §12.1: false once the user is deactivated or erased — the row is discarded like an opt-out. */
  active: boolean | null;
}

/** §24.7: the confirmation e-mail's outbox type — its link carries the token, scrubbed once sent. */
const SUBMITTER_CONFIRM_TYPE = "public_submission_confirm";

/** Subject and plain-text body of one outbox row. A user's row reads "innobox: <message>" — or its
 *  own fixed subject when it carries one (§12.1 event 15) — and links into the app; a §24.7
 *  submitter row carries its own fixed subject and links nowhere but, for the confirmation only,
 *  the public confirm page. */
export function composeOutboxEmail(row: Pick<OutboxRow, "recipient_email" | "payload">, baseUrl: string): { subject: string; body: string } {
  if (typeof row.recipient_email === "string") {
    const link = typeof row.payload.link === "string" && row.payload.link ? `\n\n${baseUrl}${row.payload.link}` : "";
    return { subject: String(row.payload.subject ?? "").slice(0, 200), body: `${row.payload.message}${link}` };
  }
  const subject = typeof row.payload.subject === "string" && row.payload.subject ? row.payload.subject : `innobox: ${row.payload.message}`;
  return { subject: subject.slice(0, 200), body: `${row.payload.message}\n\n${baseUrl}${row.payload.link}` };
}

/** Attempts after which a failed row is left `failed` for good (surfaced only via the admin
 *  e-mail status pill, never spammed). */
export const MAX_EMAIL_ATTEMPTS = 5;

/** §12.1 "retry with backoff": the delay before the next attempt after a failure, given how many
 *  attempts the row had BEFORE this failure — 1, 2, 4, 8 … minutes, capped at 60. Exponential so a
 *  transport outage or a Graph 429 is not hammered every 30 s sweep. */
export function emailRetryDelayMinutes(attemptsBefore: number): number {
  const n = Math.max(0, Math.floor(attemptsBefore));
  return Math.min(2 ** Math.min(n, 6), 60);
}

/** §12.1: the delay, in seconds, before a failed row's next attempt — the backoff, or a Graph
 *  429's `Retry-After` when that is later. A `Retry-After` shorter than the backoff never pulls
 *  the retry forward, and a missing or nonsensical one leaves the backoff alone. */
export function emailRetryDelaySeconds(attemptsBefore: number, retryAfterSeconds?: number): number {
  const backoff = emailRetryDelayMinutes(attemptsBefore) * 60;
  return retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > backoff
    ? Math.ceil(retryAfterSeconds)
    : backoff;
}

/** Marks a row failed: one more attempt, the last error, and the delayed next-attempt time. */
export const MARK_FAILED_SQL = `update notification_outbox
    set status = 'failed', attempts = attempts + 1, last_error = $2,
        next_attempt_at = now() + make_interval(secs => $3::int)
  where id = $1`;

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

async function sendViaSmtp(env: SmtpEnv, to: string, subject: string, text: string, html: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: env.host,
    port: env.port,
    secure: env.secure,
    auth: env.user && env.password ? { user: env.user, pass: env.password } : undefined,
  });
  await transport.sendMail({ from: env.from, to, subject, text, html });
}

export interface EmailTransportOptions {
  graphEnv: GraphMailEnv | null;
  smtpEnv: SmtpEnv | null;
  baseUrl: string;
}

/** The text and HTML parts of a mail whose body is `message`. §12 e-mail content safety: the text
 *  is escaped and only links to the app's own origin (PUBLIC_BASE_URL) become anchors — with or
 *  without an admin wrapper. `footer: false` drops the "Manage email notifications" footer, for a
 *  §24.7 mail to an outside submitter (no account, no profile). */
export function renderEmailParts(message: string, wrapper: string | null, baseUrl: string, opts: EmailRenderOptions = {}): { text: string; html: string } {
  const text = renderEmailText(message, baseUrl, opts);
  const html = wrapper ? renderWrappedEmailHtml(wrapper, message, baseUrl, opts) : `<p>${textToHtmlFragment(text, baseUrl)}</p>`;
  return { text, html };
}

/** One outbox row's subject and both body parts. §24.7: a submitter row has no account to manage,
 *  so it carries no "Manage email notifications" footer; every user row does. */
export function renderOutboxEmail(
  row: Pick<OutboxRow, "recipient_email" | "payload">,
  wrapper: string | null,
  baseUrl: string,
): { subject: string; text: string; html: string } {
  const { subject, body } = composeOutboxEmail(row, baseUrl);
  return { subject, ...renderEmailParts(body, wrapper, baseUrl, { footer: typeof row.recipient_email !== "string" }) };
}

export interface DeliveryOutcome {
  delivered: boolean;
  lastError: string | null;
  /** A Graph 429: the caller stops its batch, and retries no earlier than `retryAfterSeconds`. */
  rateLimited: boolean;
  retryAfterSeconds?: number;
}

/** One mail through the §12.1 transports: Graph (needs the connected mailbox AND a saved wrapper),
 *  then the SMTP fallback. Never throws for a send failure — the outcome says what happened. */
export async function deliverEmail(
  pool: Pool,
  opts: EmailTransportOptions,
  wrapper: string | null,
  mail: { to: string; subject: string; text: string; html: string },
): Promise<DeliveryOutcome> {
  const outcome: DeliveryOutcome = { delivered: false, lastError: null, rateLimited: false };
  if (opts.graphEnv && wrapper) {
    const token = await ensureFreshAccessToken(pool, opts.graphEnv);
    if (token.ok) {
      try {
        await sendGraphMail(opts.graphEnv, token.accessToken, mail);
        outcome.delivered = true;
      } catch (err) {
        outcome.lastError = `graph: ${String((err as Error).message ?? err)}`.slice(0, 500);
        if (err instanceof GraphSendError && err.status === 429) {
          outcome.rateLimited = true;
          outcome.retryAfterSeconds = err.retryAfterSeconds;
        }
      }
    } else {
      outcome.lastError = `graph: ${token.reason}${token.error ? ` (${token.error})` : ""}`;
    }
  }

  if (!outcome.delivered && opts.smtpEnv) {
    try {
      await sendViaSmtp(opts.smtpEnv, mail.to, mail.subject, mail.text, mail.html);
      outcome.delivered = true;
    } catch (err) {
      outcome.lastError = `smtp: ${String((err as Error).message ?? err)}`.slice(0, 500);
    }
  }
  return outcome;
}

/** The outbox rows a sweep may (re)try: pending, or failed below the attempt cap once due. Both
 *  sweeps share it, aliased `o`; $2 is MAX_EMAIL_ATTEMPTS. */
export const OUTBOX_DUE_SQL = `(o.status = 'pending'
         or (o.status = 'failed' and o.attempts < $2
             and (o.next_attempt_at is null or o.next_attempt_at <= now())))`;

export async function runNotificationSweep(pool: Pool, opts: EmailTransportOptions & { batchSize?: number }): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, skippedOptOut: 0, failed: 0 };
  // At-least-once with retry and backoff (§12.1): a 'failed' row is retried once its
  // next_attempt_at has passed (exponential, emailRetryDelayMinutes), up to MAX_EMAIL_ATTEMPTS
  // attempts, then left failed (surfaced only via the admin email status pill, no spam). A
  // failed row from before the backoff column existed has next_attempt_at null → due now.
  // The recipient's email/opt-out flag is joined in here rather than looked up per row —
  // a LEFT JOIN (not INNER) so a row whose user has since vanished still surfaces (and gets
  // skipped below) instead of silently never being processed at all. A row held for a digest
  // (§12.1) is left to the digest job, due or not. `active` is re-read at send time (§12.1): a
  // user deactivated or erased since the row was written gets nothing, like an opt-out.
  const { rows } = await pool.query<OutboxRow>(
    `select o.id, o.user_id, o.recipient_email, o.type, o.payload, o.attempts, u.email, u.email_notifications_enabled,
            (u.active and u.scrubbed_at is null) as active
       from notification_outbox o
       left join users u on u.id = o.user_id
      where o.digest_due_at is null and ${OUTBOX_DUE_SQL}
      order by o.created_at limit $1`,
    [opts.batchSize ?? 50, MAX_EMAIL_ATTEMPTS],
  );
  if (rows.length === 0) return summary;

  const wrapper = opts.graphEnv ? await getEmailWrapperHtml(pool) : null;

  for (const row of rows) {
    // Graph rate-limit (429): stop the rest of this batch so we don't keep hammering the API.
    // The current row is recorded failed and backed off like any other failure, but no earlier
    // than Graph's Retry-After (the rest of the batch is simply picked up next sweep).
    try {
      // §24.7: a submitter row has no user and no preference — it goes to its address as is (an
      // erasure deletes the row first, so an erased address is never reached).
      const submitter = typeof row.recipient_email === "string";
      if (submitter ? !row.recipient_email : !row.email || !row.email_notifications_enabled || !row.active) {
        await pool.query(`update notification_outbox set status = 'sent', sent_at = now() where id = $1`, [row.id]);
        summary.skippedOptOut += 1;
        continue;
      }
      const recipientEmail = (submitter ? row.recipient_email : row.email) as string;

      const { subject, text, html } = renderOutboxEmail(row, wrapper, opts.baseUrl);
      const { delivered, lastError, rateLimited, retryAfterSeconds } = await deliverEmail(pool, opts, wrapper, { to: recipientEmail, subject, text, html });

      if (delivered) {
        // §24.5: once the confirmation is out, its token (in the link) is not kept here.
        await pool.query(
          `update notification_outbox set status = 'sent', sent_at = now(),
                  payload = case when type = $2 then payload - 'link' else payload end
            where id = $1`,
          [row.id, SUBMITTER_CONFIRM_TYPE],
        );
        summary.sent += 1;
      } else {
        await pool.query(MARK_FAILED_SQL, [
          row.id,
          lastError ?? "no transport configured",
          emailRetryDelaySeconds(row.attempts, rateLimited ? retryAfterSeconds : undefined),
        ]);
        summary.failed += 1;
        if (rateLimited) {
          log("warn", "graph rate-limited (429) — stopping sweep, will resume next cycle", { outboxId: row.id, retryAfterSeconds });
          break;
        }
      }
    } catch (err) {
      log("error", "notification dispatch row failed", { outboxId: row.id, error: String(err) });
      await pool
        .query(MARK_FAILED_SQL, [row.id, String((err as Error).message ?? err).slice(0, 500), emailRetryDelaySeconds(row.attempts)])
        .catch(() => {});
      summary.failed += 1;
    }
  }
  return summary;
}
