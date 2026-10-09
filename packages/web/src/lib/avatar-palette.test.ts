// Avatar fallback palette (INNOBOX_SPEC.md §13.6, §2.2): the initials bubble's background comes
// from a fixed brand-palette set — the §2.2 token table is the sole palette authority — so every
// `.avatar-c<n>` class is built from token variables only, never an off-palette hex, and there is
// exactly one class per AVATAR_COLOR_COUNT bucket. Source-level check over globals.css, like the
// popover and attribution scanners next door.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AVATAR_COLOR_COUNT } from "@innobox/shared/avatars";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GLOBALS_CSS = readFileSync(join(SRC, "app", "globals.css"), "utf8").replace(/\r\n/g, "\n");

/** The §2.2 tokens a bubble color may be drawn from. */
const PALETTE_TOKENS = new Set(["--accent", "--accent-2", "--anchor", "--ok", "--warn", "--danger", "--muted"]);
/** Tokens a bubble may mix against for theme-correct fill/foreground. */
const MIX_TOKENS = new Set(["--surface", "--ink"]);

function avatarColorRules(): Map<number, string> {
  const rules = new Map<number, string>();
  for (const m of GLOBALS_CSS.matchAll(/^\.avatar-c(\d+)\s*\{([^}]*)\}/gm)) rules.set(Number(m[1]), m[2]!);
  return rules;
}

test("there is exactly one .avatar-c<n> class per AVATAR_COLOR_COUNT bucket", () => {
  const rules = avatarColorRules();
  assert.deepEqual([...rules.keys()].sort((a, b) => a - b), Array.from({ length: AVATAR_COLOR_COUNT }, (_, i) => i));
});

test("every bubble color is built from §2.2 brand tokens only — no hex, rgb or named colors", () => {
  const used = new Set<string>();
  for (const [n, body] of avatarColorRules()) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, `.avatar-c${n} uses a raw hex color`);
    assert.doesNotMatch(body, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/i, `.avatar-c${n} uses a raw color function`);
    const vars = [...body.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!);
    assert.ok(vars.length > 0, `.avatar-c${n} references no token`);
    for (const v of vars) {
      assert.ok(PALETTE_TOKENS.has(v) || MIX_TOKENS.has(v), `.avatar-c${n} uses ${v}, which is not a brand palette token`);
      if (PALETTE_TOKENS.has(v)) used.add(v);
    }
  }
  // The set spans the palette rather than eight shades of one hue.
  assert.ok(used.size >= 6, `only ${used.size} distinct palette tokens used`);
});

test("the rating stars use tokens, not the old off-palette hexes", () => {
  for (const hex of ["#e0a01e", "#8a7c5f"]) assert.ok(!GLOBALS_CSS.toLowerCase().includes(hex), `globals.css still uses ${hex}`);
});
