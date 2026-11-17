// §43 mentions — the pure rules: the token, binding with its boundary rule, the serializer and its
// ranges, the audit and AI forms, the drafting aid's placeholders, the request parser, the caps, the
// settling check's status table, the composer's query rule, and event 26's copy and class.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_STORED_MENTION,
  MENTIONS_PER_DAY,
  MENTIONS_PER_SOLUTION,
  MENTION_CLOSE,
  MENTION_HINT_LATER,
  MENTION_HINT_ON_SAVE,
  MENTION_MESSAGES,
  MENTION_OPEN,
  activeMentionQuery,
  aiSafeMentions,
  auditMentions,
  bindMentions,
  boundUserIds,
  displayMentions,
  hasMentions,
  insertMention,
  maskMentionsForAi,
  mentionCapRefusal,
  mentionHint,
  mentionRoom,
  mentionSettleScope,
  mentionToken,
  mentionedMessage,
  mentionedSubject,
  mentionedUserIds,
  parseMentionsInput,
  renderMentions,
  stripMentionMarks,
  unmaskMentionsFromAi,
} from "./mentions.js";
import { SOLUTION_STATUSES } from "./challenges.js";
import { isDigestableEvent } from "./email-digest.js";

const ANA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CY = "33333333-3333-4333-8333-333333333333";
const ana = { userId: ANA, name: "Ana Petrova" };
const bob = { userId: BOB, name: "Bob Ivanov" };
const T = mentionToken;

test("binding replaces a listed person's @name with their token", () => {
  const bound = bindMentions("Ask @Ana Petrova and @Bob Ivanov.", [ana, bob]);
  assert.equal(bound.text, `Ask ${T(ANA)} and ${T(BOB)}.`);
  assert.deepEqual(bound.userIds, [ANA, BOB]);
  assert.equal(hasMentions(bound.text), true);
});

test("an @ binds only at the start of the text or after a non-letter, non-digit", () => {
  assert.equal(bindMentions("@Ana Petrova knows", [ana]).text, `${T(ANA)} knows`, "start of the text");
  assert.equal(bindMentions("(@Ana Petrova)", [ana]).text, `(${T(ANA)})`, "after a bracket");
  assert.equal(bindMentions("line\n@Ana Petrova", [ana]).text, `line\n${T(ANA)}`, "after a line break");
  assert.equal(bindMentions("me@Ana Petrova", [ana]).text, "me@Ana Petrova", "after a letter — an e-mail-like run");
  assert.equal(bindMentions("7@Ana Petrova", [ana]).text, "7@Ana Petrova", "after a digit");
  assert.equal(bindMentions("ж@Ana Petrova", [ana]).text, "ж@Ana Petrova", "after a non-Latin letter");
  assert.equal(bindMentions("𝒜@Ana Petrova", [ana]).text, "𝒜@Ana Petrova", "after a letter outside the basic plane");
});

test("a name binds only when it ends at the end of the text or before a non-letter, non-digit", () => {
  assert.equal(bindMentions("@Ana Petrova", [ana]).text, T(ANA), "end of the text");
  assert.equal(bindMentions("@Ana Petrova's team", [ana]).text, `${T(ANA)}'s team`, "before an apostrophe");
  assert.equal(bindMentions("@Ana Petrova, please", [ana]).text, `${T(ANA)}, please`);
  assert.equal(bindMentions("@Ana Petrovas", [ana]).text, "@Ana Petrovas", "a longer word is another name");
  assert.equal(bindMentions("@Ana Petrova2", [ana]).text, "@Ana Petrova2");
});

test("binding compares exactly, case included", () => {
  assert.equal(bindMentions("@ana petrova and @Ana  Petrova", [ana]).text, "@ana petrova and @Ana  Petrova");
});

test("the longest listed name binds first", () => {
  const long = { userId: CY, name: "Ana Petrova-Ilieva" };
  const bound = bindMentions("@Ana Petrova-Ilieva and @Ana Petrova", [ana, long]);
  assert.equal(bound.text, `${T(CY)} and ${T(ANA)}`);
  assert.equal(bindMentions("@Ana Petrova-Ilieva", [ana]).text, `${T(ANA)}-Ilieva`, "listed alone, the shorter name ends at the hyphen");
});

test("people who share a name take its occurrences in turn, the last taking the rest", () => {
  const twin = { userId: BOB, name: "Ana Petrova" };
  const bound = bindMentions("@Ana Petrova, @Ana Petrova, @Ana Petrova", [ana, twin]);
  assert.equal(bound.text, `${T(ANA)}, ${T(BOB)}, ${T(BOB)}`);
  assert.deepEqual(bindMentions("@Ana Petrova", [ana, twin]).userIds, [ANA], "one occurrence binds the first-listed only");
});

test("a listed person whose name is absent is ignored, and a repeated id counts once", () => {
  assert.deepEqual(bindMentions("Nobody here", [ana]), { text: "Nobody here", userIds: [] });
  assert.deepEqual(bindMentions("@Ana Petrova", [ana, { userId: ANA, name: "Other" }]).userIds, [ANA]);
  assert.deepEqual(bindMentions("@Bob Ivanov", [{ userId: BOB, name: "" }]).userIds, [], "an empty name finds nothing");
});

test("a typed mark is removed, so no typed text can be read back as a mention", () => {
  const forged = `see ${MENTION_OPEN}${BOB}${MENTION_CLOSE} here`;
  const bound = bindMentions(forged, [ana]);
  assert.equal(bound.text, `see ${BOB} here`);
  assert.deepEqual(bound.userIds, []);
  assert.equal(stripMentionMarks(`a${MENTION_OPEN}b${MENTION_CLOSE}c`), "abc");
});

test("stored text round-trips through the serializer", () => {
  const display = "Needs @Ana Petrova's API, then @Bob Ivanov signs off.";
  const stored = bindMentions(display, [ana, bob]).text;
  const names: Record<string, string> = { [ANA]: "Ana Petrova", [BOB]: "Bob Ivanov" };
  assert.equal(displayMentions(stored, (id) => names[id]!), display);
  assert.deepEqual(mentionedUserIds(stored, null, undefined, `x ${T(CY)}`), [ANA, BOB, CY]);
});

test("the serializer writes the current name, or the erased one, and reports where each mention sits", () => {
  const stored = `😀 ${T(ANA)} and ${T(BOB)}`;
  const names: Record<string, string> = { [ANA]: "Ana Ivanova", [BOB]: "Deleted User" };
  const { text, ranges } = renderMentions(stored, (id) => names[id]!);
  assert.equal(text, "😀 @Ana Ivanova and @Deleted User");
  // The emoji is two UTF-16 code units, so the first mention starts at 3.
  assert.deepEqual(ranges, [
    { start: 3, length: 12, userId: ANA },
    { start: 20, length: 13, userId: BOB },
  ]);
  for (const r of ranges) assert.equal(text.slice(r.start, r.start + r.length).startsWith("@"), true);
  assert.deepEqual(renderMentions("plain", () => "x"), { text: "plain", ranges: [] });
  assert.equal(renderMentions(`stray ${MENTION_OPEN}mark ${T(ANA)}`, () => "A").text, "stray mark @A", "a stray mark is never shown");
});

test("an audit payload carries ids and an AI task a placeholder — never a name", () => {
  const stored = `Ask ${T(ANA)}.`;
  assert.equal(auditMentions(stored), `Ask @[user:${ANA}].`);
  assert.equal(auditMentions(null), null);
  assert.equal(auditMentions("plain"), "plain");
  assert.equal(aiSafeMentions(stored), `Ask ${AI_STORED_MENTION}.`);
  assert.equal(aiSafeMentions("plain"), "plain");
});

test("the drafting aid swaps mentions for numbered placeholders and puts them back", () => {
  const masked = maskMentionsForAi(["Ask @Ana Petrova, then @Bob Ivanov.", "@Ana Petrova pays"], [ana, bob]);
  assert.deepEqual(masked.texts, ["Ask @[1], then @[2].", "@[1] pays"]);
  assert.deepEqual(masked.names, ["Ana Petrova", "Bob Ivanov"]);
  assert.equal(masked.texts.join(" ").includes("Petrova"), false, "no name reaches the prompt");
  assert.equal(unmaskMentionsFromAi("First @[2], then @[1].", masked.names), "First @Bob Ivanov, then @Ana Petrova.");
});

test("a placeholder the model dropped is gone, and one it invented is removed", () => {
  const { names } = maskMentionsForAi(["@Ana Petrova and @Bob Ivanov"], [ana, bob]);
  assert.equal(unmaskMentionsFromAi("Only @[2] remains.", names), "Only @Bob Ivanov remains.");
  assert.equal(unmaskMentionsFromAi("Ask @[7] and @[0].", names), "Ask  and .");
  // A placeholder-shaped string the author typed is defused before the prompt is built.
  assert.deepEqual(maskMentionsForAi(["see @[1] and @Ana Petrova"], [ana]).texts, ["see @ [1] and @[1]"]);
});

test("the request parser accepts an absent list and refuses a malformed one", () => {
  assert.deepEqual(parseMentionsInput(undefined), { ok: true, value: null });
  assert.deepEqual(parseMentionsInput(null), { ok: true, value: null });
  assert.deepEqual(parseMentionsInput([]), { ok: true, value: [] });
  assert.deepEqual(parseMentionsInput([{ userId: ANA.toUpperCase(), name: "Ana Petrova" }]), { ok: true, value: [ana] });
  assert.equal(parseMentionsInput("x").ok, false);
  assert.equal(parseMentionsInput([{ userId: "nope", name: "A" }]).ok, false, "not an id");
  assert.equal(parseMentionsInput([{ userId: ANA, name: "" }]).ok, false, "an empty name");
  assert.equal(parseMentionsInput([{ userId: ANA, name: "x".repeat(201) }]).ok, false, "a name over 200 characters");
  assert.equal(parseMentionsInput([ana, { userId: ANA, name: "Again" }]).ok, false, "a repeated person");
  const eleven = Array.from({ length: MENTIONS_PER_SOLUTION + 1 }, (_, i) => ({ userId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, name: "N" }));
  assert.equal(parseMentionsInput(eleven).ok, false, "more than 10 entries");
  assert.equal(parseMentionsInput(eleven.slice(0, MENTIONS_PER_SOLUTION)).ok, true);
});

test("the caps refuse the 11th person on a solution and the 31st of a day", () => {
  assert.equal(mentionCapRefusal(MENTIONS_PER_SOLUTION, 1), null, "the 10th person is allowed");
  assert.equal(mentionCapRefusal(MENTIONS_PER_SOLUTION + 1, 1), "solution_cap");
  assert.equal(mentionCapRefusal(1, MENTIONS_PER_DAY), null, "the 30th of the day is allowed");
  assert.equal(mentionCapRefusal(1, MENTIONS_PER_DAY + 1), "daily_cap");
  assert.equal(mentionCapRefusal(MENTIONS_PER_SOLUTION + 1, MENTIONS_PER_DAY + 1), "solution_cap", "the per-solution cap is checked first");
  assert.deepEqual(mentionRoom(3, 28), { left: 7, leftToday: 2 });
  assert.deepEqual(mentionRoom(12, 40), { left: 0, leftToday: 0 });
  assert.equal(MENTION_MESSAGES.solutionCap, "A solution can mention at most 10 people.");
  assert.equal(MENTION_MESSAGES.dailyCap, "You've mentioned 30 people today. You can mention more tomorrow.");
});

test("the settling check's status table: proposed reaches viewers, a closed solution nobody", () => {
  const scopes = Object.fromEntries(SOLUTION_STATUSES.map((s) => [s, mentionSettleScope(s)]));
  assert.deepEqual(scopes, {
    proposed: "viewers",
    in_review: "all",
    needs_improvement: "all",
    valid: "all",
    accepted_internally: "all",
    waiting_for_resources: "all",
    in_implementation: "all",
    external_acceptance: "all",
    implemented: "all",
    rejected: "none",
    not_selected: "none",
    withdrawn: "none",
  });
  assert.equal(mentionHint(null), MENTION_HINT_LATER, "the propose form");
  assert.equal(mentionHint("proposed"), MENTION_HINT_LATER);
  assert.equal(mentionHint("needs_improvement"), MENTION_HINT_ON_SAVE);
});

test("the composer finds the query the caret is in", () => {
  const at = (text: string, bound: string[] = []) => activeMentionQuery(text, text.length, bound);
  assert.deepEqual(at("Ask @An"), { start: 4, query: "An" });
  assert.deepEqual(at("Ask @Ana Pe"), { start: 4, query: "Ana Pe" }, "spaces are part of the query");
  assert.equal(at("Ask @A"), null, "one character is too few");
  assert.equal(at("Ask @"), null);
  assert.equal(at("mail me@An"), null, "an @ after a letter opens nothing");
  assert.equal(at("@An\nna"), null, "a line break closes it");
  assert.equal(at(`@${"x".repeat(41)}`), null, "more than 40 characters");
  assert.deepEqual(at(`@${"x".repeat(40)}`), { start: 0, query: "x".repeat(40) });
  assert.equal(at("@Ana Petrova ", ["Ana Petrova"]), null, "a finished mention opens nothing");
  assert.equal(at("@Ana Petrova is", ["Ana Petrova"]), null);
  assert.deepEqual(at("@Ana Petrova and @Bo", ["Ana Petrova"]), { start: 17, query: "Bo" }, "the nearest @ is the one that counts");
  assert.equal(activeMentionQuery("@Ana", 0), null, "nothing before the caret");
  assert.deepEqual(activeMentionQuery("@Ana Petrova", 3), { start: 0, query: "An" }, "only the text up to the caret");
});

test("a pick replaces the @ and the query with the name and a space", () => {
  const q = activeMentionQuery("Ask @An about it", 7)!;
  assert.deepEqual(insertMention("Ask @An about it", q.start, 7, "Ana Petrova"), { text: "Ask @Ana Petrova about it", caret: 17 }, "an existing space is reused");
  assert.deepEqual(insertMention("Ask @An", 4, 7, "Ana Petrova"), { text: "Ask @Ana Petrova ", caret: 17 });
  assert.deepEqual(boundUserIds(["Ask @Ana Petrova", null, "and @Bob Ivanov"], [ana, bob]), [ANA, BOB]);
  assert.deepEqual(boundUserIds(["Ask @Ana Petrov"], [ana]), [], "an edited name is no longer a mention");
});

test("event 26 names the sender unless there is none, and is never held for a digest", () => {
  assert.equal(mentionedMessage("Ana Petrova", 34, 412, "Reduce invoice matching time"), 'Ana Petrova mentioned you in SOL-34 on CH-412 "Reduce invoice matching time".');
  assert.equal(mentionedMessage(null, 34, 412, "Reduce invoice matching time"), 'You were mentioned in SOL-34 on CH-412 "Reduce invoice matching time".');
  assert.equal(mentionedSubject("Ana Petrova", 34), "Ana Petrova mentioned you in SOL-34");
  assert.equal(mentionedSubject(null, 34), "You were mentioned in SOL-34");
  assert.equal(isDigestableEvent(26), false);
});
