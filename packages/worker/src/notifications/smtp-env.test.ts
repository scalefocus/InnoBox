// Unit tests for the SMTP fallback env (§2.3/§12.1): SMTP_FROM falls back to SMTP_USER when unset
// OR empty (compose passes `${SMTP_FROM:-}`, i.e. ""), and with neither the transport is off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSmtpEnv } from "./smtp-env.js";

test("buildSmtpEnv: no SMTP_HOST → not configured", () => {
  assert.equal(buildSmtpEnv({ SMTP_FROM: "a@example.com" }), null);
  assert.equal(buildSmtpEnv({ SMTP_HOST: "" }), null, "compose's empty default counts as unset");
});

test("buildSmtpEnv: SMTP_FROM is used when set", () => {
  const env = buildSmtpEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: "user@example.com", SMTP_FROM: "innobox@example.com" });
  assert.equal(env?.from, "innobox@example.com");
  assert.equal(env?.port, 587);
  assert.equal(env?.secure, false);
});

test("buildSmtpEnv: unset SMTP_FROM falls back to SMTP_USER", () => {
  assert.equal(buildSmtpEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: "user@example.com" })?.from, "user@example.com");
});

test("buildSmtpEnv: EMPTY SMTP_FROM (compose `${SMTP_FROM:-}`) falls back to SMTP_USER", () => {
  assert.equal(buildSmtpEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: "user@example.com", SMTP_FROM: "" })?.from, "user@example.com");
  assert.equal(buildSmtpEnv({ SMTP_HOST: "smtp.example.com", SMTP_USER: "user@example.com", SMTP_FROM: "  " })?.from, "user@example.com");
});

test("buildSmtpEnv: neither SMTP_FROM nor SMTP_USER (unset or empty) → disabled with a warning", () => {
  const warnings: string[] = [];
  assert.equal(buildSmtpEnv({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "", SMTP_USER: "" }, (m) => warnings.push(m)), null);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0]!, /§/);
});

test("buildSmtpEnv: port, implicit TLS and credentials pass through; empty password is dropped", () => {
  const env = buildSmtpEnv({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_SECURE: "1", SMTP_USER: "u@example.com", SMTP_PASSWORD: "" });
  assert.equal(env?.port, 465);
  assert.equal(env?.secure, true);
  assert.equal(env?.user, "u@example.com");
  assert.equal(env?.password, undefined);
});
