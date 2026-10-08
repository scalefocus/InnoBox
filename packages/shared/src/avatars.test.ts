import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarInitials, avatarColorIndex, avatarVariant, AVATAR_COLOR_COUNT, DELETED_USER_DISPLAY_NAME } from "./avatars.js";

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

test("avatarVariant: anonymous wins over everything (§9 generic bubble)", () => {
  assert.equal(avatarVariant({ userId: null, displayName: "Anonymous" }), "anon");
  assert.equal(avatarVariant({ userId: "u1", displayName: "Jane Doe", anonymous: true, deactivated: true }), "anon");
});

test("avatarVariant: a scrubbed 'Deleted User' renders the neutral bubble, not colored 'DU' (§13.6)", () => {
  assert.equal(avatarVariant({ userId: "u1", displayName: DELETED_USER_DISPLAY_NAME, deactivated: true }), "deleted");
  assert.equal(avatarVariant({ userId: null, displayName: DELETED_USER_DISPLAY_NAME }), "deleted");
});

test("avatarVariant: deactivated users get the greyed initials bubble; active users the colored one", () => {
  assert.equal(avatarVariant({ userId: "u1", displayName: "Jane Doe", deactivated: true }), "off");
  assert.equal(avatarVariant({ userId: null, displayName: "Someone" }), "off");
  assert.equal(avatarVariant({ userId: "u1", displayName: "Jane Doe" }), "color");
  // An ACTIVE user who happens to be named "Deleted User" is not mistaken for a scrubbed row.
  assert.equal(avatarVariant({ userId: "u1", displayName: DELETED_USER_DISPLAY_NAME }), "color");
});
