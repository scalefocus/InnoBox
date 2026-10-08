import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarInitials, avatarColorIndex, AVATAR_COLOR_COUNT } from "./avatars.js";

test("avatarInitials: first + last initial for multi-word names", () => {
  assert.equal(avatarInitials("Ada Lovelace"), "AL");
  assert.equal(avatarInitials("Grace Brewster Hopper"), "GH"); // first + LAST, ignoring middle
  assert.equal(avatarInitials("  mary  jane  "), "MJ"); // trimmed, collapsed whitespace
});

test("avatarInitials: single-word names use first two chars", () => {
  assert.equal(avatarInitials("Cher"), "CH");
  assert.equal(avatarInitials("Bo"), "BO");
  assert.equal(avatarInitials("x"), "X"); // single char stays single
});

test("avatarInitials: empty/whitespace yields '?'", () => {
  assert.equal(avatarInitials(""), "?");
  assert.equal(avatarInitials("   "), "?");
  // @ts-expect-error — guarding the null/undefined runtime path
  assert.equal(avatarInitials(undefined), "?");
});

test("avatarColorIndex: deterministic and within palette bounds", () => {
  const a = avatarColorIndex("user-abc");
  const b = avatarColorIndex("user-abc");
  assert.equal(a, b); // stable for the same key
  for (const key of ["", "a", "user-1", "11111111-2222-3333-4444-555555555555", "Ünïcode ✓"]) {
    const idx = avatarColorIndex(key);
    assert.ok(Number.isInteger(idx));
    assert.ok(idx >= 0 && idx < AVATAR_COLOR_COUNT, `${key} → ${idx} out of range`);
  }
});

test("avatarColorIndex: spreads keys across the palette (not all one bucket)", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) seen.add(avatarColorIndex(`user-${i}`));
  assert.ok(seen.size >= AVATAR_COLOR_COUNT - 1, `only used ${seen.size} of ${AVATAR_COLOR_COUNT} colors`);
});
