// Data layer for the §22 AI provider card (INNOBOX_SPEC.md §22.3–§22.9): the admin view, the
// test, save, enable/disable and remove of the single ai_integration row, the model list, and
// the independent rows (display name, timeouts, switches) kept in platform_settings.
//
// The API key is a bearer secret. It is stored only as AES-256-GCM ciphertext under
// AI_TOKEN_ENC_KEY next to its last 4 characters; no function here returns it, audits it (nor its
// last 4) or logs it. A blank key means "use the stored one", allowed only against the stored
// provider and normalized base URL — so a hijacked session or a typo can never send the secret
// elsewhere. Save runs a test first and persists nothing on a fail.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool, PoolClient } from "pg";
import { isPublicAddress } from "@innobox/shared";
import {
  AI_FEATURES,
  AI_PROVIDER_LABEL,
  AI_SETTING_KEYS,
  AI_USAGE_WINDOW_DAYS,
  OPENAI_DEFAULT_BASE_URL,
  aiEnableBlocker,
  aiFeatureDefaultTimeoutMs,
  aiFeatureSwitchKey,
  decryptAiToken,
  deriveAiStatus,
  encryptAiToken,
  listAiModels,
  normalizeAiBaseUrl,
  parseAiDisplayName,
  parseAiTimeoutsInput,
  readAiIntegration,
  readAiTimeouts,
  recordAiUsage,
  runAiTest,
  sameAiTimeouts,
  storedTokenApplies,
  tokenLast4,
  type AiFeature,
  type AiIntegrationRow,
  type AiProvider,
  type AiStatus,
  type AiTestResult,
  type AiTimeouts,
  type AiTransportDeps,
} from "@innobox/shared/ai";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";
import type { AiConfigInput, AiConnectionInput, AiSwitchesInput } from "./validation";

export interface AiAdminDeps {
  /** AI_TOKEN_ENC_KEY, parsed; null → every provider write is refused (`ai_key_missing`). */
  key: Buffer | null;
  transport: AiTransportDeps;
  /** Injectable for tests. */
  features?: readonly AiFeature[];
}

// ── The view (GET) ───────────────────────────────────────────────────────────────────────

export interface AiUsageTotals {
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiAdminView {
  keyPresent: boolean;
  config: {
    provider: AiProvider;
    providerLabel: string;
    baseUrl: string;
    model: string;
    tokenLast4: string;
    enabled: boolean;
    tokenDecrypts: boolean;
    updatedAt: string;
    updatedByName: string | null;
  } | null;
  status: AiStatus;
  /** Why the enable switch is unavailable (its tooltip), or null. */
  enableBlocker: string | null;
  lastTest: { at: string; ok: boolean; latencyMs: number | null; model: string | null; error: string | null } | null;
  /** Aggregates only — never per person. */
  usage: { days: number; total: AiUsageTotals; byFeature: (AiUsageTotals & { feature: string; label: string })[] };
  features: { key: string; label: string; egress: string; needsSwitch: boolean; defaultTimeoutMs: number }[];
  /** The stored display name ("" = the default, "AI"). */
  displayName: string;
  timeouts: AiTimeouts;
  switches: { restrictedContent: boolean; features: Record<string, boolean> };
  openaiDefaultBaseUrl: string;
}

async function readSetting(pool: Pool, key: string): Promise<unknown> {
  const { rows } = await pool.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [key]);
  return rows[0]?.value;
}

async function writeSetting(db: Pool | PoolClient, key: string, value: unknown, actorUserId: string): Promise<void> {
  await db.query(
    `insert into platform_settings (key, value, updated_by, updated_at)
     values ($1, $2::jsonb, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), actorUserId],
  );
}

function tokenDecrypts(row: AiIntegrationRow | null, key: Buffer | null): boolean {
  return !!row && !!key && decryptAiToken(row.tokenEnc, key) !== null;
}

export async function getAiAdminView(pool: Pool, deps: AiAdminDeps): Promise<AiAdminView> {
  const features = deps.features ?? AI_FEATURES;
  const row = await readAiIntegration(pool);
  const decrypts = tokenDecrypts(row, deps.key);
  let updatedByName: string | null = null;
  if (row?.updatedBy) {
    const { rows } = await pool.query<{ display_name: string | null }>(`select display_name from users where id = $1`, [row.updatedBy]);
    updatedByName = rows[0]?.display_name ?? null;
  }

  const { rows: usageRows } = await pool.query<{ feature: string; calls: number; failures: number; input_tokens: string; output_tokens: string }>(
    `select feature,
            count(*)::int                           as calls,
            (count(*) filter (where not ok))::int   as failures,
            coalesce(sum(input_tokens), 0)::bigint  as input_tokens,
            coalesce(sum(output_tokens), 0)::bigint as output_tokens
       from ai_usage
      where created_at >= now() - make_interval(days => $1::int)
      group by feature
      order by feature`,
    [AI_USAGE_WINDOW_DAYS],
  );
  const labelOf = (key: string) => (key === "test" ? "Connection tests" : (features.find((f) => f.key === key)?.label ?? key));
  const byFeature = usageRows.map((r) => ({
    feature: r.feature,
    label: labelOf(r.feature),
    calls: r.calls,
    failures: r.failures,
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
  const total = byFeature.reduce<AiUsageTotals>(
    (t, r) => ({ calls: t.calls + r.calls, failures: t.failures + r.failures, inputTokens: t.inputTokens + r.inputTokens, outputTokens: t.outputTokens + r.outputTokens }),
    { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
  );

  const switchFeatures: Record<string, boolean> = {};
  for (const f of features.filter((x) => x.needsSwitch)) switchFeatures[f.key] = (await readSetting(pool, aiFeatureSwitchKey(f.key))) === true;
  const displayName = parseAiDisplayName(await readSetting(pool, AI_SETTING_KEYS.displayName));

  return {
    keyPresent: deps.key !== null,
    config: row
      ? {
          provider: row.provider,
          providerLabel: AI_PROVIDER_LABEL[row.provider],
          baseUrl: row.baseUrl,
          model: row.model,
          tokenLast4: row.tokenLast4,
          enabled: row.enabled,
          tokenDecrypts: decrypts,
          updatedAt: row.updatedAt.toISOString(),
          updatedByName,
        }
      : null,
    status: deriveAiStatus({
      configured: !!row,
      enabled: !!row?.enabled,
      tokenDecrypts: decrypts,
      lastTestAt: row?.lastTestAt ?? null,
      lastTestOk: row?.lastTestOk ?? null,
      lastTestError: row?.lastTestError ?? null,
      lastCallAt: row?.lastCallAt ?? null,
      lastCallOk: row?.lastCallOk ?? null,
      lastCallError: row?.lastCallError ?? null,
    }),
    enableBlocker: aiEnableBlocker({ keyPresent: deps.key !== null, configured: !!row, tokenDecrypts: decrypts, lastTestOk: row?.lastTestOk ?? null }),
    lastTest: row?.lastTestAt
      ? { at: row.lastTestAt.toISOString(), ok: row.lastTestOk === true, latencyMs: row.lastTestLatencyMs, model: row.lastTestModel, error: row.lastTestError }
      : null,
    usage: { days: AI_USAGE_WINDOW_DAYS, total, byFeature },
    features: features.map((f) => ({ key: f.key, label: f.label, egress: f.egress, needsSwitch: !!f.needsSwitch, defaultTimeoutMs: aiFeatureDefaultTimeoutMs(f) })),
    displayName: displayName.ok ? displayName.value : "",
    timeouts: readAiTimeouts(await readSetting(pool, AI_SETTING_KEYS.timeouts), features),
    switches: { restrictedContent: (await readSetting(pool, AI_SETTING_KEYS.restrictedContent)) === true, features: switchFeatures },
    openaiDefaultBaseUrl: OPENAI_DEFAULT_BASE_URL,
  };
}

// ── Resolving the form's connection ──────────────────────────────────────────────────────

type Resolved =
  | { ok: true; provider: AiProvider; baseUrl: string; token: string; usesStoredToken: boolean; row: AiIntegrationRow | null; storedToken: string | null }
  | { ok: false; status: "key_missing" }
  | { ok: false; status: "invalid"; error: string }
  | { ok: false; status: "token_required"; error: string };

export const AI_TOKEN_REQUIRED_MESSAGE = "Enter the API key — the stored key is used only with the saved provider and base URL";
const AI_TOKEN_UNREADABLE_MESSAGE = "The stored API key cannot be decrypted — enter it again";

/** Normalizes the base URL and applies the stored-token rule (§22.1 #6). */
async function resolveConnection(pool: Pool, deps: AiAdminDeps, input: AiConnectionInput): Promise<Resolved> {
  if (!deps.key) return { ok: false, status: "key_missing" };
  const base = normalizeAiBaseUrl(input.provider, input.baseUrl, { allowLocalhost: !!deps.transport.allowLocalhost, isPublicAddress });
  if (!base.ok) return { ok: false, status: "invalid", error: base.message };
  const row = await readAiIntegration(pool);
  const storedToken = row ? decryptAiToken(row.tokenEnc, deps.key) : null;
  if (input.token !== "") {
    return { ok: true, provider: input.provider, baseUrl: base.url, token: input.token, usesStoredToken: false, row, storedToken };
  }
  if (!row || !storedTokenApplies({ provider: row.provider, baseUrl: row.baseUrl }, { provider: input.provider, baseUrl: base.url })) {
    return { ok: false, status: "token_required", error: AI_TOKEN_REQUIRED_MESSAGE };
  }
  if (storedToken === null) return { ok: false, status: "token_required", error: AI_TOKEN_UNREADABLE_MESSAGE };
  return { ok: true, provider: input.provider, baseUrl: base.url, token: storedToken, usesStoredToken: true, row, storedToken };
}

/** The candidate equals the saved configuration exactly — the same provider, base URL, model and
 *  key (blank, or re-typed identical). */
function isSavedConfig(r: Extract<Resolved, { ok: true }>, model: string): boolean {
  return !!r.row && r.row.provider === r.provider && r.row.baseUrl === r.baseUrl && r.row.model === model && (r.usesStoredToken || r.token === r.storedToken);
}

async function runAndRecordTest(pool: Pool, deps: AiAdminDeps, adminUserId: string, r: Extract<Resolved, { ok: true }>, model: string): Promise<AiTestResult> {
  const result = await runAiTest({ provider: r.provider, baseUrl: r.baseUrl, token: r.token, model }, { transport: deps.transport });
  // Every test writes one usage row (feature = 'test'); tests are never audited or system-logged.
  await recordAiUsage(pool, {
    feature: "test",
    userId: adminUserId,
    provider: r.provider,
    model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs: result.latencyMs,
    ok: result.ok,
    errorCode: result.ok ? null : "ai_provider_error",
  });
  return result;
}

// ── Test, model list ─────────────────────────────────────────────────────────────────────

export type AiTestOutcome = Exclude<Resolved, { ok: true }> | { ok: true; result: AiTestResult };

/** POST /api/admin/ai/test — the values currently in the form. Only a test of exactly the saved
 *  configuration updates last_test_*. */
export async function testAiConfig(pool: Pool, deps: AiAdminDeps, adminUserId: string, input: AiConfigInput): Promise<AiTestOutcome> {
  const r = await resolveConnection(pool, deps, input);
  if (!r.ok) return r;
  const result = await runAndRecordTest(pool, deps, adminUserId, r, input.model);
  if (isSavedConfig(r, input.model)) {
    // Guarded on the same configuration, in case a concurrent save replaced it meanwhile.
    await pool.query(
      `update ai_integration
          set last_test_at = now(), last_test_ok = $1, last_test_error = $2, last_test_latency_ms = $3, last_test_model = $4
        where id and provider = $5 and base_url = $6 and model = $7 and token_enc = $8`,
      [result.ok, result.error, result.latencyMs, result.model, r.provider, r.baseUrl, input.model, r.row!.tokenEnc],
    );
  }
  return { ok: true, result };
}

export type AiModelsOutcome = Exclude<Resolved, { ok: true }> | { ok: true; models: string[] } | { ok: false; status: "failed"; error: string };

/** POST /api/admin/ai/models — 20 s, no retry, not recorded. */
export async function loadAiModels(pool: Pool, deps: AiAdminDeps, input: AiConnectionInput): Promise<AiModelsOutcome> {
  const r = await resolveConnection(pool, deps, input);
  if (!r.ok) return r;
  const listed = await listAiModels({ provider: r.provider, baseUrl: r.baseUrl, token: r.token }, { transport: deps.transport });
  return listed.ok ? { ok: true, models: listed.models } : { ok: false, status: "failed", error: listed.error };
}

// ── Save, enable/disable, remove ─────────────────────────────────────────────────────────

export type AiSaveOutcome =
  | Exclude<Resolved, { ok: true }>
  | { ok: true; status: "saved" | "noop" }
  | { ok: false; status: "test_failed"; result: AiTestResult };

/** PUT /api/admin/ai — validate, test, and on a pass upsert (keeping `enabled` as it was). On a
 *  fail nothing is persisted (beyond the test's own usage row). Identical values are a no-op. */
export async function saveAiConfig(pool: Pool, deps: AiAdminDeps, adminUserId: string, input: AiConfigInput): Promise<AiSaveOutcome> {
  const r = await resolveConnection(pool, deps, input);
  if (!r.ok) return r;
  if (isSavedConfig(r, input.model)) return { ok: true, status: "noop" };

  const result = await runAndRecordTest(pool, deps, adminUserId, r, input.model);
  if (!result.ok) return { ok: false, status: "test_failed", result };

  const tokenRotated = !r.usesStoredToken && r.token !== r.storedToken;
  const key = deps.key!;
  await inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ provider: string; base_url: string; model: string; token_enc: string; token_last4: string }>(
      `select provider, base_url, model, token_enc, token_last4 from ai_integration where id for update`,
    );
    const before = rows[0] ?? null;
    // A blank key keeps the stored ciphertext — re-read under the lock, so a concurrent rotation
    // is not overwritten with the older value.
    const tokenEnc = r.usesStoredToken && before ? before.token_enc : encryptAiToken(r.token, key);
    const last4 = r.usesStoredToken && before ? before.token_last4 : tokenLast4(r.token);
    await client.query(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4,
                                   last_test_at, last_test_ok, last_test_error, last_test_latency_ms, last_test_model,
                                   updated_by, updated_at)
       values (true, false, $1, $2, $3, $4, $5, now(), true, null, $6, $7, $8, now())
       on conflict (id) do update
          set provider = excluded.provider, base_url = excluded.base_url, model = excluded.model,
              token_enc = excluded.token_enc, token_last4 = excluded.token_last4,
              last_test_at = excluded.last_test_at, last_test_ok = true, last_test_error = null,
              last_test_latency_ms = excluded.last_test_latency_ms, last_test_model = excluded.last_test_model,
              updated_by = excluded.updated_by, updated_at = now()`,
      [r.provider, r.baseUrl, input.model, tokenEnc, last4, result.latencyMs, result.model, adminUserId],
    );
    await appendAudit(client, {
      actorUserId: adminUserId,
      action: "ai.config_updated",
      targetType: "ai_integration",
      // Never the token or its last 4.
      before: before ? { provider: before.provider, baseUrl: before.base_url, model: before.model } : null,
      after: { provider: r.provider, baseUrl: r.baseUrl, model: input.model, token_rotated: tokenRotated },
    });
  });
  return { ok: true, status: "saved" };
}

export type AiEnableOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; status: "key_missing" | "not_configured" | "test_required" | "token_undecryptable" };

/** PATCH /api/admin/ai `{ enabled }`. Enable needs a saved configuration whose latest test passed
 *  and whose token decrypts; disable keeps the configuration. */
export async function setAiEnabled(pool: Pool, deps: AiAdminDeps, adminUserId: string, enabled: boolean): Promise<AiEnableOutcome> {
  if (!deps.key) return { ok: false, status: "key_missing" };
  const key = deps.key;
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ enabled: boolean; token_enc: string; last_test_ok: boolean | null }>(
      `select enabled, token_enc, last_test_ok from ai_integration where id for update`,
    );
    const row = rows[0];
    if (!row) return { ok: false, status: "not_configured" } as const;
    if (enabled) {
      if (decryptAiToken(row.token_enc, key) === null) return { ok: false, status: "token_undecryptable" } as const;
      if (row.last_test_ok !== true) return { ok: false, status: "test_required" } as const;
    }
    if (row.enabled === enabled) return { ok: true, changed: false } as const;
    await client.query(`update ai_integration set enabled = $1, updated_by = $2, updated_at = now() where id`, [enabled, adminUserId]);
    await appendAudit(client, { actorUserId: adminUserId, action: enabled ? "ai.enabled" : "ai.disabled", targetType: "ai_integration" });
    return { ok: true, changed: true } as const;
  });
}

/** DELETE /api/admin/ai — hard-deletes the row, token included; usage history is kept.
 *  Idempotent: audited only when a row existed. */
export async function removeAiConfig(pool: Pool, deps: AiAdminDeps, adminUserId: string): Promise<{ ok: true; removed: boolean } | { ok: false; status: "key_missing" }> {
  if (!deps.key) return { ok: false, status: "key_missing" };
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ provider: string; base_url: string; model: string; enabled: boolean }>(
      `delete from ai_integration where id returning provider, base_url, model, enabled`,
    );
    const before = rows[0];
    if (!before) return { ok: true, removed: false } as const;
    await appendAudit(client, {
      actorUserId: adminUserId,
      action: "ai.config_cleared",
      targetType: "ai_integration",
      before: { provider: before.provider, baseUrl: before.base_url, model: before.model, enabled: before.enabled },
    });
    return { ok: true, removed: true } as const;
  });
}

// ── Independent rows: display name, timeouts, switches ───────────────────────────────────

/** The end-user display name as stored ("" = the default). */
export async function getAiDisplayNameSetting(pool: Pool): Promise<string> {
  const parsed = parseAiDisplayName(await readSetting(pool, AI_SETTING_KEYS.displayName));
  return parsed.ok ? parsed.value : "";
}

export async function setAiDisplayName(pool: Pool, adminUserId: string, raw: unknown): Promise<{ ok: true; displayName: string; changed: boolean } | { ok: false; error: string }> {
  const parsed = parseAiDisplayName(raw);
  if (!parsed.ok) return parsed;
  const current = await getAiDisplayNameSetting(pool);
  if (current === parsed.value) return { ok: true, displayName: current, changed: false };
  await inTransaction(pool, async (client) => {
    await writeSetting(client, AI_SETTING_KEYS.displayName, parsed.value, adminUserId);
    await appendAudit(client, {
      actorUserId: adminUserId,
      action: "settings.ai_display_name_changed",
      targetType: "platform_settings",
      targetId: AI_SETTING_KEYS.displayName,
      before: { displayName: current },
      after: { displayName: parsed.value },
    });
  });
  return { ok: true, displayName: parsed.value, changed: true };
}

export async function setAiTimeouts(
  pool: Pool,
  adminUserId: string,
  body: unknown,
  features: readonly AiFeature[] = AI_FEATURES,
): Promise<{ ok: true; timeouts: AiTimeouts; changed: boolean } | { ok: false; field: string; error: string }> {
  const parsed = parseAiTimeoutsInput(body, features);
  if (!parsed.ok) return parsed;
  const current = readAiTimeouts(await readSetting(pool, AI_SETTING_KEYS.timeouts), features);
  if (sameAiTimeouts(current, parsed.value)) return { ok: true, timeouts: current, changed: false };
  await inTransaction(pool, async (client) => {
    await writeSetting(client, AI_SETTING_KEYS.timeouts, parsed.value, adminUserId);
    await appendAudit(client, {
      actorUserId: adminUserId,
      action: "settings.ai_timeouts_changed",
      targetType: "platform_settings",
      targetId: AI_SETTING_KEYS.timeouts,
      before: current,
      after: parsed.value,
    });
  });
  return { ok: true, timeouts: parsed.value, changed: true };
}

export async function setAiSwitches(pool: Pool, adminUserId: string, input: AiSwitchesInput): Promise<{ changed: string[] }> {
  const wanted: [string, boolean][] = [];
  if (input.restrictedContent !== undefined) wanted.push([AI_SETTING_KEYS.restrictedContent, input.restrictedContent]);
  for (const [feature, on] of Object.entries(input.features)) wanted.push([aiFeatureSwitchKey(feature), on]);
  const changed: string[] = [];
  await inTransaction(pool, async (client) => {
    for (const [key, on] of wanted) {
      const { rows } = await client.query<{ value: unknown }>(`select value from platform_settings where key = $1 for update`, [key]);
      const before = rows[0]?.value === true;
      if (before === on) continue;
      await writeSetting(client, key, on, adminUserId);
      await appendAudit(client, {
        actorUserId: adminUserId,
        action: `settings.${key}_changed`,
        targetType: "platform_settings",
        targetId: key,
        before: { enabled: before },
        after: { enabled: on },
      });
      changed.push(key);
    }
  });
  return { changed };
}

/** The feature keys that carry their own switch (the PUT /switches allowlist). */
export function switchableAiFeatures(features: readonly AiFeature[] = AI_FEATURES): string[] {
  return features.filter((f) => f.needsSwitch).map((f) => f.key);
}
