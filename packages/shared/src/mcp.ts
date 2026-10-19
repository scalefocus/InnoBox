// Agent access through an MCP server (INNOBOX_SPEC.md §25) — the pure, CLIENT-SAFE half (also
// exposed at `@innobox/shared/mcp`): the four platform settings with their defaults and bounds,
// the settings-patch validation, and the fixed vocabulary the web tier, the worker and the admin
// card share. The DB writers live in the server-only `mcp-grants.ts` and in the web tier.

// ── Platform settings (§25.10) ───────────────────────────────────────────────────────────

export const MCP_ENABLED_KEY = "mcp_enabled";
export const MCP_RESTRICTED_CONTENT_KEY = "mcp_restricted_content_enabled";
export const MCP_ACCESS_TTL_KEY = "mcp_access_token_ttl_minutes";
export const MCP_REFRESH_TTL_KEY = "mcp_refresh_token_ttl_days";

export const MCP_ACCESS_TTL_MINUTES = { min: 5, max: 1440, default: 60 } as const;
export const MCP_REFRESH_TTL_DAYS = { min: 1, max: 365, default: 90 } as const;

export interface McpSettings {
  /** Allow AI agents to connect — off by default. Off means dormant, not revoked. */
  enabled: boolean;
  /** Allow namespace-restricted content over MCP — off by default (§25.5). */
  restrictedContentEnabled: boolean;
  accessTokenTtlMinutes: number;
  refreshTokenTtlDays: number;
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  restrictedContentEnabled: false,
  accessTokenTtlMinutes: MCP_ACCESS_TTL_MINUTES.default,
  refreshTokenTtlDays: MCP_REFRESH_TTL_DAYS.default,
};

function inRange(value: unknown, bounds: { min: number; max: number }): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= bounds.min && value <= bounds.max;
}

/** Reads the four settings from their platform_settings values (jsonb, already parsed). A value
 *  that is missing or out of bounds falls back to its default — never to something wider. */
export function mcpSettingsFromValues(values: Partial<Record<string, unknown>>): McpSettings {
  return {
    enabled: values[MCP_ENABLED_KEY] === true,
    restrictedContentEnabled: values[MCP_RESTRICTED_CONTENT_KEY] === true,
    accessTokenTtlMinutes: inRange(values[MCP_ACCESS_TTL_KEY], MCP_ACCESS_TTL_MINUTES) ? (values[MCP_ACCESS_TTL_KEY] as number) : MCP_ACCESS_TTL_MINUTES.default,
    refreshTokenTtlDays: inRange(values[MCP_REFRESH_TTL_KEY], MCP_REFRESH_TTL_DAYS) ? (values[MCP_REFRESH_TTL_KEY] as number) : MCP_REFRESH_TTL_DAYS.default,
  };
}

/** `PATCH admin/mcp`: any subset of the four settings, each validated server-side. Unknown keys
 *  are ignored; an empty patch is refused (nothing to change). */
export function parseMcpSettingsPatch(body: Record<string, unknown>): { ok: true; value: Partial<McpSettings> } | { ok: false; error: string } {
  const value: Partial<McpSettings> = {};
  for (const key of ["enabled", "restrictedContentEnabled"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return { ok: false, error: `${key} must be a boolean` };
    value[key] = body[key] as boolean;
  }
  if (body.accessTokenTtlMinutes !== undefined) {
    if (!inRange(body.accessTokenTtlMinutes, MCP_ACCESS_TTL_MINUTES)) {
      return { ok: false, error: `the access token lifetime must be a whole number of minutes from ${MCP_ACCESS_TTL_MINUTES.min} to ${MCP_ACCESS_TTL_MINUTES.max}` };
    }
    value.accessTokenTtlMinutes = body.accessTokenTtlMinutes;
  }
  if (body.refreshTokenTtlDays !== undefined) {
    if (!inRange(body.refreshTokenTtlDays, MCP_REFRESH_TTL_DAYS)) {
      return { ok: false, error: `the refresh token lifetime must be a whole number of days from ${MCP_REFRESH_TTL_DAYS.min} to ${MCP_REFRESH_TTL_DAYS.max}` };
    }
    value.refreshTokenTtlDays = body.refreshTokenTtlDays;
  }
  if (Object.keys(value).length === 0) return { ok: false, error: "nothing to change" };
  return { ok: true, value };
}

// ── Vocabulary ───────────────────────────────────────────────────────────────────────────

/** The one OAuth scope (§25.3): the boundary is the person's role, re-resolved on every call. */
export const MCP_SCOPE = "mcp";

/** The path of the MCP endpoint under PUBLIC_BASE_URL — also the RFC 8707 resource. */
export const MCP_PATH = "/mcp";

/** Why a grant was revoked — the `reason` of the `mcp.grant_revoked` audit row (§25.13):
 *  `refresh_reuse` and `code_reuse` are the §25.3 replay detections (an already-rotated refresh
 *  token, or an already-exchanged authorization code, presented again). */
export type GrantRevokeReason = "user" | "deactivated" | "erased" | "refresh_reuse" | "code_reuse";

/** The "via agent" attribution a detail payload carries (§25.8): null for browser-created items;
 *  the client name, or null for an anonymous item — a client name could point to one person. */
export type ViaAgent = { client: string | null } | null;

export function viaAgentOf(mcpClientName: string | null | undefined, isAnonymous: boolean): ViaAgent {
  if (!mcpClientName) return null;
  return { client: isAnonymous ? null : mcpClientName };
}
