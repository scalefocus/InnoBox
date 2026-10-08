// RBAC + §2.4 baseline guard for the §12.4 webhook admin routes: every handler's FIRST statement
// is the platform-admin gate (403 for anyone else — namespace admins included), every state-
// changing handler takes a rate-limit token, every export is wrapped in withSystemLog, and no
// response ever echoes a stored URL (responses are built from the hint-only store records).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = ["route.ts", path.join("[id]", "route.ts"), path.join("[id]", "test", "route.ts")];

function handlers(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /async function (handle[A-Z]+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.push({ name: m[1]!, body: m[2]! });
  return out;
}

test("every webhook admin handler gates on platform admin first", () => {
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
    for (const m of source.matchAll(/export const (GET|POST|PATCH|DELETE) = (.*);/g)) {
      assert.match(m[2]!, /^withSystemLog\("\/api\/admin\/webhooks/, `${file} ${m[1]} is wrapped`);
    }
  }
  assert.equal(seen, 5, "GET + POST, PATCH + DELETE, POST test");
});

test("routes never read or return the stored URL", () => {
  for (const file of [...ROUTES, "responses.ts"]) {
    const source = readFileSync(path.join(here, file), "utf8");
    assert.ok(!source.includes("url_enc"), file);
    assert.ok(!source.includes("decryptWebhookUrl"), file);
  }
});
