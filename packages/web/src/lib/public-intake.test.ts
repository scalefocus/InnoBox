// INNOBOX_SPEC.md §24.2, §24.9: the Public submissions card lists every unmet precondition, in the
// fixed key → notice → transport order, each with its hint — one, two, all three, or none — and the
// first-only `missingPrecondition` (kept for compatibility, and the 409 the switch answers) agrees
// with the head of that list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECONDITION_HINT, missingPrecondition, unmetPreconditionList, unmetPreconditions, type PublicIntakePreconditions } from "./public-intake";

const ALL_MET: PublicIntakePreconditions = { keyValid: true, noticeSet: true, transportAvailable: true };

test("none unmet → empty list, no first missing", () => {
  assert.deepEqual(unmetPreconditions(ALL_MET), []);
  assert.deepEqual(unmetPreconditionList(ALL_MET), []);
  assert.equal(missingPrecondition(ALL_MET), null);
});

test("each single precondition on its own", () => {
  assert.deepEqual(unmetPreconditions({ ...ALL_MET, keyValid: false }), ["key"]);
  assert.deepEqual(unmetPreconditions({ ...ALL_MET, noticeSet: false }), ["notice"]);
  assert.deepEqual(unmetPreconditions({ ...ALL_MET, transportAvailable: false }), ["transport"]);
});

test("two unmet → both, in order", () => {
  assert.deepEqual(unmetPreconditions({ keyValid: true, noticeSet: false, transportAvailable: false }), ["notice", "transport"]);
  assert.deepEqual(unmetPreconditions({ keyValid: false, noticeSet: true, transportAvailable: false }), ["key", "transport"]);
});

test("all three unmet → all three in key → notice → transport order, each with its hint", () => {
  const none: PublicIntakePreconditions = { keyValid: false, noticeSet: false, transportAvailable: false };
  assert.deepEqual(unmetPreconditionList(none), [
    { precondition: "key", hint: PRECONDITION_HINT.key },
    { precondition: "notice", hint: PRECONDITION_HINT.notice },
    { precondition: "transport", hint: PRECONDITION_HINT.transport },
  ]);
  assert.equal(missingPrecondition(none), "key", "the first-only answer is the head of the list");
});
