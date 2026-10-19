// Unit tests for the §2.3 encryption-key validation (INNOBOX_SPEC.md §2.3 "Key validation"):
// strict base64 decoding to exactly 32 bytes, pairwise-distinct keys, and the fail-loud startup
// check — fatal in a production build, warnings elsewhere, never echoing a value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decodeStrictBase64, encryptionKeyProblems, encryptionKeysStartupCheck, parseEncryptionKey } from "./enc-keys.js";
import { parseEmailTokenKey } from "./email-crypto.js";
import { parseWebhookKey } from "./webhook-send.js";
import { parseAiKey } from "./ai.js";
import { parsePublicIntakeKey } from "./public-intake-pow.js";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const k1 = key(1);
const k2 = key(2);
const k3 = key(3);
const k4 = key(4);

test("decodeStrictBase64: the standard alphabet with correct padding, nothing else", () => {
  assert.deepEqual(decodeStrictBase64("AAAA"), Buffer.alloc(3, 0));
  assert.deepEqual(decodeStrictBase64("AA=="), Buffer.alloc(1, 0));
  assert.deepEqual(decodeStrictBase64(k1), Buffer.alloc(32, 1));
  assert.equal(decodeStrictBase64(""), null, "empty");
  assert.equal(decodeStrictBase64("AAA"), null, "length not a multiple of four");
  assert.deepEqual(decodeStrictBase64("AAA="), Buffer.alloc(2, 0), "three chars + one pad: two bytes");
  assert.equal(decodeStrictBase64("AAB="), null, "non-canonical trailing bits are refused (re-encodes to AAA=)");
  assert.equal(decodeStrictBase64("AB=="), null, "non-canonical trailing bits are refused (re-encodes to AA==)");
  assert.equal(decodeStrictBase64("AA==AAAA"), null, "padding in the middle");
  assert.equal(decodeStrictBase64("AAAA\n"), null, "trailing newline");
  assert.equal(decodeStrictBase64(" AAAA"), null, "leading space");
  assert.equal(decodeStrictBase64("AA A"), null, "inner space");
  assert.equal(decodeStrictBase64("AAA-"), null, "URL-safe alphabet");
  assert.equal(decodeStrictBase64("AAA_"), null, "URL-safe alphabet");
  assert.equal(decodeStrictBase64("AAA*"), null, "stray character");
});

test("parseEncryptionKey: exactly 32 strict-base64 bytes, else null — Buffer.from would have been lenient", () => {
  assert.ok(parseEncryptionKey(k1));
  assert.equal(parseEncryptionKey(undefined), null);
  assert.equal(parseEncryptionKey(null), null);
  assert.equal(parseEncryptionKey(""), null);
  assert.equal(parseEncryptionKey(randomBytes(16).toString("base64")), null, "16 bytes");
  assert.equal(parseEncryptionKey(randomBytes(33).toString("base64")), null, "33 bytes");
  // A 44-char value with one stray character: Buffer.from silently drops it and yields fewer
  // bytes (or, with a newline, still 32). Strict parsing refuses both.
  const stray = `${k1.slice(0, 20)}*${k1.slice(21)}`;
  assert.equal(stray.length, 44);
  assert.equal(parseEncryptionKey(stray), null, "stray character inside");
  assert.equal(Buffer.from(`${k1}\n`, "base64").length, 32, "sanity: Buffer.from ignores the newline");
  assert.equal(parseEncryptionKey(`${k1}\n`), null, "trailing newline (a copy-paste artefact) is refused");
  assert.equal(parseEncryptionKey(k1.replace(/\+/g, "-").replace(/\//g, "_") + "x"), null);
});

test("every §2.3 key parser is the strict one", () => {
  for (const parse of [parseEmailTokenKey, parseWebhookKey, parseAiKey, parsePublicIntakeKey]) {
    assert.ok(parse(k1), parse.name);
    assert.equal(parse(`${k1}\n`), null, `${parse.name}: trailing newline`);
    assert.equal(parse(`${k1.slice(0, 20)}*${k1.slice(21)}`), null, `${parse.name}: stray character`);
    assert.equal(parse(randomBytes(16).toString("base64")), null, `${parse.name}: wrong length`);
    assert.equal(parse(undefined), null, `${parse.name}: unset`);
  }
});

test("encryptionKeyProblems: nothing set, or four distinct valid keys, is clean", () => {
  assert.deepEqual(encryptionKeyProblems({}), []);
  assert.deepEqual(encryptionKeyProblems({ EMAIL_TOKEN_ENC_KEY: "", WEBHOOK_ENC_KEY: undefined }), [], "blank counts as unset");
  assert.deepEqual(encryptionKeyProblems({ EMAIL_TOKEN_ENC_KEY: k1, WEBHOOK_ENC_KEY: k2, AI_TOKEN_ENC_KEY: k3, PUBLIC_INTAKE_KEY: k4 }), []);
});

test("encryptionKeyProblems: bad alphabet, wrong length and duplicates are each named by variable", () => {
  const problems = encryptionKeyProblems({
    EMAIL_TOKEN_ENC_KEY: `${k1}\n`,
    WEBHOOK_ENC_KEY: randomBytes(16).toString("base64"),
    AI_TOKEN_ENC_KEY: k3,
    PUBLIC_INTAKE_KEY: k3,
  });
  assert.deepEqual(
    problems.map((p) => [p.reason, p.variables]),
    [
      ["not_base64", ["EMAIL_TOKEN_ENC_KEY"]],
      ["wrong_length", ["WEBHOOK_ENC_KEY"]],
      ["duplicate", ["AI_TOKEN_ENC_KEY", "PUBLIC_INTAKE_KEY"]],
    ],
  );
  for (const p of problems) assert.ok(!p.msg.includes(k3) && !p.msg.includes(k1.slice(0, 10)), "a message never carries a value");
});

test("encryptionKeyProblems: a duplicate is reported for every pair, even when the value is also invalid", () => {
  const short = randomBytes(8).toString("base64");
  const problems = encryptionKeyProblems({ EMAIL_TOKEN_ENC_KEY: short, WEBHOOK_ENC_KEY: short, AI_TOKEN_ENC_KEY: short });
  assert.deepEqual(
    problems.map((p) => [p.reason, p.variables.join("+")]),
    [
      ["wrong_length", "EMAIL_TOKEN_ENC_KEY"],
      ["wrong_length", "WEBHOOK_ENC_KEY"],
      ["wrong_length", "AI_TOKEN_ENC_KEY"],
      ["duplicate", "EMAIL_TOKEN_ENC_KEY+WEBHOOK_ENC_KEY"],
      ["duplicate", "EMAIL_TOKEN_ENC_KEY+AI_TOKEN_ENC_KEY"],
      ["duplicate", "WEBHOOK_ENC_KEY+AI_TOKEN_ENC_KEY"],
    ],
  );
});

test("encryptionKeysStartupCheck: production → one fatal line naming the variables, never a value", () => {
  const r = encryptionKeysStartupCheck({ NODE_ENV: "production", EMAIL_TOKEN_ENC_KEY: `${k1}x`, WEBHOOK_ENC_KEY: k2, AI_TOKEN_ENC_KEY: k2 });
  assert.ok(r.fatal);
  assert.deepEqual(r.warnings, []);
  const line = JSON.parse(r.fatal) as { level: string; msg: string; variables: string[] };
  assert.equal(line.level, "fatal");
  assert.match(line.msg, /refusing to start/);
  assert.match(line.msg, /EMAIL_TOKEN_ENC_KEY is not strict base64/);
  assert.match(line.msg, /WEBHOOK_ENC_KEY and AI_TOKEN_ENC_KEY hold the same key/);
  assert.deepEqual(line.variables, ["EMAIL_TOKEN_ENC_KEY", "WEBHOOK_ENC_KEY", "AI_TOKEN_ENC_KEY"]);
  assert.ok(!r.fatal.includes(k1) && !r.fatal.includes(k2), "the fatal line never carries a value");
});

test("encryptionKeysStartupCheck: production with valid distinct keys (or none) starts", () => {
  assert.deepEqual(encryptionKeysStartupCheck({ NODE_ENV: "production" }), { fatal: null, warnings: [] });
  assert.deepEqual(encryptionKeysStartupCheck({ NODE_ENV: "production", EMAIL_TOKEN_ENC_KEY: k1, WEBHOOK_ENC_KEY: k2, AI_TOKEN_ENC_KEY: k3, PUBLIC_INTAKE_KEY: k4 }), {
    fatal: null,
    warnings: [],
  });
  // The worker passes only what it has: three keys, no PUBLIC_INTAKE_KEY.
  assert.deepEqual(encryptionKeysStartupCheck({ NODE_ENV: "production", EMAIL_TOKEN_ENC_KEY: k1, WEBHOOK_ENC_KEY: k2, AI_TOKEN_ENC_KEY: k3 }), { fatal: null, warnings: [] });
});

test("encryptionKeysStartupCheck: outside production the same problems are warnings, one each", () => {
  for (const NODE_ENV of ["development", "test", undefined]) {
    const r = encryptionKeysStartupCheck({ NODE_ENV, EMAIL_TOKEN_ENC_KEY: `${k1}x`, WEBHOOK_ENC_KEY: k2, PUBLIC_INTAKE_KEY: k2 });
    assert.equal(r.fatal, null, String(NODE_ENV));
    assert.equal(r.warnings.length, 2, String(NODE_ENV));
    const lines = r.warnings.map((w) => JSON.parse(w) as { level: string; msg: string; variables: string[] });
    assert.deepEqual(
      lines.map((l) => [l.level, l.variables]),
      [
        ["warn", ["EMAIL_TOKEN_ENC_KEY"]],
        ["warn", ["WEBHOOK_ENC_KEY", "PUBLIC_INTAKE_KEY"]],
      ],
    );
    assert.match(lines[0]!.msg, /stays off/);
    assert.ok(!r.warnings.join(" ").includes(k2), "a warning never carries a value");
  }
  assert.deepEqual(encryptionKeysStartupCheck({ NODE_ENV: "development", EMAIL_TOKEN_ENC_KEY: k1, WEBHOOK_ENC_KEY: k2 }), { fatal: null, warnings: [] });
});
