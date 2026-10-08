// §16 contract guard for likes and follows ("create/delete on either parent type"): both routes
// keep the POST toggle the UI uses AND expose DELETE, and every handler has the same baseline —
// session gate first, a mutation rate-limit token, the shared body parser, and the §14.7
// system-log wrapper. (The Origin/CSRF check covers DELETE in the middleware, lib/csrf.ts.)
// Source-level: the handlers depend on the session layer, which the unit runner cannot load.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresOriginCheck } from "../../../lib/csrf";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = [
  { file: path.join(here, "route.ts"), api: "/api/follows", parser: "parseFollowToggle" },
  { file: path.join(here, "..", "likes", "route.ts"), api: "/api/likes", parser: "parseLikeToggle" },
];

test("likes and follows expose POST (toggle) and DELETE (idempotent), with the same baseline", () => {
  for (const { file, api, parser } of ROUTES) {
    const source = readFileSync(file, "utf8");
    for (const method of ["POST", "DELETE"]) {
      assert.match(source, new RegExp(`export const ${method} = withSystemLog\\("${api.replace(/\//g, "\\/")}", handle${method}\\);`), `${api} ${method}`);
      const m = new RegExp(`async function handle${method}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
      assert.ok(m, `${api} handle${method}`);
      const body = m[1]!;
      assert.equal(body.trim().split("\n")[0]!.trim(), "const gate = await requireUser();", `${api} ${method} gates on the session first`);
      assert.match(body, /rateLimit\(gate\.user\.id, "mutation"\)/, `${api} ${method} is rate-limited`);
      assert.ok(body.includes(`${parser}(`), `${api} ${method} parses the same body`);
      assert.match(body, /status: 404/, `${api} ${method} answers 404 for an invisible item`);
    }
    assert.equal(requiresOriginCheck("DELETE", api), true, `${api} DELETE is Origin-checked`);
  }
});
