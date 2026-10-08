// The §12.4 channel-webhook delivery sweep (INNOBOX_SPEC.md): leader-only, every 30 s, batch 50,
// oldest `next_attempt_at` first. Per row it re-runs the leak guard (the item must STILL pass the
// org-visible test and still live in the webhook's namespace — otherwise the row is skipped,
// which is not a failure and writes no system-log row), skips a disabled webhook, decrypts the
// URL, renders the payload (title read now; status and occurredAt from the enqueue snapshot) and
// sends it through the shared SSRF-guarded transport.
//
// Retryable failures (network, timeout, DNS, 408, 429, 5xx) come back after 1 m, 5 m, 15 m, 1 h,
// 4 h — six attempts in all, a 429's Retry-After honoured when longer (capped at 4 h). Anything
// else fails for good. A final failure is marked `failed` and recorded in the system log
// (source = worker, synthetic 502/504 when no response came back, never the URL), which also
// raises the platform admins' system-log alert. Terminal rows are trimmed 30 days after they
// finish by the hourly housekeeping. Deliveries are operational, not audited.
//
// Never throws mid-batch: one bad row is logged and the sweep continues.
import type { Pool } from "pg";
import { APP_VERSION } from "@innobox/shared/version";
import {
  WEBHOOK_DELIVERY_RETENTION_DAYS,
  WEBHOOK_SWEEP_BATCH,
  isOrgVisibleWebhookItem,
  renderWebhookBody,
  webhookFailureSystemEvent,
  webhookHeaders,
  webhookItemUrl,
  webhookRetryDelayMs,
  type SystemEventInput,
  type WebhookEvent,
  type WebhookFailureReason,
  type WebhookFormat,
  type WebhookSkipReason,
} from "@innobox/shared";
import { decryptWebhookUrl, parseWebhookKey, sendWebhook, type WebhookSendInput, type WebhookSendResult } from "@innobox/shared/webhook-send";
import { recordWorkerEvent } from "../system-log/record.js";

export interface WebhookSweepDeps {
  /** WEBHOOK_ENC_KEY, parsed (null → every due row fails with `key_missing`). */
  key: Buffer | null;
  /** PUBLIC_BASE_URL — item links in the payload. */
  baseUrl: string;
  /** Injectable transport — tests drive a local fake, never the internet. */
  send?: (input: WebhookSendInput) => Promise<WebhookSendResult>;
  /** Injectable system-log writer. */
  record?: (pool: Pool, event: SystemEventInput) => Promise<void>;
  batchSize?: number;
}

export interface WebhookSweepSummary {
  sent: number;
  failed: number;
  skipped: number;
  retried: number;
}

interface DueRow {
  id: string;
  event: WebhookEvent;
  entity_type: "challenge" | "solution";
  entity_id: string;
  event_status: string;
  occurred_at: Date;
  attempts: number;
  name: string;
  format: WebhookFormat;
  url_enc: string;
  enabled: boolean;
  namespace_id: string;
  slug: string;
}

interface ItemRow {
  namespace_id: string;
  visibility: string;
  status: string;
  title: string;
  challenge_number: string;
  solution_number: string | null;
  solution_status: string | null;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

async function loadItem(pool: Pool, row: DueRow): Promise<ItemRow | null> {
  const { rows } =
    row.entity_type === "challenge"
      ? await pool.query<ItemRow>(
          `select namespace_id, visibility, status, title, number::text as challenge_number, null as solution_number, null as solution_status
             from challenges where id = $1`,
          [row.entity_id],
        )
      : await pool.query<ItemRow>(
          `select c.namespace_id, c.visibility, c.status, c.title, c.number::text as challenge_number,
                  s.number::text as solution_number, s.status as solution_status
             from solutions s join challenges c on c.id = s.challenge_id
            where s.id = $1`,
          [row.entity_id],
        );
  return rows[0] ?? null;
}

async function markSkipped(pool: Pool, id: string, reason: WebhookSkipReason): Promise<void> {
  await pool.query(`update webhook_deliveries set status = 'skipped', last_reason = $2, finished_at = now() where id = $1`, [id, reason]);
}

export async function runWebhookDeliverySweep(pool: Pool, deps: WebhookSweepDeps): Promise<WebhookSweepSummary> {
  const summary: WebhookSweepSummary = { sent: 0, failed: 0, skipped: 0, retried: 0 };
  const send = deps.send ?? ((input: WebhookSendInput) => sendWebhook(input));
  const record = deps.record ?? recordWorkerEvent;

  const { rows } = await pool.query<DueRow>(
    `select d.id, d.event, d.entity_type, d.entity_id, d.event_status, d.occurred_at, d.attempts,
            w.name, w.format, w.url_enc, w.enabled, w.namespace_id, n.slug
       from webhook_deliveries d
       join channel_webhooks w on w.id = d.webhook_id
       join namespaces n on n.id = w.namespace_id
      where d.status = 'pending' and d.next_attempt_at <= now()
      order by d.next_attempt_at, d.created_at
      limit $1`,
    [deps.batchSize ?? WEBHOOK_SWEEP_BATCH],
  );

  for (const row of rows) {
    try {
      if (!row.enabled) {
        await markSkipped(pool, row.id, "disabled");
        summary.skipped++;
        continue;
      }
      // Leak guard, second run (invariants 2–3): visibility, status and namespace as of NOW.
      const item = await loadItem(pool, row);
      if (
        !item ||
        item.namespace_id !== row.namespace_id ||
        !isOrgVisibleWebhookItem({ challengeVisibility: item.visibility, challengeStatus: item.status, solutionStatus: item.solution_status })
      ) {
        await markSkipped(pool, row.id, "not_visible");
        summary.skipped++;
        continue;
      }
      const itemNumber = row.entity_type === "solution" ? `SOL-${item.solution_number}` : `CH-${item.challenge_number}`;

      const finalFailure = async (reason: WebhookFailureReason, httpStatus: number | null) => {
        await pool.query(
          `update webhook_deliveries
              set status = 'failed', attempts = attempts + 1, last_http_status = $2, last_reason = $3, finished_at = now()
            where id = $1`,
          [row.id, httpStatus, reason],
        );
        summary.failed++;
        const event = webhookFailureSystemEvent({ webhookName: row.name, namespaceSlug: row.slug, event: row.event, itemNumber, reason, httpStatus });
        await record(pool, { ...event, source: "worker" }).catch((err) => log("error", "webhook system-log record failed", { error: String(err) }));
      };

      if (!deps.key) {
        await finalFailure("key_missing", null);
        continue;
      }
      const url = decryptWebhookUrl(row.url_enc, deps.key);
      if (url === null) {
        await finalFailure("undecryptable", null);
        continue;
      }

      const body = renderWebhookBody(row.format, {
        event: row.event,
        occurredAt: row.occurred_at.toISOString(),
        namespace: row.slug,
        item: {
          type: row.entity_type,
          number: itemNumber,
          title: item.title,
          status: row.event_status,
          url: webhookItemUrl(deps.baseUrl, item.challenge_number, row.entity_type === "solution" ? item.solution_number : null),
        },
      });
      const result = await send({ url, body, headers: webhookHeaders(row.event, row.id, APP_VERSION) });

      if (result.outcome === "sent") {
        await pool.query(
          `update webhook_deliveries
              set status = 'sent', attempts = attempts + 1, last_http_status = $2, last_reason = null, finished_at = now()
            where id = $1`,
          [row.id, result.httpStatus],
        );
        summary.sent++;
        continue;
      }
      const delay = result.outcome === "retryable" ? webhookRetryDelayMs(row.attempts + 1, result.retryAfterMs) : null;
      if (delay === null) {
        await finalFailure(result.reason, result.httpStatus);
        continue;
      }
      await pool.query(
        `update webhook_deliveries
            set attempts = attempts + 1, last_http_status = $2, last_reason = $3,
                next_attempt_at = now() + make_interval(secs => $4::double precision)
          where id = $1`,
        [row.id, result.httpStatus, result.reason, delay / 1000],
      );
      summary.retried++;
    } catch (err) {
      // A DB hiccup on one row: leave it pending (it is retried next sweep) and carry on.
      log("error", "webhook delivery row failed", { deliveryId: row.id, error: String(err) });
    }
  }
  return summary;
}

/** The hourly housekeeping trim: terminal rows 30 days after they finished. */
export async function trimWebhookDeliveries(pool: Pool, retentionDays: number = WEBHOOK_DELIVERY_RETENTION_DAYS): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from webhook_deliveries
      where status in ('sent', 'failed', 'skipped') and finished_at < now() - make_interval(days => $1::int)`,
    [retentionDays],
  );
  return rowCount ?? 0;
}

/**
 * Schedules the delivery sweep (every 30 s) and the trim (hourly) for the leader; returns the
 * stop function for leadership loss / shutdown. Pure DB + outbound HTTPS — independent of the
 * Entra, Graph and object-store configuration. The key and base URL are re-read every sweep.
 */
export function startWebhookSweeps(
  pool: Pool,
  opts: { onSweep?: (summary: WebhookSweepSummary) => void; env?: () => { WEBHOOK_ENC_KEY?: string; PUBLIC_BASE_URL?: string } } = {},
): () => void {
  const env = opts.env ?? (() => process.env);
  let running = false;
  const sweep = async () => {
    if (running) return; // a slow receiver must never stack sweeps
    running = true;
    try {
      const e = env();
      const summary = await runWebhookDeliverySweep(pool, { key: parseWebhookKey(e.WEBHOOK_ENC_KEY), baseUrl: e.PUBLIC_BASE_URL ?? "" });
      opts.onSweep?.(summary);
      if (summary.sent || summary.failed || summary.skipped || summary.retried) log("info", "webhook delivery sweep", { ...summary });
    } catch (err) {
      log("error", "webhook delivery sweep failed", { error: String(err) });
    } finally {
      running = false;
    }
  };
  const trim = async () => {
    try {
      const trimmed = await trimWebhookDeliveries(pool);
      if (trimmed) log("info", "webhook delivery trim", { trimmed });
    } catch (err) {
      log("error", "webhook delivery trim failed", { error: String(err) });
    }
  };
  void sweep();
  void trim();
  const sweepTimer = setInterval(sweep, 30_000);
  const trimTimer = setInterval(trim, 60 * 60 * 1000);
  return () => {
    clearInterval(sweepTimer);
    clearInterval(trimTimer);
  };
}
