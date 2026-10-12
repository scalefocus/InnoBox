// §16 contract guard for POST /api/me/whats-new-seen and the Quick start acknowledgement
// (INNOBOX_SPEC.md §13.9): session gate first (401), a mutation rate-limit token, the shared body
// parser, the strict not-in-the-future version check (400), the §14.7 system-log wrapper, the
// Origin check, and silence for presence. Source-level: the handlers depend on the session
// layer, which the unit runner cannot load (the store itself is covered by whats-new.dbtest.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresOriginCheck } from "../../../../lib/csrf";
import { presenceTouchFor } from "../../../../lib/presence";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const stampRoute = read(path.join(here, "route.ts"));
const meRoute = read(path.join(here, "..", "route.ts"));

function handlerBody(source: string, name: string): string {
  const m = new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(m, name);
  return m[1]!;
}

test("the stamp route gates, rate-limits, validates and logs", () => {
  assert.ok(stampRoute.includes(`export const POST = withSystemLog("/api/me/whats-new-seen", handlePOST);`));
  const body = handlerBody(stampRoute, "handlePOST");
  assert.equal(body.trim().split("\n")[0]!.trim(), "const gate = await requireUser();", "401 before anything else");
  assert.match(body, /rateLimit\(gate\.user\.id, "mutation"\)/);
  assert.match(body, /readJsonObject\(req\)/);
  assert.match(body, /validStampVersion\(read\.value\.version, APP_VERSION\)/, "strict and not newer than the server");
  assert.match(body, /status: 400/);
  assert.match(body, /markWhatsNewSeen\(pool, gate\.user\.id, version\)/);
  assert.doesNotMatch(stampRoute, /appendAudit/, "a display marker is not audited");
});

test("the stamp route is Origin-checked and silent for presence", () => {
  assert.equal(requiresOriginCheck("POST", "/api/me/whats-new-seen"), true);
  assert.equal(presenceTouchFor("/api/me/whats-new-seen", "POST"), null);
});

test("Quick start's Continue stamps the marker at the server's APP_VERSION", () => {
  const body = handlerBody(meRoute, "handlePATCH");
  const quickStart = body.indexOf("markQuickStartSeen(pool, gate.user.id)");
  const stamp = body.indexOf("markWhatsNewSeen(pool, gate.user.id, APP_VERSION)");
  assert.ok(quickStart >= 0 && stamp > quickStart, "marks Quick start seen, then acknowledges the release");
});

test("the me resource carries the marker and the rollout date", () => {
  const body = handlerBody(meRoute, "handleGET");
  assert.match(body, /whatsNewSeenVersion: user\.whatsNewSeenVersion/);
  assert.match(body, /whatsNewSinceDate: user\.whatsNewSinceDate/);
});
