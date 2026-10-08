// Data layer for the §12.4 channel webhooks (INNOBOX_SPEC.md): platform-admin CRUD, the
// synchronous Send test, and the Administration card's listing.
//
// The URL is a bearer secret. It is stored only as AES-256-GCM ciphertext under WEBHOOK_ENC_KEY,
// next to a plaintext hint (host + last 4 characters); no function here ever returns it, audits
// it, or logs it. Every save re-runs the SSRF guard (form rules + DNS vetting), the send-time
// check in the transport being the authoritative one. At most 5 webhooks per namespace,
// enforced under a per-namespace advisory lock so two concurrent creates cannot both pass.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  APP_VERSION,
  WEBHOOKS_PER_NAMESPACE_MAX,
  buildTestWebhookMessage,
  renderWebhookBody,
  webhookHeaders,
  webhookUrlHint,
  type WebhookCreateInput,
  type WebhookFormat,
  type WebhookPatchInput,
} from "@innobox/shared";
import {
  decryptWebhookUrl,
  encryptWebhookUrl,
  sendWebhook,
  vetWebhookUrl,
  type WebhookResolver,
  type WebhookSendInput,
  type WebhookSendResult,
} from "@innobox/shared/webhook-send";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";

export interface WebhookDeps {
  /** WEBHOOK_ENC_KEY, parsed; null → webhooks are off (create/update/test refused). */
  key: Buffer | null;
  /** PUBLIC_BASE_URL — the test message's item URL. */
  baseUrl: string;
  /** Injectable for tests (never the internet). */
  resolve?: WebhookResolver;
  send?: (input: WebhookSendInput) => Promise<WebhookSendResult>;
}

export interface WebhookLastDelivery {
  outcome: "sent" | "failed";
  at: string;
  httpStatus: number | null;
  reason: string | null;
}

export interface WebhookRecord {
  id: string;
  name: string;
  format: WebhookFormat;
  urlHint: string;
  enabled: boolean;
  lastDelivery: WebhookLastDelivery | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookNamespace {
  id: string;
  slug: string;
  displayName: string;
  archived: boolean;
  webhooks: WebhookRecord[];
}

interface WebhookRow {
  id: string;
  namespace_id: string;
  name: string;
  format: WebhookFormat;
  url_hint: string;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  last_status: "sent" | "failed" | null;
  last_at: Date | null;
  last_http_status: number | null;
  last_reason: string | null;
}

const WEBHOOK_SELECT = `
  select w.id, w.namespace_id, w.name, w.format, w.url_hint, w.enabled, w.created_at, w.updated_at,
         d.status as last_status, d.finished_at as last_at, d.last_http_status, d.last_reason
    from channel_webhooks w
    left join lateral (
      select status, finished_at, last_http_status, last_reason
        from webhook_deliveries
       where webhook_id = w.id and status in ('sent', 'failed')
       order by finished_at desc nulls last
       limit 1
    ) d on true`;

function toRecord(r: WebhookRow): WebhookRecord {
  return {
    id: r.id,
    name: r.name,
    format: r.format,
    urlHint: r.url_hint,
    enabled: r.enabled,
    lastDelivery:
      r.last_status && r.last_at
        ? { outcome: r.last_status, at: r.last_at.toISOString(), httpStatus: r.last_http_status, reason: r.last_status === "failed" ? r.last_reason : null }
        : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Every namespace (`global` first, then alphabetical, archived ones flagged) with its webhooks. */
export async function listWebhooks(pool: Pool): Promise<WebhookNamespace[]> {
  const { rows: namespaces } = await pool.query<{ id: string; slug: string; display_name: string; archived_at: Date | null }>(
    `select id, slug, display_name, archived_at from namespaces
      order by (slug = 'global') desc, lower(display_name), slug`,
  );
  const { rows } = await pool.query<WebhookRow>(`${WEBHOOK_SELECT} order by w.created_at, w.id`);
  return namespaces.map((n) => ({
    id: n.id,
    slug: n.slug,
    displayName: n.display_name,
    archived: n.archived_at !== null,
    webhooks: rows.filter((r) => r.namespace_id === n.id).map(toRecord),
  }));
}

async function getWebhook(pool: Pool, id: string): Promise<WebhookRecord | null> {
  const { rows } = await pool.query<WebhookRow>(`${WEBHOOK_SELECT} where w.id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export type WebhookWriteResult =
  | { status: "ok"; webhook: WebhookRecord }
  | { status: "not_found" }
  | { status: "not_configured" }
  | { status: "limit_reached" }
  | { status: "invalid_url"; message: string };

async function countForNamespace(db: Pick<Pool, "query">, namespaceId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from channel_webhooks where namespace_id = $1`, [namespaceId]);
  return rows[0]!.n;
}

export async function createWebhook(pool: Pool, deps: WebhookDeps, actorUserId: string, input: WebhookCreateInput): Promise<WebhookWriteResult> {
  const { rows: ns } = await pool.query<{ slug: string }>(`select slug from namespaces where id = $1`, [input.namespaceId]);
  if (!ns[0]) return { status: "not_found" };
  if (!deps.key) return { status: "not_configured" };
  if ((await countForNamespace(pool, input.namespaceId)) >= WEBHOOKS_PER_NAMESPACE_MAX) return { status: "limit_reached" };
  const vet = await vetWebhookUrl(input.url, deps.resolve);
  if (!vet.ok) return { status: "invalid_url", message: vet.message };

  const key = deps.key;
  const urlHint = webhookUrlHint(input.url);
  const created = await inTransaction(pool, async (client) => {
    // Serialize creates per namespace so the cap holds under concurrency.
    await client.query(`select pg_advisory_xact_lock(hashtextextended('channel_webhooks:' || $1::text, 0))`, [input.namespaceId]);
    if ((await countForNamespace(client, input.namespaceId)) >= WEBHOOKS_PER_NAMESPACE_MAX) return null;
    const { rows } = await client.query<{ id: string }>(
      `insert into channel_webhooks (namespace_id, name, format, url_enc, url_hint, enabled, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
      [input.namespaceId, input.name, input.format, encryptWebhookUrl(input.url, key), urlHint, input.enabled, actorUserId],
    );
    const id = rows[0]!.id;
    await appendAudit(client, {
      actorUserId,
      action: "webhook.created",
      targetType: "webhook",
      targetId: id,
      after: { namespace: ns[0]!.slug, name: input.name, format: input.format, urlHint, enabled: input.enabled },
    });
    return id;
  });
  if (!created) return { status: "limit_reached" };
  return { status: "ok", webhook: (await getWebhook(pool, created))! };
}

interface StoredWebhook {
  id: string;
  namespace_id: string;
  slug: string;
  name: string;
  format: WebhookFormat;
  url_enc: string;
  url_hint: string;
  enabled: boolean;
}

async function loadStored(pool: Pool, id: string): Promise<StoredWebhook | null> {
  const { rows } = await pool.query<StoredWebhook>(
    `select w.id, w.namespace_id, n.slug, w.name, w.format, w.url_enc, w.url_hint, w.enabled
       from channel_webhooks w join namespaces n on n.id = w.namespace_id
      where w.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Edits name/format/enabled and — only when a non-empty URL is given — replaces the URL (an
 *  edited URL applies to rows not yet sent). Audited with before/after and `urlChanged`. */
export async function updateWebhook(pool: Pool, deps: WebhookDeps, actorUserId: string, id: string, patch: WebhookPatchInput): Promise<WebhookWriteResult> {
  const before = await loadStored(pool, id);
  if (!before) return { status: "not_found" };
  if (!deps.key) return { status: "not_configured" };
  let urlEnc = before.url_enc;
  let urlHint = before.url_hint;
  const urlChanged = patch.url !== undefined;
  if (patch.url !== undefined) {
    const vet = await vetWebhookUrl(patch.url, deps.resolve);
    if (!vet.ok) return { status: "invalid_url", message: vet.message };
    urlEnc = encryptWebhookUrl(patch.url, deps.key);
    urlHint = webhookUrlHint(patch.url);
  }
  const after = {
    name: patch.name ?? before.name,
    format: patch.format ?? before.format,
    enabled: patch.enabled ?? before.enabled,
    urlHint,
  };
  const changed = urlChanged || after.name !== before.name || after.format !== before.format || after.enabled !== before.enabled;
  if (changed) {
    await inTransaction(pool, async (client) => {
      await client.query(
        `update channel_webhooks
            set name = $2, format = $3, enabled = $4, url_enc = $5, url_hint = $6, updated_by = $7, updated_at = now()
          where id = $1`,
        [id, after.name, after.format, after.enabled, urlEnc, urlHint, actorUserId],
      );
      await appendAudit(client, {
        actorUserId,
        action: "webhook.updated",
        targetType: "webhook",
        targetId: id,
        before: { namespace: before.slug, name: before.name, format: before.format, enabled: before.enabled, urlHint: before.url_hint },
        after: { ...after, urlChanged },
      });
    });
  }
  const webhook = await getWebhook(pool, id);
  return webhook ? { status: "ok", webhook } : { status: "not_found" };
}

/** Deletes the webhook; its undelivered rows go with it (FK cascade). Audited with `before`. */
export async function deleteWebhook(pool: Pool, actorUserId: string, id: string): Promise<{ status: "ok" } | { status: "not_found" }> {
  const before = await loadStored(pool, id);
  if (!before) return { status: "not_found" };
  await inTransaction(pool, async (client) => {
    await client.query(`delete from channel_webhooks where id = $1`, [id]);
    await appendAudit(client, {
      actorUserId,
      action: "webhook.deleted",
      targetType: "webhook",
      targetId: id,
      before: { namespace: before.slug, name: before.name, format: before.format, enabled: before.enabled, urlHint: before.url_hint },
    });
  });
  return { status: "ok" };
}

export type WebhookTestResult =
  | { status: "ok"; result: { ok: boolean; httpStatus?: number; reason?: string; durationMs: number } }
  | { status: "not_found" }
  | { status: "not_configured" };

/** The Send test: a fixed synthetic payload, synchronously, through the same guard, timeout and
 *  no-redirect rules — one attempt, no retry. Works on a disabled webhook. Audited
 *  (`webhook.tested`); a failure is shown inline and deliberately NOT system-logged. */
export async function testWebhook(pool: Pool, deps: WebhookDeps, actorUserId: string, id: string, now: Date = new Date()): Promise<WebhookTestResult> {
  const stored = await loadStored(pool, id);
  if (!stored) return { status: "not_found" };
  if (!deps.key) return { status: "not_configured" };

  let result: { ok: boolean; httpStatus?: number; reason?: string; durationMs: number };
  const url = decryptWebhookUrl(stored.url_enc, deps.key);
  if (url === null) {
    result = { ok: false, reason: "undecryptable", durationMs: 0 };
  } else {
    const body = renderWebhookBody(stored.format, buildTestWebhookMessage(deps.baseUrl, stored.slug, now));
    const send = deps.send ?? ((input: WebhookSendInput) => sendWebhook(input, { resolve: deps.resolve }));
    const sent = await send({ url, body, headers: webhookHeaders("test", randomUUID(), APP_VERSION) });
    result =
      sent.outcome === "sent"
        ? { ok: true, httpStatus: sent.httpStatus, durationMs: sent.durationMs }
        : { ok: false, ...(sent.httpStatus !== null ? { httpStatus: sent.httpStatus } : {}), reason: sent.reason, durationMs: sent.durationMs };
  }
  await appendAudit(pool, {
    actorUserId,
    action: "webhook.tested",
    targetType: "webhook",
    targetId: id,
    after: { outcome: result.ok ? "delivered" : "failed", httpStatus: result.httpStatus ?? null, reason: result.reason ?? null },
  });
  return { status: "ok", result };
}
