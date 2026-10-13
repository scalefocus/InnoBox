import { test } from "node:test";
import assert from "node:assert/strict";
import { isUuid, parseCommentCreate, parseParentQuery } from "./validation.js";

const ID = "11111111-1111-1111-1111-111111111111";

test("isUuid: accepts well-formed uuid, rejects garbage", () => {
  assert.equal(isUuid(ID), true);
  assert.equal(isUuid("nope"), false);
});

test("parseParentQuery: accepts challenge/solution with a uuid parentId", () => {
  const result = parseParentQuery(new URLSearchParams({ parentType: "challenge", parentId: ID }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { parentType: "challenge", parentId: ID });
});

test("parseParentQuery: rejects an unknown parentType", () => {
  assert.equal(parseParentQuery(new URLSearchParams({ parentType: "comment", parentId: ID })).ok, false);
});

test("parseParentQuery: rejects a malformed parentId", () => {
  assert.equal(parseParentQuery(new URLSearchParams({ parentType: "solution", parentId: "x" })).ok, false);
});

test("parseCommentCreate: accepts a well-formed body, passes body through unvalidated", () => {
  const result = parseCommentCreate({ parentType: "challenge", parentId: ID, body: "hello" });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { parentType: "challenge", parentId: ID, body: "hello", replyTo: null });
});

test("parseCommentCreate: replyTo is optional, passed through as a string, and refused when not one (§10.2)", () => {
  const reply = parseCommentCreate({ parentType: "solution", parentId: ID, body: "hi", replyTo: ID });
  assert.equal(reply.ok, true);
  if (reply.ok) assert.equal(reply.value.replyTo, ID);
  // Existence and "same item" are the store's 422, not a shape error.
  const unknown = parseCommentCreate({ parentType: "solution", parentId: ID, body: "hi", replyTo: "not-a-uuid" });
  assert.equal(unknown.ok, true);
  const explicitNull = parseCommentCreate({ parentType: "solution", parentId: ID, body: "hi", replyTo: null });
  assert.equal(explicitNull.ok && explicitNull.value.replyTo, null);
  assert.equal(parseCommentCreate({ parentType: "solution", parentId: ID, body: "hi", replyTo: 42 }).ok, false);
  assert.equal(parseCommentCreate({ parentType: "solution", parentId: ID, body: "hi", replyTo: { id: ID } }).ok, false);
});

test("parseCommentCreate: rejects a non-object body", () => {
  assert.equal(parseCommentCreate(null).ok, false);
  assert.equal(parseCommentCreate("x").ok, false);
});

test("parseCommentCreate: rejects missing/malformed parent fields", () => {
  assert.equal(parseCommentCreate({ parentType: "challenge", parentId: "x", body: "hi" }).ok, false);
  assert.equal(parseCommentCreate({ parentType: "bogus", parentId: ID, body: "hi" }).ok, false);
});
