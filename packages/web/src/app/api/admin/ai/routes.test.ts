// RBAC + §2.4 baseline guard for the §22 AI provider routes (INNOBOX_SPEC.md §22.9): every
// handler's FIRST statement is the platform-admin gate (403 for anyone else — namespace admins
// included), every state-changing handler takes a rate-limit token, every export is wrapped in
// withSystemLog, and no route ever reads or returns the stored key (responses are built from the
// store's view, which carries only the last 4 characters).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = [
  "route.ts",
  path.join("test", "route.ts"),
  path.join("models", "route.ts"),
  path.join("display-name", "route.ts"),
  path.join("timeouts", "route.ts"),
  path.join("switches", "route.ts"),
];

function handlers(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /async function (handle[A-Z]+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push({ name: m[1]!, body: m[2]! });
  return out;
}

test("every AI admin handler gates on platform admin first and is wrapped", () => {
  let seen = 0;
  for (const file of ROUTES) {
    const source = readFileSync(path.join(here, file), "utf8");
    for (const h of handlers(source)) {
      seen++;
      const first = h.body.trim().split("\n")[0]!.trim();
      assert.equal(first, "const gate = await requirePlatformAdmin();", `${file} ${h.name}`);
      assert.match(h.body, /if \(!gate\.ok\) return gate\.response;/, `${file} ${h.name}`);
      if (h.name !== "handleGET") assert.match(h.body, /rateLimit\(gate\.user\.id, "mutation"\)/, `${file} ${h.name} is rate-limited`);
    }
    const exports = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (.*);/g)];
    assert.ok(exports.length > 0, `${file} exports a handler`);
    for (const m of exports) assert.match(m[2]!, /^withSystemLog\("\/api\/admin\/ai/, `${file} ${m[1]} is wrapped`);
  }
  assert.equal(seen, 9, "GET + PUT + PATCH + DELETE, test, models, display-name, timeouts, switches");
});

test("routes never touch the stored key", () => {
  for (const file of [...ROUTES, "responses.ts"]) {
    const source = readFileSync(path.join(here, file), "utf8");
    assert.ok(!source.includes("token_enc"), file);
    assert.ok(!source.includes("tokenEnc"), file);
    assert.ok(!/decryptAiToken/.test(source), file);
  }
});

test("the store never audits the key or its last 4", () => {
  const source = readFileSync(path.join(here, "store.ts"), "utf8");
  const payloads = [...source.matchAll(/appendAudit\(client, \{([\s\S]*?)\}\);/g)].map((m) => m[1]!);
  assert.ok(payloads.length >= 6, "config, enable/disable, clear, display name, timeouts, switches");
  for (const payload of payloads) {
    assert.ok(!/token(Enc|_enc|Last4|_last4)|r\.token\b/.test(payload), `audit payload: ${payload.slice(0, 80)}`);
  }
});
