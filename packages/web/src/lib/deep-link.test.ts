// Unit tests for the §12.1 deep-link convention (INNOBOX_SPEC.md §12.1, §13.1): solution links
// always carry their `#SOL-<m>` anchor, and the topbar autocomplete actually uses the helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { itemHref } from "./deep-link";

const here = path.dirname(fileURLToPath(import.meta.url));

test("itemHref: a challenge links to its page", () => {
  assert.equal(itemHref("CH-42"), "/challenges/42");
  assert.equal(itemHref(42), "/challenges/42");
  assert.equal(itemHref("42", null), "/challenges/42");
});

test("itemHref: a solution links to its parent challenge, anchored to the solution", () => {
  assert.equal(itemHref("CH-42", "SOL-7"), "/challenges/42#SOL-7");
  assert.equal(itemHref("42", 7), "/challenges/42#SOL-7");
});

test("solution rows in the topbar autocomplete and the search page keep the #SOL anchor", () => {
  for (const file of ["../components/TopbarSearch.tsx", "../app/search/page.tsx"]) {
    const source = readFileSync(path.join(here, file), "utf8");
    assert.match(source, /itemHref\(s\.challengeNumber[^)]*, s\.number\)/, `${file} links solutions with their anchor`);
  }
});

test("comment notifications on a solution link with the #SOL anchor", () => {
  const source = readFileSync(path.join(here, "../app/api/comments/route.ts"), "utf8");
  assert.match(source, /link: itemHref\(item\.challengeNumber, item\.solutionNumber\)/);
});
