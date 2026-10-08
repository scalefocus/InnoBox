// Hermetic unit tests for the SCIM filter parser — no DB, no express.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidFilterError, parseFilter, requireAttr } from "./filter.js";

test("no filter -> null (list-all semantics)", () => {
  assert.equal(parseFilter(undefined), null);
  assert.equal(parseFilter(null), null);
  assert.equal(parseFilter(""), null);
  assert.equal(parseFilter("   "), null);
});

test("userName eq \"value\" parses, attribute name case-insensitive", () => {
  assert.deepEqual(parseFilter('userName eq "ada@contoso.com"'), { attr: "username", value: "ada@contoso.com" });
  assert.deepEqual(parseFilter('USERNAME eq "ada@contoso.com"'), { attr: "username", value: "ada@contoso.com" });
  assert.deepEqual(parseFilter('UserName EQ "ada@contoso.com"'), { attr: "username", value: "ada@contoso.com" });
});

test("externalId eq \"value\" parses", () => {
  assert.deepEqual(parseFilter('externalId eq "9f4a-objectid"'), { attr: "externalid", value: "9f4a-objectid" });
});

test("displayName eq \"value\" parses (groups)", () => {
  assert.deepEqual(parseFilter('displayName eq "Engineering"'), { attr: "displayname", value: "Engineering" });
});

test("value is compared exactly by the caller; empty-quoted value is allowed", () => {
  assert.deepEqual(parseFilter('userName eq ""'), { attr: "username", value: "" });
});

test("unsupported attribute -> InvalidFilterError", () => {
  assert.throws(() => parseFilter('title eq "Engineer"'), InvalidFilterError);
});

test("unsupported operator -> InvalidFilterError", () => {
  assert.throws(() => parseFilter('userName co "ada"'), InvalidFilterError);
  assert.throws(() => parseFilter('userName ne "ada"'), InvalidFilterError);
});

test("malformed syntax -> InvalidFilterError", () => {
  assert.throws(() => parseFilter("not a filter"), InvalidFilterError);
  assert.throws(() => parseFilter('userName eq ada'), InvalidFilterError); // unquoted value
  assert.throws(() => parseFilter('userName eq "ada'), InvalidFilterError); // unterminated quote
});

test("requireAttr narrows to the resource's supported attributes", () => {
  const parsed = parseFilter('displayName eq "Engineering"')!;
  assert.throws(() => requireAttr(parsed, ["username", "externalid"]), InvalidFilterError);
  assert.doesNotThrow(() => requireAttr(parsed, ["displayname", "externalid"]));
});
