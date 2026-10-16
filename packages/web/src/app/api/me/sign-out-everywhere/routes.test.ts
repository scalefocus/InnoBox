// §16 contract guard for POST /api/me/sign-out-everywhere ("Sign out everywhere", INNOBOX_SPEC.md
// §3): session gate first (401), a mutation rate-limit token, the stamp + audit through the store,
// a 204 with no body, the §14.7 system-log wrapper, the Origin check, and silence for presence.
// Source-level: the handler depends on the session layer, which the unit runner cannot load (the
// store itself is covered by sign-out-everywhere.dbtest.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresOriginCheck } from "../../../../lib/csrf";
import { presenceTouchFor } from "../../../../lib/presence";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const route = read(path.join(here, "route.ts"));
const store = read(path.join(here, "store.ts"));

function handlerBody(source: string, name: string): string {
  const m = new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(m, name);
  return m[1]!;
}

test("the route gates, rate-limits, stamps through the store and answers 204", () => {
  assert.ok(route.includes(`export const POST = withSystemLog("/api/me/sign-out-everywhere", handlePOST);`));
  const body = handlerBody(route, "handlePOST");
  assert.equal(body.trim().split("\n")[0]!.trim(), "const gate = await requireUser();", "401 before anything else");
  assert.match(body, /rateLimit\(gate\.user\.id, "mutation"\)/);
  assert.match(body, /signOutEverywhere\(pool, gate\.user\.id\)/, "only ever the signed-in user's own row");
  assert.match(body, /new Response\(null, \{ status: 204 \}\)/);
  assert.doesNotMatch(body, /req\./, "no body is read");
});

test("the store stamps sessions_valid_from = now() and audits actor = target in one transaction", () => {
  assert.match(store, /inTransaction\(pool/);
  assert.match(store, /update users set sessions_valid_from = now\(\)/);
  assert.match(store, /action: "user\.signed_out_everywhere"/);
  assert.match(store, /actorUserId: userId,/);
  assert.match(store, /targetType: "user",\s*targetId: userId,/);
});

test("the route is Origin-checked and silent for presence", () => {
  assert.equal(requiresOriginCheck("POST", "/api/me/sign-out-everywhere"), true);
  assert.equal(presenceTouchFor("/api/me/sign-out-everywhere", "POST"), null);
});
