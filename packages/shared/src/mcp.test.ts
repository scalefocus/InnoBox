// Pins the §25.10 agent-access settings (INNOBOX_SPEC.md): defaults off, the token-lifetime bounds
// (5–1440 minutes, 1–365 days) enforced server-side, out-of-range stored values falling back to the
// defaults, and the §25.8 "via agent" projection masking the client name on an anonymous item.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MCP_SETTINGS, mcpSettingsFromValues, parseMcpSettingsPatch, viaAgentOf } from "./mcp.js";

test("defaults: off, restricted content off, 60 minutes, 90 days", () => {
  assert.deepEqual(DEFAULT_MCP_SETTINGS, { enabled: false, restrictedContentEnabled: false, accessTokenTtlMinutes: 60, refreshTokenTtlDays: 90 });
  assert.deepEqual(mcpSettingsFromValues({}), DEFAULT_MCP_SETTINGS);
  assert.deepEqual(
    mcpSettingsFromValues({ mcp_enabled: true, mcp_restricted_content_enabled: true, mcp_access_token_ttl_minutes: 5, mcp_refresh_token_ttl_days: 365 }),
    { enabled: true, restrictedContentEnabled: true, accessTokenTtlMinutes: 5, refreshTokenTtlDays: 365 },
  );
  // A stored value out of bounds never widens anything — it reads as the default.
  assert.equal(mcpSettingsFromValues({ mcp_access_token_ttl_minutes: 99999 }).accessTokenTtlMinutes, 60);
  assert.equal(mcpSettingsFromValues({ mcp_refresh_token_ttl_days: 0 }).refreshTokenTtlDays, 90);
  assert.equal(mcpSettingsFromValues({ mcp_enabled: "true" }).enabled, false);
});

test("the PATCH: booleans, TTL bounds, nothing to change", () => {
  assert.deepEqual(parseMcpSettingsPatch({ enabled: true }), { ok: true, value: { enabled: true } });
  assert.deepEqual(parseMcpSettingsPatch({ accessTokenTtlMinutes: 5, refreshTokenTtlDays: 365 }), { ok: true, value: { accessTokenTtlMinutes: 5, refreshTokenTtlDays: 365 } });
  for (const bad of [{ accessTokenTtlMinutes: 4 }, { accessTokenTtlMinutes: 1441 }, { accessTokenTtlMinutes: 30.5 }, { refreshTokenTtlDays: 0 }, { refreshTokenTtlDays: 366 }, { enabled: "yes" }, {}]) {
    assert.equal(parseMcpSettingsPatch(bad).ok, false, JSON.stringify(bad));
  }
  const err = parseMcpSettingsPatch({ refreshTokenTtlDays: 400 });
  assert.ok(err.ok === false && !err.error.includes("§"));
});

test("via agent: null for the browser, the client name, or plain on an anonymous item", () => {
  assert.equal(viaAgentOf(null, false), null);
  assert.deepEqual(viaAgentOf("Claude Code", false), { client: "Claude Code" });
  assert.deepEqual(viaAgentOf("Claude Code", true), { client: null });
});
