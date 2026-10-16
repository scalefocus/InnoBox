// §16 contract guard for POST /api/admin/users/:userId/scrub (INNOBOX_SPEC.md §3): the two
// refusals added in v1.16 map to their status codes and plain messages — your own account 400,
// the last active platform admin 409 — alongside the existing 404/409/400 answers, the
// platform-admin gate, the mutation rate limit and the §14.7 wrapper. Source-level: the handler
// depends on the session layer, which the unit runner cannot load (the store's refusals are
// covered by scrub-refusals.dbtest.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresOriginCheck } from "../../../../../../lib/csrf";

const here = path.dirname(fileURLToPath(import.meta.url));
const route = readFileSync(path.join(here, "route.ts"), "utf8").replace(/\r\n/g, "\n");

function handlerBody(source: string, name: string): string {
  const m = new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(m, name);
  return m[1]!;
}

test("the scrub route gates on the platform admin, rate-limits and logs", () => {
  assert.ok(route.includes(`export const POST = withSystemLog("/api/admin/users/[userId]/scrub", handlePOST);`));
  const body = handlerBody(route, "handlePOST");
  assert.equal(body.trim().split("\n")[0]!.trim(), "const gate = await requirePlatformAdmin();", "403/401 before anything else");
  assert.match(body, /rateLimit\(gate\.user\.id, "mutation"\)/);
  assert.match(body, /scrubUser\(\s*pool,\s*gate\.user\.id,\s*userId,/, "the acting admin is the session user — the self check compares the two");
  assert.equal(requiresOriginCheck("POST", "/api/admin/users/x/scrub"), true);
});

test("every store status maps to a status code and a plain message with no spec reference", () => {
  const body = handlerBody(route, "handlePOST");
  const answers: Record<string, { status: number; message: string }> = {
    not_found: { status: 404, message: "user not found" },
    already_scrubbed: { status: 409, message: "this user's info has already been deleted" },
    cannot_erase_self: { status: 400, message: "you cannot erase your own account" },
    last_platform_admin: { status: 409, message: "this is the last active platform admin" },
    invalid_successor: { status: 400, message: "open assignments can only be reassigned to an active user" },
  };
  for (const [status, answer] of Object.entries(answers)) {
    const m = new RegExp(`case "${status}":\\s*\\n\\s*return Response\\.json\\(\\{ error: "([^"]+)" \\}, \\{ status: (\\d+) \\}\\);`).exec(body);
    assert.ok(m, `case "${status}" answers with an { error } JSON body`);
    assert.equal(m[1], answer.message, status);
    assert.equal(Number(m[2]), answer.status, status);
    assert.doesNotMatch(answer.message, /§/, "a user cannot resolve a spec reference");
  }
});
