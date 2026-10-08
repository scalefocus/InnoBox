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
  // At-least-once with retry (§12): a 'failed' row is retried on the next sweep up to 5
  // attempts, then left failed (surfaced only via the admin email status pill, no spam).
  // The recipient's email/opt-out flag is joined in here rather than looked up per row —
  // a LEFT JOIN (not INNER) so a row whose user has since vanished still surfaces (and gets
  // skipped below) instead of silently never being processed at all.
  const { rows } = await pool.query<OutboxRow>(
    `select o.id, o.user_id, o.type, o.payload, o.attempts, u.email, u.email_notifications_enabled
       from notification_outbox o
       left join users u on u.id = o.user_id
      where o.status = 'pending' or (o.status = 'failed' and o.attempts < 5)
      order by o.created_at limit $1`,
    [opts.batchSize ?? 50],
  );
  if (rows.length === 0) return summary;

  const wrapper = opts.graphEnv ? await getEmailWrapperHtml(pool) : null;

  for (const row of rows) {
    // Graph rate-limit (429): stop the rest of this batch so we don't keep hammering the API.
    // The current row is recorded failed (it retries next sweep, ~30s later — a coarse but
    // real backoff that respects the Retry-After signal without a per-row sleep). Set below.
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
        await pool.query(
          `update notification_outbox set status = 'failed', attempts = attempts + 1, last_error = $2 where id = $1`,
          [row.id, lastError ?? "no transport configured"],
        );
        summary.failed += 1;
        if (rateLimited) {
          log("warn", "graph rate-limited (429) — stopping sweep, will resume next cycle", { outboxId: row.id });
          break;
        }
      }
    } catch (err) {
      log("error", "notification dispatch row failed", { outboxId: row.id, error: String(err) });
      await pool
        .query(`update notification_outbox set status = 'failed', attempts = attempts + 1, last_error = $2 where id = $1`, [
          row.id,
          String((err as Error).message ?? err).slice(0, 500),
        ])
        .catch(() => {});
      summary.failed += 1;
    }
  }
  return summary;
}
