// §16 contract guard for the §14.12 monitoring routes (INNOBOX_SPEC.md): the beacon's order of
// checks and its privacy shape (no user id reaches the store, no actor in the system log, no 429
// rows), the admin endpoints' platform-admin gate and absence of audit on reads, the settings
// patch rules, the `me` field and the rate-limit bucket. Source-level for the handlers, which
// depend on the session layer the unit runner cannot load (the stores are covered by
// store.dbtest.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresOriginCheck } from "../../../lib/csrf";
import { presenceTouchFor } from "../../../lib/presence";
import { RATE_LIMITS } from "../../../lib/rate-limit";
import { parseRumSettingsPatch } from "../admin/rum/settings/validation";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(path.join(here, ...parts), "utf8").replace(/\r\n/g, "\n");
const beacon = read("route.ts");
const store = read("store.ts");

function handlerBody(source: string, name: string): string {
  const m = new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(m, name);
  return m[1]!;
}

test("the beacon authenticates, rate-limits, then discards everything while off — before reading the body", () => {
  const body = handlerBody(beacon, "handlePOST");
  const order = [
    "await requireUser()",
    'rateLimit(gate.user.id, "rum", { anonymous: true })',
    "(await getRumSettings(pool)).enabled",
    "readBytesLimited(req, RUM_MAX_BEACON_BYTES)",
    "validateRumBeacon(parsed, today)",
    "insertRumBeacon(pool, beacon.value)",
  ].map((needle) => {
    const at = body.indexOf(needle);
    assert.ok(at >= 0, needle);
    return at;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order, "checks run in this order");
  assert.match(body, /status: 400/);
});

test("no user id ever reaches a monitoring row", () => {
  assert.doesNotMatch(handlerBody(beacon, "handlePOST"), /insertRumBeacon\([^)]*user/);
  assert.doesNotMatch(store, /user_id|userId|actor/i);
  assert.ok(beacon.includes(`withSystemLog("/api/rum", handlePOST, { anonymousActor: true, unrecordedStatuses: [429] })`));
  assert.doesNotMatch(beacon, /appendAudit/);
});

test("the beacon is Origin-checked, silent for presence, and has its own bucket", () => {
  assert.equal(requiresOriginCheck("POST", "/api/rum"), true);
  assert.equal(presenceTouchFor("/api/rum", "POST"), null);
  assert.deepEqual(RATE_LIMITS.rum, { limit: 20, windowMs: 60_000 });
});

test("the admin endpoints are platform-admin only, and only the settings write is audited", () => {
  for (const name of ["summary", "series", "errors", "settings"]) {
    const source = read("..", "admin", "rum", name, "route.ts");
    assert.match(source, /requirePlatformAdmin\(\)/, name);
    assert.ok(source.includes(`withSystemLog("/api/admin/rum/${name}"`), name);
    assert.doesNotMatch(source, /appendAudit/, `${name}: reads are not audited, and the write audits in the settings helper`);
  }
  const helper = readFileSync(path.join(here, "..", "..", "..", "lib", "rum-settings.ts"), "utf8");
  assert.match(helper, /action: "settings\.telemetry_changed"/);
});

test("the settings patch takes the switch and the fixed rates only", () => {
  assert.deepEqual(parseRumSettingsPatch({ enabled: true }), { ok: true, value: { enabled: true } });
  assert.deepEqual(parseRumSettingsPatch({ sampleRate: 25 }), { ok: true, value: { sampleRate: 25 } });
  const off = parseRumSettingsPatch({ sampleRate: 30 });
  assert.equal(off.ok, false);
  assert.equal(!off.ok && off.status, 422);
  assert.equal(!off.ok && /100, 50, 25, 10, 1/.test(off.error), true);
  assert.equal(parseRumSettingsPatch({ enabled: "yes" }).ok, false);
  const nothing = parseRumSettingsPatch({ unrelated: 1 });
  assert.equal(!nothing.ok && nothing.status, 400);
});

test("the me resource carries the collector's start decision", () => {
  const me = read("..", "me", "route.ts");
  assert.match(me, /getRumSettings\(pool\)/);
  assert.match(me, /\n {4}rum,\n/);
});
