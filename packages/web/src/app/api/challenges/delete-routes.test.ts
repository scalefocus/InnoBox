// §10.3 / §16 ordering guard for the two permanent-delete endpoints: a caller who is not a
// platform admin is answered 404 BEFORE the request body (and its mandatory reason) is looked at —
// so a non-admin never gets a 422 "reason required" that would confirm the endpoint is live for
// them (invariant 2). Only then is a missing/blank reason a 422. Source-level, like the webhook
// route guard: the handlers depend on the session layer, which the unit runner cannot load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = [path.join(here, "[number]", "route.ts"), path.join(here, "..", "solutions", "[number]", "route.ts")];

function handleDelete(source: string): string {
  const m = /async function handleDELETE\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(m, "handleDELETE exists");
  return m[1]!;
}

test("DELETE answers 404 to a non-platform-admin before reading the body, then 422 for the reason", () => {
  for (const file of ROUTES) {
    const body = handleDelete(readFileSync(file, "utf8"));
    const adminGate = body.search(/if \(!gate\.user\.roles\.isPlatformAdmin\) return Response\.json\(\{ error: "(challenge|solution) not found" \}, \{ status: 404 \}\);/);
    const readBody = body.indexOf("readJsonObject(req)");
    const reason = body.indexOf("validateDeleteReason(");
    const reason422 = body.search(/if \(!reason\.ok\) return Response\.json\(\{ error: reason\.error \}, \{ status: 422 \}\);/);
    assert.ok(adminGate >= 0, `${file}: platform-admin 404 gate present`);
    assert.ok(readBody > adminGate, `${file}: the body is read only after the admin gate`);
    assert.ok(reason > adminGate && reason422 > reason, `${file}: the reason is validated (422) after the admin gate`);
  }
});
