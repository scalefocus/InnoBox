// Guard for the §2.4 "search" rate-limit bucket (120 per minute): search, autocomplete — the
// directory pickers included — and the §6.1 similarity check each take a token right after the
// auth gate, before any query runs. A static source check, like the webhook route guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const api = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app", "api");

const SEARCH_ROUTES: { file: string; handler: string }[] = [
  { file: path.join("search", "route.ts"), handler: "handleGET" },
  { file: path.join("challenges", "similar", "route.ts"), handler: "handlePOST" },
  { file: path.join("users", "route.ts"), handler: "handleGET" }, // the assignee picker
  { file: path.join("admin", "users", "route.ts"), handler: "handleGET" }, // the erasure picker
];

function handlerBody(source: string, name: string): string | null {
  const re = new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`);
  return re.exec(source)?.[1] ?? null;
}

test("every search/autocomplete route takes a search-bucket token right after the auth gate", () => {
  for (const { file, handler } of SEARCH_ROUTES) {
    const source = readFileSync(path.join(api, file), "utf8");
    const body = handlerBody(source, handler);
    assert.ok(body, `${file}: ${handler} found`);
    const lines = body!
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//"));
    assert.match(lines[0]!, /^const gate = await require(User|PlatformAdmin)\(\);$/, `${file}: auth gate first`);
    assert.equal(lines[1], "if (!gate.ok) return gate.response;", `${file}: refused before anything else`);
    assert.equal(lines[2], 'const limited = rateLimit(gate.user.id, "search");', `${file}: search bucket next`);
    assert.equal(lines[3], "if (limited) return limited;", `${file}: 429 before the query runs`);
  }
});
