// §16 contract guard for the §23 gamification routes (INNOBOX_SPEC.md §23.7, §23.12):
// POST /api/me/achievements-seen gates first (401), takes a mutation token, is logged, Origin-checked,
// silent for presence and not audited; the `me` GET carries the ring block and the toast queue; the
// card, profile and leaderboard payloads carry their blocks, and the Points metric is refused while
// the feature is off. Source-level: the handlers depend on the session layer, which the unit runner
// cannot load (the data layer is covered by lib/gamification.dbtest.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiresOriginCheck } from "../../../../lib/csrf";
import { presenceTouchFor } from "../../../../lib/presence";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.join(here, "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(...parts), "utf8").replace(/\r\n/g, "\n");

function handlerBody(source: string, name: string): string {
  const m = new RegExp(`async function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  assert.ok(m, name);
  return m[1]!;
}

test("achievements-seen gates, rate-limits, logs, and is not audited", () => {
  const route = read(here, "route.ts");
  assert.ok(route.includes(`export const POST = withSystemLog("/api/me/achievements-seen", handlePOST);`));
  const body = handlerBody(route, "handlePOST");
  assert.equal(body.trim().split("\n")[0]!.trim(), "const gate = await requireUser();", "401 before anything else");
  assert.match(body, /rateLimit\(gate\.user\.id, "mutation"\)/);
  assert.match(body, /markAchievementsSeen\(pool, gate\.user\.id\)/);
  assert.doesNotMatch(route, /appendAudit/);
  assert.equal(requiresOriginCheck("POST", "/api/me/achievements-seen"), true);
  assert.equal(presenceTouchFor("/api/me/achievements-seen", "POST"), null);
});

test("me carries the gamification block and newAchievements", () => {
  const body = handlerBody(read(api, "me", "route.ts"), "handleGET");
  assert.match(body, /meGamification\(pool, user\.id\)/);
  assert.match(body, /newAchievements: achievements/);
});

test("the card, profiles and leaderboard carry their blocks", () => {
  assert.match(read(api, "users", "[userId]", "card", "route.ts"), /gamification: card\.scrubbed \? null : await cardGamification\(pool, userId\)/);
  assert.match(read(api, "profile", "[userId]", "route.ts"), /publicGamification\(pool, userId\)/);
  assert.match(read(api, "profile", "route.ts"), /ownGamification\(pool, gate\.user\.id\)/);
  const board = handlerBody(read(api, "leaderboards", "route.ts"), "handleGET");
  assert.match(board, /metric === "points" && !gamificationOn/, "Points is refused while the feature is off");
  assert.match(board, /levelChips\(pool/);
});
