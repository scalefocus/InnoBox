// Data layer of the agent-access OAuth server (INNOBOX_SPEC.md §25.3, §25.9, §25.10, §25.13):
// the four settings, registered clients, single-use pending consents, grants, codes, rotating
// refresh tokens with reuse detection, bearer authentication for /mcp, and the person's and the
// platform admin's views. Tokens are stored only as SHA-256 hashes and never logged. Every grant
// creation/revocation, block/unblock and settings change is audited; reads, registrations and
// token issue/rotation are not (they are metrics).
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_MCP_SETTINGS,
  MCP_ACCESS_TTL_KEY,
  MCP_ENABLED_KEY,
  MCP_REFRESH_TTL_KEY,
  MCP_RESTRICTED_CONTENT_KEY,
  MCP_SCOPE,
  mcpSettingsFromValues,
  revokeGrant,
  type McpSettings,
} from "@innobox/shared";
import { appendAudit } from "../audit";
import { inTransaction } from "../db";
import { awardAgentConnected } from "../gamification";
import {
  AUTHORIZATION_CODE_TTL_SECONDS,
  PENDING_AUTHORIZATION_TTL_MINUTES,
  hashToken,
  mintToken,
  verifyPkceS256,
  type ClientRegistration,
  type ValidatedAuthorization,
} from "./oauth";

type Db = Pool | PoolClient;

// ── Settings (§25.10) ────────────────────────────────────────────────────────────────────

const SETTING_KEYS = [MCP_ENABLED_KEY, MCP_RESTRICTED_CONTENT_KEY, MCP_ACCESS_TTL_KEY, MCP_REFRESH_TTL_KEY];

export async function getMcpSettings(db: Db): Promise<McpSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from platform_settings where key = any($1::text[])`, [SETTING_KEYS]);
  return mcpSettingsFromValues(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

/** Writes the changed settings and one `settings.mcp_changed` row whose `after` carries all four. */
export async function setMcpSettings(pool: Pool, patch: Partial<McpSettings>, actorUserId: string): Promise<McpSettings> {
  return inTransaction(pool, async (client) => {
    const next = { ...(await getMcpSettings(client)), ...patch };
    const values: [string, unknown][] = [
      [MCP_ENABLED_KEY, next.enabled],
      [MCP_RESTRICTED_CONTENT_KEY, next.restrictedContentEnabled],
      [MCP_ACCESS_TTL_KEY, next.accessTokenTtlMinutes],
      [MCP_REFRESH_TTL_KEY, next.refreshTokenTtlDays],
    ];
    for (const [key, value] of values) {
      await client.query(
        `insert into platform_settings (key, value, updated_by, updated_at) values ($1, $2::jsonb, $3, now())
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), actorUserId],
      );
    }
    await appendAudit(client, { actorUserId, action: "settings.mcp_changed", targetType: "platform_settings", targetId: MCP_ENABLED_KEY, after: next });
    return next;
  });
}

export { DEFAULT_MCP_SETTINGS };

// ── Clients ──────────────────────────────────────────────────────────────────────────────

export interface OauthClient {
  /** The row id (uuid). */
  id: string;
  /** The opaque public `client_id` the client presents. */
  clientId: string;
  clientName: string;
  redirectUris: string[];
  blocked: boolean;
}

interface ClientRow {
  id: string;
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  blocked_at: Date | null;
}

const toClient = (r: ClientRow): OauthClient => ({ id: r.id, clientId: r.client_id, clientName: r.client_name, redirectUris: r.redirect_uris, blocked: r.blocked_at !== null });

/** RFC 7591: stores a client and returns it. Registration alone grants nothing. Not audited. */
export async function registerClient(pool: Pool, reg: ClientRegistration, ip: string | null): Promise<OauthClient & { createdAt: Date }> {
  const { rows } = await pool.query<ClientRow & { created_at: Date }>(
    `insert into oauth_clients (client_id, client_name, client_uri, logo_uri, redirect_uris, software_id, software_version, registered_ip)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, client_id, client_name, redirect_uris, blocked_at, created_at`,
    [mintToken(), reg.clientName, reg.clientUri, reg.logoUri, reg.redirectUris, reg.softwareId, reg.softwareVersion, ip],
  );
  return { ...toClient(rows[0]!), createdAt: rows[0]!.created_at };
}

export async function findClient(db: Db, clientId: string | null): Promise<OauthClient | null> {
  if (!clientId || clientId.length > 200) return null;
  const { rows } = await db.query<ClientRow>(`select id, client_id, client_name, redirect_uris, blocked_at from oauth_clients where client_id = $1`, [clientId]);
  return rows[0] ? toClient(rows[0]) : null;
}

export async function findClientById(db: Db, id: string): Promise<OauthClient | null> {
  const { rows } = await db.query<ClientRow>(`select id, client_id, client_name, redirect_uris, blocked_at from oauth_clients where id = $1`, [id]);
  return rows[0] ? toClient(rows[0]) : null;
}

// ── Pending authorizations (§25.3: the consent handle) ──────────────────────────────────

/** Stores the validated request for the consent form; the form carries only the returned id. */
export async function createPendingAuthorization(pool: Pool, userId: string, clientRowId: string, request: ValidatedAuthorization): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into oauth_pending_authorizations (user_id, client_id, request) values ($1, $2, $3::jsonb) returning id`,
    [userId, clientRowId, JSON.stringify(request)],
  );
  return rows[0]!.id;
}

/** Consumes the row in the same statement that reads it: single use, 10 minutes, bound to its
 *  person — a double submit cannot mint two codes. Null for anything else (fail closed). */
export async function consumePendingAuthorization(
  db: Db,
  id: string,
  userId: string,
): Promise<{ clientRowId: string; request: ValidatedAuthorization } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query<{ client_id: string; request: ValidatedAuthorization }>(
    `update oauth_pending_authorizations set consumed_at = now()
      where id = $1 and user_id = $2 and consumed_at is null
        and created_at > now() - make_interval(mins => $3)
      returning client_id, request`,
    [id, userId, PENDING_AUTHORIZATION_TTL_MINUTES],
  );
  return rows[0] ? { clientRowId: rows[0].client_id, request: rows[0].request } : null;
}

// ── Consent → grant → code ───────────────────────────────────────────────────────────────

export type ApproveResult = { status: "ok"; code: string; grantCreated: boolean } | { status: "blocked" };

/**
 * Approve: writes or refreshes the person's live grant for the client and mints a single-use,
 * 60-second authorization code bound to the PKCE challenge, redirect URI and resource. A new grant
 * is audited `mcp.grant_created` and earns the person's one `agent_connected` (§25.12).
 */
export async function approveAuthorization(pool: Pool, userId: string, clientRowId: string, request: ValidatedAuthorization): Promise<ApproveResult> {
  return inTransaction(pool, async (client) => {
    const { rows: clients } = await client.query<{ client_name: string; blocked_at: Date | null }>(
      `select client_name, blocked_at from oauth_clients where id = $1 for share`,
      [clientRowId],
    );
    const oauthClient = clients[0];
    if (!oauthClient || oauthClient.blocked_at) return { status: "blocked" };
    const { rows: existing } = await client.query<{ id: string }>(
      `select id from oauth_grants where user_id = $1 and client_id = $2 and revoked_at is null for update`,
      [userId, clientRowId],
    );
    let grantId = existing[0]?.id;
    const grantCreated = !grantId;
    if (!grantId) {
      const { rows } = await client.query<{ id: string }>(
        `insert into oauth_grants (user_id, client_id, scope) values ($1, $2, $3) returning id`,
        [userId, clientRowId, MCP_SCOPE],
      );
      grantId = rows[0]!.id;
    }
    const code = mintToken();
    await client.query(
      `insert into oauth_tokens (grant_id, kind, token_hash, expires_at, code_challenge, redirect_uri, resource)
       values ($1, 'code', $2, now() + make_interval(secs => $3), $4, $5, $6)`,
      [grantId, hashToken(code), AUTHORIZATION_CODE_TTL_SECONDS, request.codeChallenge, request.redirectUri, request.resource],
    );
    if (grantCreated) {
      await appendAudit(client, {
        actorUserId: userId,
        action: "mcp.grant_created",
        targetType: "mcp_grant",
        targetId: grantId,
        after: { userId, client: oauthClient.client_name },
      });
      await awardAgentConnected(client, userId); // §25.12, once per person (award key)
    }
    return { status: "ok", code, grantCreated };
  });
}

// ── Token endpoint ───────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** `invalid_grant` for anything wrong with the code or refresh token; the two carve-outs carry
 *  what the route needs for its system-log row and metric (§25.11). */
export type TokenResult =
  | { status: "ok"; tokens: TokenResponse; rotated: boolean }
  | { status: "invalid_grant" }
  | { status: "invalid_client" }
  | { status: "blocked"; clientName: string; userId: string }
  | { status: "reuse"; clientName: string; userId: string };

async function issueTokens(client: PoolClient, grantId: string, settings: McpSettings, rotatedFromId: string | null): Promise<TokenResponse> {
  const access = mintToken();
  const refresh = mintToken();
  const accessSeconds = settings.accessTokenTtlMinutes * 60;
  await client.query(
    `insert into oauth_tokens (grant_id, kind, token_hash, expires_at) values ($1, 'access', $2, now() + make_interval(secs => $3))`,
    [grantId, hashToken(access), accessSeconds],
  );
  await client.query(
    `insert into oauth_tokens (grant_id, kind, token_hash, expires_at, rotated_from_id) values ($1, 'refresh', $2, now() + make_interval(days => $3), $4)`,
    [grantId, hashToken(refresh), settings.refreshTokenTtlDays, rotatedFromId],
  );
  return { access_token: access, token_type: "Bearer", expires_in: accessSeconds, refresh_token: refresh, scope: MCP_SCOPE };
}

interface TokenLookupRow {
  id: string;
  grant_id: string;
  expires_at: Date;
  used_at: Date | null;
  code_challenge: string | null;
  redirect_uri: string | null;
  resource: string | null;
  revoked_at: Date | null;
  user_id: string;
  user_active: boolean;
  client_public_id: string;
  client_name: string;
  blocked_at: Date | null;
}

const TOKEN_LOOKUP = `
  select t.id, t.grant_id, t.expires_at, t.used_at, t.code_challenge, t.redirect_uri, t.resource,
         g.revoked_at, g.user_id, u.active as user_active,
         c.client_id as client_public_id, c.client_name, c.blocked_at
    from oauth_tokens t
    join oauth_grants g on g.id = t.grant_id
    join oauth_clients c on c.id = g.client_id
    join users u on u.id = g.user_id`;

/** `grant_type=authorization_code`: single use (consumed atomically), unexpired, same client,
 *  same redirect URI, same resource, PKCE verifier matching. */
export async function exchangeCode(
  pool: Pool,
  input: { code: string; codeVerifier: unknown; clientId: string; redirectUri: string | null; resource: string | null },
  settings: McpSettings,
): Promise<TokenResult> {
  return inTransaction(pool, async (client): Promise<TokenResult> => {
    const { rows: consumed } = await client.query<{ id: string }>(
      `update oauth_tokens set used_at = now() where token_hash = $1 and kind = 'code' and used_at is null and expires_at > now() returning id`,
      [hashToken(input.code)],
    );
    if (!consumed[0]) return { status: "invalid_grant" };
    const { rows } = await client.query<TokenLookupRow>(`${TOKEN_LOOKUP} where t.id = $1`, [consumed[0].id]);
    const row = rows[0];
    if (!row || row.revoked_at || !row.user_active) return { status: "invalid_grant" };
    if (row.client_public_id !== input.clientId) return { status: "invalid_grant" };
    if (row.blocked_at) return { status: "blocked", clientName: row.client_name, userId: row.user_id };
    if (input.redirectUri !== row.redirect_uri) return { status: "invalid_grant" };
    if (input.resource !== null && input.resource !== row.resource) return { status: "invalid_grant" };
    if (!row.code_challenge || !verifyPkceS256(input.codeVerifier, row.code_challenge)) return { status: "invalid_grant" };
    await touchGrant(client, row.grant_id);
    return { status: "ok", tokens: await issueTokens(client, row.grant_id, settings, null), rotated: false };
  });
}

/**
 * `grant_type=refresh_token`: rotates on every use. Presenting a refresh token that was already
 * rotated revokes the WHOLE grant (`refresh_reuse`) — whoever holds the newer one loses it too.
 * The idle lifetime slides: the new refresh token lives `refreshTokenTtlDays` from now.
 */
export async function refreshTokens(
  pool: Pool,
  input: { refreshToken: string; clientId: string; resource: string | null },
  settings: McpSettings,
): Promise<TokenResult> {
  const result = await inTransaction(pool, async (client): Promise<TokenResult | { status: "reuse_detected"; grantId: string; clientName: string; userId: string }> => {
    const { rows } = await client.query<TokenLookupRow>(`${TOKEN_LOOKUP} where t.token_hash = $1 and t.kind = 'refresh' for update of t`, [hashToken(input.refreshToken)]);
    const row = rows[0];
    if (!row || row.revoked_at) return { status: "invalid_grant" };
    if (row.client_public_id !== input.clientId) return { status: "invalid_grant" };
    if (row.used_at) return { status: "reuse_detected", grantId: row.grant_id, clientName: row.client_name, userId: row.user_id };
    if (row.expires_at.getTime() <= Date.now() || !row.user_active) return { status: "invalid_grant" };
    if (row.blocked_at) return { status: "blocked", clientName: row.client_name, userId: row.user_id };
    if (input.resource !== null && input.resource !== row.resource && row.resource !== null) return { status: "invalid_grant" };
    await client.query(`update oauth_tokens set used_at = now() where id = $1`, [row.id]);
    await touchGrant(client, row.grant_id);
    return { status: "ok", tokens: await issueTokens(client, row.grant_id, settings, row.id), rotated: true };
  });
  if (result.status !== "reuse_detected") return result;
  // Outside the rotation transaction, which only read: the revocation is its own atomic write.
  await inTransaction(pool, (client) => revokeGrant(client, result.grantId, "refresh_reuse", null));
  return { status: "reuse", clientName: result.clientName, userId: result.userId };
}

/** RFC 7009: an access token ends alone; a refresh token ends its whole grant (the person, through
 *  their client, disconnected it). Unknown tokens are not an error. */
export async function revokeToken(pool: Pool, token: string, clientId: string | null): Promise<"access" | "refresh" | "none"> {
  const { rows } = await pool.query<{ id: string; kind: string; grant_id: string; client_public_id: string; user_id: string }>(
    `select t.id, t.kind, t.grant_id, c.client_id as client_public_id, g.user_id
       from oauth_tokens t join oauth_grants g on g.id = t.grant_id join oauth_clients c on c.id = g.client_id
      where t.token_hash = $1`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || (clientId !== null && row.client_public_id !== clientId)) return "none";
  if (row.kind === "refresh") {
    await inTransaction(pool, (client) => revokeGrant(client, row.grant_id, "user", row.user_id));
    return "refresh";
  }
  await pool.query(`delete from oauth_tokens where id = $1`, [row.id]);
  return row.kind === "access" ? "access" : "none";
}

/** last_used_at on the grant and its client, at most once a minute. */
async function touchGrant(db: Db, grantId: string): Promise<void> {
  await db.query(
    `update oauth_grants set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [grantId],
  );
  await db.query(
    `update oauth_clients set last_used_at = now()
      where id = (select client_id from oauth_grants where id = $1) and (last_used_at is null or last_used_at < now() - interval '1 minute')`,
    [grantId],
  );
}

// ── Bearer authentication for /mcp ───────────────────────────────────────────────────────

export interface McpPrincipal {
  userId: string;
  grantId: string;
  clientRowId: string;
  clientName: string;
}

export type BearerResult = { status: "ok"; principal: McpPrincipal } | { status: "invalid" } | { status: "blocked"; clientName: string; userId: string };

/** An access token for the MCP resource: unexpired, its grant live, its person active, its client
 *  not blocked. A token carries only user, client and grant — the role is resolved per call. */
export async function authenticateBearer(pool: Pool, token: string): Promise<BearerResult> {
  if (token.length < 20 || token.length > 200) return { status: "invalid" };
  const { rows } = await pool.query<TokenLookupRow & { client_row_id: string }>(
    `${TOKEN_LOOKUP.replace("c.client_id as client_public_id,", "c.client_id as client_public_id, c.id as client_row_id,")}
      where t.token_hash = $1 and t.kind = 'access'`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.revoked_at || !row.user_active || row.expires_at.getTime() <= Date.now()) return { status: "invalid" };
  if (row.blocked_at) return { status: "blocked", clientName: row.client_name, userId: row.user_id };
  await touchGrant(pool, row.grant_id).catch(() => {});
  return { status: "ok", principal: { userId: row.user_id, grantId: row.grant_id, clientRowId: row.client_row_id, clientName: row.client_name } };
}

// ── The person's connections (§25.9) ─────────────────────────────────────────────────────

export interface AgentConnection {
  id: string;
  clientName: string;
  authorizedAt: string;
  lastUsedAt: string | null;
}

export async function listConnections(db: Db, userId: string): Promise<AgentConnection[]> {
  const { rows } = await db.query<{ id: string; client_name: string; created_at: Date; last_used_at: Date | null }>(
    `select g.id, c.client_name, g.created_at, g.last_used_at
       from oauth_grants g join oauth_clients c on c.id = g.client_id
      where g.user_id = $1 and g.revoked_at is null
      order by g.created_at desc`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, clientName: r.client_name, authorizedAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null }));
}

export async function hasLiveConnection(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query(`select 1 from oauth_grants where user_id = $1 and revoked_at is null limit 1`, [userId]);
  return rows.length > 0;
}

/** The person's own Revoke: immediate, ends the grant and every token under it. False when the
 *  grant is not theirs or not live (indistinguishable — 404). */
export async function revokeOwnGrant(pool: Pool, userId: string, grantId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(grantId)) return false;
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(`select 1 from oauth_grants where id = $1 and user_id = $2 and revoked_at is null for update`, [grantId, userId]);
    if (rows.length === 0) return false;
    return revokeGrant(client, grantId, "user", userId);
  });
}

// ── Platform admin (§25.10) ──────────────────────────────────────────────────────────────

export interface AdminClientRow {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
  liveConnections: number;
  blocked: boolean;
  blockedAt: string | null;
}

const ADMIN_CLIENT_SELECT = `
  select c.id, c.client_name, c.created_at, c.last_used_at, c.blocked_at,
         (select count(*)::int from oauth_grants g where g.client_id = c.id and g.revoked_at is null) as live
    from oauth_clients c`;

type AdminClientQueryRow = { id: string; client_name: string; created_at: Date; last_used_at: Date | null; blocked_at: Date | null; live: number };

const toAdminClient = (r: AdminClientQueryRow): AdminClientRow => ({
  id: r.id,
  clientName: r.client_name,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  liveConnections: r.live,
  blocked: r.blocked_at !== null,
  blockedAt: r.blocked_at?.toISOString() ?? null,
});

export async function listAdminClients(db: Db): Promise<AdminClientRow[]> {
  const { rows } = await db.query<AdminClientQueryRow>(`${ADMIN_CLIENT_SELECT} order by c.created_at desc`);
  return rows.map(toAdminClient);
}

export async function mcpCounts(db: Db): Promise<{ liveConnections: number; registeredClients: number }> {
  const { rows } = await db.query<{ live: number; clients: number }>(
    `select (select count(*)::int from oauth_grants where revoked_at is null) as live, (select count(*)::int from oauth_clients) as clients`,
  );
  return { liveConnections: rows[0]?.live ?? 0, registeredClients: rows[0]?.clients ?? 0 };
}

/** Block or unblock one client. Its grants stay either way (unblocking restores them). Audited
 *  `mcp.client_blocked` / `mcp.client_unblocked` when the state actually changes. */
export async function setClientBlocked(pool: Pool, id: string, blocked: boolean, actorUserId: string): Promise<AdminClientRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return inTransaction(pool, async (client) => {
    const { rows: changed } = await client.query<{ client_name: string }>(
      blocked
        ? `update oauth_clients set blocked_at = now() where id = $1 and blocked_at is null returning client_name`
        : `update oauth_clients set blocked_at = null where id = $1 and blocked_at is not null returning client_name`,
      [id],
    );
    if (changed[0]) {
      await appendAudit(client, {
        actorUserId,
        action: blocked ? "mcp.client_blocked" : "mcp.client_unblocked",
        targetType: "mcp_client",
        targetId: id,
        after: { client: changed[0].client_name },
      });
    }
    const { rows } = await client.query<AdminClientQueryRow>(`${ADMIN_CLIENT_SELECT} where c.id = $1`, [id]);
    return rows[0] ? toAdminClient(rows[0]) : null;
  });
}
