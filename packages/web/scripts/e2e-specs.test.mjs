// The e2e test index + quick-run picker (scripts/e2e-specs.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QUICK_FRACTION, pickQuick, specTests, testsInSource } from "./e2e-specs.mjs";

test("testsInSource reports each test call's own line and its unconditional skip", () => {
  const source = [
    'import { test } from "@playwright/test";',
    "",
    'test("first", async () => {',
    '  test.skip(cond, "inside a body: a runtime skip, not a test");',
    "});",
    "",
    "",
    "test.skip('second', async () => {});",
    "test.fixme(`third`, async () => {});",
    "  test(",
    '    "fourth, title on the next line",',
    "    async () => {},",
    "  );",
  ].join("\n");
  assert.deepEqual(testsInSource(source), [
    { line: 3, skipped: false },
    { line: 8, skipped: true },
    { line: 9, skipped: true },
    { line: 10, skipped: false },
  ]);
});

test("pickQuick takes 10% of the runnable tests, rounded up, in file then line order", () => {
  const tests = Array.from({ length: 23 }, (_, i) => ({ file: `s${i % 3}.spec.ts`, line: i + 1, skipped: i >= 20 }));
  const picked = pickQuick(tests);
  assert.equal(picked.length, 2); // ceil(20 × 0.1): the 3 skipped are not in the pool
  assert.ok(picked.every((t) => !t.skipped));
  assert.equal(new Set(picked).size, picked.length);
  const sorted = [...picked].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  assert.deepEqual(picked, sorted);
});

test("pickQuick never returns nothing from a non-empty suite, and nothing from an empty one", () => {
  assert.equal(pickQuick([{ file: "a.spec.ts", line: 1, skipped: false }]).length, 1);
  assert.deepEqual(pickQuick([]), []);
  assert.deepEqual(pickQuick([{ file: "a.spec.ts", line: 1, skipped: true }]), []);
});

test("pickQuick draws from the whole pool (the random source decides)", () => {
  const tests = Array.from({ length: 10 }, (_, i) => ({ file: "a.spec.ts", line: i + 1, skipped: false }));
  // random() → 0.99 always swaps in the last slot: line 10, then line 1 (swapped there first).
  assert.deepEqual(pickQuick(tests, 0.2, () => 0.99).map((t) => t.line), [1, 10]);
  // random() → 0 never swaps: picks the first two.
  assert.deepEqual(pickQuick(tests, 0.2, () => 0).map((t) => t.line), [1, 2]);
});

test("the real suite indexes every spec file and yields a non-empty quick pick", () => {
  const e2eDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "e2e");
  const all = specTests(e2eDir);
  assert.ok(new Set(all.map((t) => t.file)).size > 0);
  const picked = pickQuick(all);
  assert.equal(picked.length, Math.ceil(all.filter((t) => !t.skipped).length * QUICK_FRACTION));
});
