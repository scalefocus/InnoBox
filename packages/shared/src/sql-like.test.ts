// Pins the §2.4 literal-substring escape (INNOBOX_SPEC.md): the one helper every LIKE/ILIKE
// "contains" filter runs, so a user's `%`, `_` or `\` matches itself rather than acting as a wildcard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeLike } from "./sql-like.js";

test("escapeLike: the three LIKE metacharacters are backslash-escaped, nothing else changes", () => {
  assert.equal(escapeLike("%"), "\\%");
  assert.equal(escapeLike("_"), "\\_");
  assert.equal(escapeLike("\\"), "\\\\");
  assert.equal(escapeLike("100%_done\\"), "100\\%\\_done\\\\");
  assert.equal(escapeLike("Jane O'Neil"), "Jane O'Neil", "quotes are a bound parameter's business, not LIKE's");
  assert.equal(escapeLike("plain text 42"), "plain text 42");
  assert.equal(escapeLike(""), "");
});

test("escapeLike: wrapped in %…% the outer wildcards stay live and the user's stay literal", () => {
  assert.equal(`%${escapeLike("a%b")}%`, "%a\\%b%");
  assert.equal(`%${escapeLike("%")}%`, "%\\%%");
  // Not idempotent by design (a second pass would hide the user's backslash) — callers apply it
  // exactly once, through the single export.
  assert.equal(escapeLike(escapeLike("\\")), "\\\\\\\\");
});
