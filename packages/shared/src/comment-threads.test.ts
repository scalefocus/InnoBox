import { test } from "node:test";
import assert from "node:assert/strict";
import { REPLIES_SHOWN, REPLY_NOT_ON_ITEM, REPLY_TO_REMOVED, groupThreads, resolveReplyTarget, threadOrder } from "./comment-threads.js";

const PARENT = { parentType: "challenge" as const, parentId: "ch-1" };

test("resolveReplyTarget: a reply to a top-level comment files under it", () => {
  const out = resolveReplyTarget({ id: "root", ...PARENT, threadRootId: null, deleted: false }, PARENT);
  assert.deepEqual(out, { ok: true, threadRootId: "root", replyToId: "root" });
});

test("resolveReplyTarget: a reply to a reply files under the SAME root and answers the reply", () => {
  const out = resolveReplyTarget({ id: "r1", ...PARENT, threadRootId: "root", deleted: false }, PARENT);
  assert.deepEqual(out, { ok: true, threadRootId: "root", replyToId: "r1" });
});

test("resolveReplyTarget: missing, other-item and other-type targets share one message", () => {
  assert.deepEqual(resolveReplyTarget(null, PARENT), { ok: false, error: REPLY_NOT_ON_ITEM });
  assert.deepEqual(resolveReplyTarget({ id: "x", parentType: "challenge", parentId: "ch-2", threadRootId: null, deleted: false }, PARENT), {
    ok: false,
    error: REPLY_NOT_ON_ITEM,
  });
  assert.deepEqual(resolveReplyTarget({ id: "x", parentType: "solution", parentId: "ch-1", threadRootId: null, deleted: false }, PARENT), {
    ok: false,
    error: REPLY_NOT_ON_ITEM,
  });
});

test("resolveReplyTarget: a removed comment can't be answered", () => {
  assert.deepEqual(resolveReplyTarget({ id: "root", ...PARENT, threadRootId: null, deleted: true }, PARENT), { ok: false, error: REPLY_TO_REMOVED });
  assert.deepEqual(resolveReplyTarget({ id: "r1", ...PARENT, threadRootId: "root", deleted: true }, PARENT), { ok: false, error: REPLY_TO_REMOVED });
});

const c = (id: string, at: number, threadRootId: string | null = null) => ({ id, threadRootId, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString() });

test("groupThreads: roots oldest first, each followed by its replies oldest first", () => {
  // Input deliberately out of order; a reply posted before a later root still files under its own.
  const comments = [c("b", 3), c("a-r2", 5, "a"), c("a", 1), c("a-r1", 2, "a"), c("b-r1", 4, "b")];
  const groups = groupThreads(comments);
  assert.deepEqual(
    groups.map((g) => [g.root.id, g.replies.map((r) => r.id)]),
    [
      ["a", ["a-r1", "a-r2"]],
      ["b", ["b-r1"]],
    ],
  );
  assert.deepEqual(threadOrder(comments).map((x) => x.id), ["a", "a-r1", "a-r2", "b", "b-r1"]);
});

test("groupThreads: ties on time break by id; a reply whose root is absent stands on its own", () => {
  assert.deepEqual(threadOrder([c("z", 1), c("y", 1)]).map((x) => x.id), ["y", "z"]);
  assert.deepEqual(
    groupThreads([c("orphan", 2, "gone"), c("root", 1)]).map((g) => g.root.id),
    ["root", "orphan"],
  );
});

test("REPLIES_SHOWN is 3", () => {
  assert.equal(REPLIES_SHOWN, 3);
});
