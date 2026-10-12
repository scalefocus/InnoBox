// Directory hover card helpers (INNOBOX_SPEC.md §13.8): the self-link decision and the Tab
// routing around the portalled card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { focusNeighbor, profileHref } from "./directory-card";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

test("profileHref: your own bubble links to /profile, decided by id comparison", () => {
  assert.equal(profileHref(ME, ME), "/profile");
});

test("profileHref: anyone else's bubble links to /profile/<id>", () => {
  assert.equal(profileHref(OTHER, ME), `/profile/${OTHER}`);
});

test("profileHref: an unknown signed-in id falls back to the public path", () => {
  assert.equal(profileHref(ME, null), `/profile/${ME}`);
});

// Page order: a link before the bubble, the bubble, a button after it — then the portalled card's
// link at the very end of <body>, which is exactly why the browser's own Tab order is wrong.
const page = ["before", "bubble", "after", "later", "card-link"];
const inCard = (el: string) => el.startsWith("card-");

test("focusNeighbor: Tab out of the card continues to the element after the bubble", () => {
  assert.equal(focusNeighbor(page, "bubble", inCard, "next"), "after");
});

test("focusNeighbor: Shift+Tab out of the card goes to the element before the bubble", () => {
  assert.equal(focusNeighbor(page, "bubble", inCard, "prev"), "before");
});

test("focusNeighbor: never lands back inside the card", () => {
  assert.equal(focusNeighbor(["bubble", "card-link"], "bubble", inCard, "next"), null);
  assert.equal(focusNeighbor(["card-a", "bubble", "card-b", "after"], "bubble", inCard, "next"), "after");
  assert.equal(focusNeighbor(["before", "card-a", "bubble"], "bubble", inCard, "prev"), "before");
});

test("focusNeighbor: null at either end of the page, or for a detached bubble", () => {
  assert.equal(focusNeighbor(["bubble", "after"], "bubble", inCard, "prev"), null);
  assert.equal(focusNeighbor(["before", "bubble"], "bubble", inCard, "next"), null);
  assert.equal(focusNeighbor(["before", "after"], "bubble", inCard, "next"), null);
});
