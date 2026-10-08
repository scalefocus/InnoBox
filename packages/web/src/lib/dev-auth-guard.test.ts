// Unit tests for the dev-auth fail-loud startup check (INNOBOX_SPEC.md §2.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { devAuthStartupViolation } from "./dev-auth-guard";

test("devAuthStartupViolation: production build with INNOBOX_DEV_AUTH set → fatal, naming the variable", () => {
  for (const value of ["1", "true", "0", "yes"]) {
    const line = devAuthStartupViolation({ NODE_ENV: "production", INNOBOX_DEV_AUTH: value });
    assert.ok(line, `value ${JSON.stringify(value)} is refused`);
    const parsed = JSON.parse(line) as { level: string; variable: string; msg: string };
    assert.equal(parsed.level, "fatal");
    assert.equal(parsed.variable, "INNOBOX_DEV_AUTH");
    assert.match(parsed.msg, /INNOBOX_DEV_AUTH/);
  }
});

test("devAuthStartupViolation: production build without the flag (unset or empty) starts", () => {
  assert.equal(devAuthStartupViolation({ NODE_ENV: "production" }), null);
  assert.equal(devAuthStartupViolation({ NODE_ENV: "production", INNOBOX_DEV_AUTH: "" }), null);
});

test("devAuthStartupViolation: dev/test with the flag set is the intended local/e2e use", () => {
  assert.equal(devAuthStartupViolation({ NODE_ENV: "development", INNOBOX_DEV_AUTH: "1" }), null);
  assert.equal(devAuthStartupViolation({ NODE_ENV: "test", INNOBOX_DEV_AUTH: "1" }), null);
  assert.equal(devAuthStartupViolation({ INNOBOX_DEV_AUTH: "1" }), null);
});
