// The §12 e-mail delivery sweep: drains pending notification_outbox rows, sending via the
// Graph service account (preferred) or the SMTP fallback, in that order. In-app delivery
// already happened at write time (a separate `notifications` row) — this sweep is e-mail
// only, and honors the per-user opt-out (§12.2: in-app is always on, opt-out affects
// e-mail only). Never throws mid-batch: a single bad row is marked failed and the sweep
// continues, exactly like reconciliation's per-item error isolation.
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
  type GraphMailEnv,
} from "@innobox/shared";

export interface SmtpEnv {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export interface DispatchSummary {
  sent: number;
  skippedOptOut: number;
  failed: number;
}

interface OutboxRow {
  id: string;
  user_id: string;
  type: string;
  payload: { message: string; link: string; [key: string]: unknown };
  attempts: number;
  email: string | null;
  email_notifications_enabled: boolean | null;
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

/** Marks a row failed: one more attempt, the last error, and the backed-off next-attempt time. */
const MARK_FAILED_SQL = `update notification_outbox
    set status = 'failed', attempts = attempts + 1, last_error = $2,
        next_attempt_at = now() + make_interval(mins => $3::int)
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

export async function runNotificationSweep(
  pool: Pool,
  opts: { graphEnv: GraphMailEnv | null; smtpEnv: SmtpEnv | null; baseUrl: string; batchSize?: number },
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, skippedOptOut: 0, failed: 0 };
  // At-least-once with retry and backoff (§12.1): a 'failed' row is retried once its
  // next_attempt_at has passed (exponential, emailRetryDelayMinutes), up to MAX_EMAIL_ATTEMPTS
  // attempts, then left failed (surfaced only via the admin email status pill, no spam). A
  // failed row from before the backoff column existed has next_attempt_at null → due now.
  // The recipient's email/opt-out flag is joined in here rather than looked up per row —
  // a LEFT JOIN (not INNER) so a row whose user has since vanished still surfaces (and gets
  // skipped below) instead of silently never being processed at all.
  const { rows } = await pool.query<OutboxRow>(
    `select o.id, o.user_id, o.type, o.payload, o.attempts, u.email, u.email_notifications_enabled
       from notification_outbox o
       left join users u on u.id = o.user_id
      where o.status = 'pending'
         or (o.status = 'failed' and o.attempts < $2
             and (o.next_attempt_at is null or o.next_attempt_at <= now()))
      order by o.created_at limit $1`,
    [opts.batchSize ?? 50, MAX_EMAIL_ATTEMPTS],
  );
  if (rows.length === 0) return summary;

  const wrapper = opts.graphEnv ? await getEmailWrapperHtml(pool) : null;

  for (const row of rows) {
    // Graph rate-limit (429): stop the rest of this batch so we don't keep hammering the API.
    // The current row is recorded failed and backed off like any other failure (the rest of
    // the batch is simply picked up next sweep). Set below.
    let rateLimited = false;
    try {
      if (!row.email || !row.email_notifications_enabled) {
        await pool.query(`update notification_outbox set status = 'sent', sent_at = now() where id = $1`, [row.id]);
        summary.skippedOptOut += 1;
        continue;
      }
      const recipientEmail = row.email;

      const subject = `innobox: ${row.payload.message}`.slice(0, 200);
      const text = renderEmailText(`${row.payload.message}\n\n${opts.baseUrl}${row.payload.link}`, opts.baseUrl);
      // §12 e-mail content safety: the message text is escaped and only links to the app's own
      // origin (PUBLIC_BASE_URL) become anchors — with or without an admin wrapper.
      const html = wrapper
        ? renderWrappedEmailHtml(wrapper, `${row.payload.message}\n\n${opts.baseUrl}${row.payload.link}`, opts.baseUrl)
        : `<p>${textToHtmlFragment(text, opts.baseUrl)}</p>`;

      let delivered = false;
      let lastError: string | null = null;

      if (opts.graphEnv && wrapper) {
        const token = await ensureFreshAccessToken(pool, opts.graphEnv);
        if (token.ok) {
          try {
            await sendGraphMail(opts.graphEnv, token.accessToken, { to: recipientEmail, subject, text, html });
            delivered = true;
          } catch (err) {
            lastError = `graph: ${String((err as Error).message ?? err)}`.slice(0, 500);
            if (err instanceof GraphSendError && err.status === 429) rateLimited = true;
          }
        } else {
          lastError = `graph: ${token.reason}${token.error ? ` (${token.error})` : ""}`;
        }
      }

      if (!delivered && opts.smtpEnv) {
        try {
          await sendViaSmtp(opts.smtpEnv, recipientEmail, subject, text, html);
          delivered = true;
        } catch (err) {
          lastError = `smtp: ${String((err as Error).message ?? err)}`.slice(0, 500);
        }
      }

      if (delivered) {
        await pool.query(`update notification_outbox set status = 'sent', sent_at = now() where id = $1`, [row.id]);
        summary.sent += 1;
      } else {
        await pool.query(MARK_FAILED_SQL, [row.id, lastError ?? "no transport configured", emailRetryDelayMinutes(row.attempts)]);
        summary.failed += 1;
        if (rateLimited) {
          log("warn", "graph rate-limited (429) — stopping sweep, will resume next cycle", { outboxId: row.id });
          break;
        }
      }
    } catch (err) {
      log("error", "notification dispatch row failed", { outboxId: row.id, error: String(err) });
      await pool
        .query(MARK_FAILED_SQL, [row.id, String((err as Error).message ?? err).slice(0, 500), emailRetryDelayMinutes(row.attempts)])
        .catch(() => {});
      summary.failed += 1;
    }
  }
  return summary;
}
