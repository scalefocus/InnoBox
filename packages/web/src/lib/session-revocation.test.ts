// Pins the "Sign out everywhere" comparison (INNOBOX_SPEC.md §3): a token issued before
// `users.sessions_valid_from` is no session; a never-stamped row accepts every token; a token
// without the issuedAt claim counts as issued at epoch 0 and is refused by any stamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSessionRevoked, nowInSeconds } from "./session-revocation";

const T = Date.UTC(2026, 9, 16, 12, 0, 0); // 2026-10-16T12:00:00Z
const sec = (ms: number) => Math.floor(ms / 1000);

test("a never-stamped row accepts every token, including one with no issuedAt", () => {
  assert.equal(isSessionRevoked({ issuedAt: sec(T), sessionsValidFrom: null }), false);
  assert.equal(isSessionRevoked({ issuedAt: undefined, sessionsValidFrom: null }), false);
  assert.equal(isSessionRevoked({ issuedAt: undefined, sessionsValidFrom: undefined }), false);
});

test("a token issued before the stamp is revoked; one issued after it is not", () => {
  const stamp = new Date(T);
  assert.equal(isSessionRevoked({ issuedAt: sec(T) - 60, sessionsValidFrom: stamp }), true, "a minute before");
  assert.equal(isSessionRevoked({ issuedAt: sec(T) - 7 * 24 * 3600, sessionsValidFrom: stamp }), true, "a week before");
  assert.equal(isSessionRevoked({ issuedAt: sec(T) + 1, sessionsValidFrom: stamp }), false, "a second after");
  assert.equal(isSessionRevoked({ issuedAt: sec(T) + 3600, sessionsValidFrom: stamp }), false, "an hour after");
});

test("the token's whole-second issue time is compared against the stamp's millisecond precision", () => {
  // Minted at 12:00:00.000, stamped at 12:00:00.500: the token (floored to 12:00:00) is older.
  assert.equal(isSessionRevoked({ issuedAt: sec(T), sessionsValidFrom: new Date(T + 500) }), true);
  // Stamped exactly on the second boundary: not strictly before → still valid.
  assert.equal(isSessionRevoked({ issuedAt: sec(T), sessionsValidFrom: new Date(T) }), false);
});

test("a token without the issuedAt claim is refused by any stamp (issued at epoch 0)", () => {
  assert.equal(isSessionRevoked({ issuedAt: undefined, sessionsValidFrom: new Date(T) }), true);
  assert.equal(isSessionRevoked({ issuedAt: null, sessionsValidFrom: new Date(T) }), true);
  assert.equal(isSessionRevoked({ issuedAt: Number.NaN, sessionsValidFrom: new Date(T) }), true);
  assert.equal(isSessionRevoked({ issuedAt: undefined, sessionsValidFrom: new Date(1) }), true, "even a stamp 1ms after the epoch");
});

test("nowInSeconds floors to whole seconds like the JWT iat", () => {
  assert.equal(nowInSeconds(T + 999), sec(T));
  assert.equal(nowInSeconds(T), sec(T));
  assert.equal(Number.isInteger(nowInSeconds()), true);
});
