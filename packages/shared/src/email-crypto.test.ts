// Unit tests for the §12 at-rest token encryption (AES-256-GCM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptToken, encryptToken, parseEmailTokenKey } from "./email-crypto.js";

const key = randomBytes(32);

test("parseEmailTokenKey: accepts exactly 32 bytes of base64, else null", () => {
  assert.ok(parseEmailTokenKey(key.toString("base64")));
  assert.equal(parseEmailTokenKey(undefined), null);
  assert.equal(parseEmailTokenKey(""), null);
  assert.equal(parseEmailTokenKey(randomBytes(16).toString("base64")), null);
});

test("encryptToken/decryptToken: round-trips, with a fresh IV each time", () => {
  const a = encryptToken("refresh-token-value", key);
  const b = encryptToken("refresh-token-value", key);
  assert.notEqual(a, b);
  assert.match(a, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.equal(decryptToken(a, key), "refresh-token-value");
  assert.equal(decryptToken(b, key), "refresh-token-value");
});

test("decryptToken: wrong key or tampered ciphertext throws", () => {
  const enc = encryptToken("secret", key);
  assert.throws(() => decryptToken(enc, randomBytes(32)));
  const [v, iv, tag, ct] = enc.split(":");
  const flipped = Buffer.from(ct!, "base64");
  flipped[0] = flipped[0]! ^ 0xff;
  assert.throws(() => decryptToken([v, iv, tag, flipped.toString("base64")].join(":"), key));
});

test("decryptToken: a truncated auth tag is rejected (the tag length is pinned to 16 bytes)", () => {
  const enc = encryptToken("secret", key);
  const [v, iv, tag, ct] = enc.split(":");
  const fullTag = Buffer.from(tag!, "base64");
  assert.equal(fullTag.length, 16);
  for (const len of [4, 8, 12, 15]) {
    const short = fullTag.subarray(0, len).toString("base64");
    assert.throws(() => decryptToken([v, iv, short, ct].join(":"), key), /malformed encrypted token/, `tag of ${len} bytes`);
  }
  const long = Buffer.concat([fullTag, Buffer.from([0])]).toString("base64");
  assert.throws(() => decryptToken([v, iv, long, ct].join(":"), key), /malformed encrypted token/);
});

test("decryptToken: malformed envelopes throw", () => {
  assert.throws(() => decryptToken("v2:a:b:c", key), /malformed/);
  assert.throws(() => decryptToken("v1:a:b", key), /malformed/);
});
