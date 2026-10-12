// Unit tests for the e-mail channel's SMTP status (INNOBOX_SPEC.md §2.3): the web tier applies the
// worker's rule — SMTP counts as configured only with SMTP_HOST AND a sender, blanks as unset.
// (The consent redirect's base URL is `publicBaseUrl`, tested in @innobox/shared.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { smtpConfigured } from "./email";

test("smtpConfigured: SMTP_HOST plus SMTP_FROM or SMTP_USER", () => {
  assert.equal(smtpConfigured({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "innobox@example.com" }), true);
  assert.equal(smtpConfigured({ SMTP_HOST: "smtp.example.com", SMTP_USER: "user@example.com" }), true);
});

test("smtpConfigured: SMTP_HOST alone is not configured (no sender)", () => {
  assert.equal(smtpConfigured({ SMTP_HOST: "smtp.example.com" }), false);
  assert.equal(smtpConfigured({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "", SMTP_USER: "  " }), false, "compose's empty defaults count as unset");
});

test("smtpConfigured: no host → not configured", () => {
  assert.equal(smtpConfigured({ SMTP_FROM: "innobox@example.com" }), false);
  assert.equal(smtpConfigured({ SMTP_HOST: "", SMTP_USER: "user@example.com" }), false);
  assert.equal(smtpConfigured({}), false);
});
