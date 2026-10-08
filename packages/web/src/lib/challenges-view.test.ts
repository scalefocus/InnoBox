// Unit tests for the §13.1 Cards / List view preference and the list-row helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGES_VIEW_KEY,
  challengeHref,
  parseChallengesView,
  readChallengesView,
  shouldRowNavigate,
  solutionCountLabel,
  writeChallengesView,
  type ViewStorage,
} from "./challenges-view";

function memoryStorage(initial: Record<string, string> = {}): ViewStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

test("the storage key is the documented one", () => {
  assert.equal(CHALLENGES_VIEW_KEY, "innobox:challenges-view");
});

test("parse accepts exactly cards/list and falls back to cards", () => {
  assert.equal(parseChallengesView("list"), "list");
  assert.equal(parseChallengesView("cards"), "cards");
  for (const bad of [null, undefined, "", "LIST", "table", " list", 1, {}]) {
    assert.equal(parseChallengesView(bad), "cards", `value ${JSON.stringify(bad)}`);
  }
});

test("read returns the stored view, defaulting to cards when missing or invalid", () => {
  assert.equal(readChallengesView(() => memoryStorage()), "cards");
  assert.equal(readChallengesView(() => memoryStorage({ [CHALLENGES_VIEW_KEY]: "list" })), "list");
  assert.equal(readChallengesView(() => memoryStorage({ [CHALLENGES_VIEW_KEY]: "cards" })), "cards");
  assert.equal(readChallengesView(() => memoryStorage({ [CHALLENGES_VIEW_KEY]: "grid" })), "cards");
  assert.equal(readChallengesView(() => null), "cards", "no storage at all (SSR)");
  assert.equal(readChallengesView(() => undefined), "cards");
});

test("read never throws — a throwing accessor or getItem falls back to cards", () => {
  assert.equal(
    readChallengesView(() => {
      throw new Error("SecurityError: access denied");
    }),
    "cards",
  );
  const throwingGet: ViewStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
  };
  assert.equal(readChallengesView(() => throwingGet), "cards");
});

test("write stores the view and round-trips through read", () => {
  const s = memoryStorage();
  assert.equal(writeChallengesView("list", () => s), true);
  assert.equal(s.data[CHALLENGES_VIEW_KEY], "list");
  assert.equal(readChallengesView(() => s), "list");
  assert.equal(writeChallengesView("cards", () => s), true);
  assert.equal(readChallengesView(() => s), "cards");
});

test("a failed write is silently ignored", () => {
  const quotaFull: ViewStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(writeChallengesView("list", () => quotaFull), false);
  assert.equal(
    writeChallengesView("list", () => {
      throw new Error("SecurityError");
    }),
    false,
  );
  assert.equal(writeChallengesView("list", () => null), false);
});

test("challengeHref maps the display number to the detail route", () => {
  assert.equal(challengeHref("CH-412"), "/challenges/412");
  assert.equal(challengeHref("CH-7"), "/challenges/7");
});

test("row clicks navigate only on a plain primary click outside interactive elements with no selection", () => {
  const plain = { onInteractive: false, selectionText: "", button: 0, modifier: false };
  assert.equal(shouldRowNavigate(plain), true);
  assert.equal(shouldRowNavigate({ ...plain, selectionText: "   " }), true, "whitespace-only selection is a click");
  assert.equal(shouldRowNavigate({ ...plain, onInteractive: true }), false, "the title link / a card link navigates itself");
  assert.equal(shouldRowNavigate({ ...plain, selectionText: "Reduce onboarding" }), false, "selecting text never navigates");
  assert.equal(shouldRowNavigate({ ...plain, button: 1 }), false);
  assert.equal(shouldRowNavigate({ ...plain, modifier: true }), false);
});

test("solution count label pluralizes like the card", () => {
  assert.equal(solutionCountLabel(0), "0 solutions");
  assert.equal(solutionCountLabel(1), "1 solution");
  assert.equal(solutionCountLabel(2), "2 solutions");
});
