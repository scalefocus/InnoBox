// Live-DB integration test (gated) for §44 mentions in a comment (INNOBOX_SPEC.md §44.10):
//   • a create with mentions stores tokens — never a name — writes one row per person with the
//     commenter as its sender, audits the ids, and returns display text with each mention's range;
//     the list returns the same, and no response carries a token;
//   • the 5 000-character limit is on the display text: exactly that many with ten mentions is
//     accepted although the stored text is longer, one more is refused; CR LF is stored as one line
//     feed, and a typed U+E000 / U+E001 never becomes a mention;
//   • refusals: an ineligible person (cannot see the item, the commenter, deactivated, unknown)
//     refuses the whole post and writes nothing; a person who already has a row is not checked again;
//   • a `proposed` solution's thread: the `canSee=<SOL-n>` people search offers its team, the
//     assignee and the namespace's reviewers and not a colleague who cannot see it — the SQL twin
//     pinned to the §4.3 rule — the API refuses that colleague, a reviewer is told at once, and once
//     the solution leaves `proposed` the colleague is offered and can be mentioned;
//   • event 27: one inbox row and one outbox row per person told, never held for a digest, never
//     coalesced, never quoting the comment; the commenter named; linked to the comment itself;
//   • event 27 INSTEAD of event 6: a mentioned follower or author gets no comment row for that
//     comment and the unread one they hold is neither refreshed nor counted up; a muted person gets
//     event 6 by its own rules, no event 27, and nothing when the preference comes back on;
//   • edits: an added mention notifies once; removing and re-adding it sends nothing and keeps the
//     row; an edit with no list keeps the current mentions bound and adds nobody; `[]` makes them
//     plain text; the audit row lists who was put in and who was taken out;
//   • the caps: the 11th person on a comment is refused and nothing is written, a told-and-removed
//     person still counts; the 30 a day are ONE budget with solution text — the 31st is refused
//     whichever of the two asks, yesterday's rows do not count, and two concurrent posts cannot both
//     take the last place;
//   • deleting a comment (its owner, or a moderator) removes its event-27 inbox rows and its unsent
//     e-mails and keeps the mention rows; the removed comment's record carries no mention;
//   • opening the challenge reads the rows of its thread and of its solutions' threads; the
//     read-time gate hides a row once the recipient can no longer see the challenge, and brings it
//     back with access;
//   • erasure deletes the person's rows, nulls `mentioned_by`, and turns the name into
//     "@Deleted User" without touching the stored text; the §10.3 cascade removes the rows and the
//     notices of a deleted solution's and a deleted challenge's comments;
//   • agents: `post_comment` creates no mention, `list_comments` returns display text and no
//     `mentions` field; the discussion summary is sent "@colleague", never a name.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { RoleSet } from "@innobox/shared";

const url = process.env.DATABASE_URL;

interface Person {
  userId: string;
  roles: RoleSet;
  name: string;
  /** The second word of the display name — unique to the person, so a people search for it can
   *  only ever find them. */
  word: string;
}
type Candidates = { userId: string; name: string }[];
type Thread = { type: "challenge" | "solution"; id: string };

/** §44.5: no response carries a token — neither of its two marks may appear anywhere in `value`. */
function assertNoToken(value: unknown, what: string): void {
  assert.equal(/[]/.test(JSON.stringify(value)), false, `${what} carries no token`);
}

/** Each mention of a comment record as [whom it names, the text its range covers]. */
function spans(comment: { body: string; mentions: { start: number; length: number; user: { id: string } | null }[] }): (string | null)[][] {
  return comment.mentions.map((m) => [m.user?.id ?? null, comment.body.slice(m.start, m.start + m.length)]);
}

/**
 * What the tests share: two namespaces, the people every challenge needs, and the helpers. The
 * modules under test are imported here, lazily, so a skipped run loads nothing. Roles are held in
 * memory (the resolver the stores are handed); the committee member and the namespace admin also
 * hold theirs through a SCIM-style group and a role mapping, because the people search reads roles
 * in SQL (invariant 1).
 */
async function fixtures(pool: Pool) {
  const { randomUUID } = await import("node:crypto");
  const { buildRoleSet } = await import("@innobox/shared");
  const store = await import("../challenges/store");
  const { createComment, editComment } = await import("./store");
  const { notifyCommentMentioned, notifyCommentPosted } = await import("../../../lib/notify-events");

  const stamp = randomUUID().slice(0, 8);
  const globalId = (await pool.query<{ id: string }>(`select id from namespaces where slug = 'global'`)).rows[0]!.id;
  const mkNs = async (label: string) =>
    (
      await pool.query<{ id: string }>(`insert into namespaces (slug, display_name) values ($1, $2) returning id`, [
        `dbtest-cmention-${label}-${stamp}`,
        `Dbtest Comment Mention ${label}`,
      ])
    ).rows[0]!.id;
  const nsId = await mkNs("main");
  const otherNsId = await mkNs("other");
  const rolesOf = new Map<string, RoleSet>();
  const roles = (role: "member" | "committee" | "namespace_admin", ns: string) => buildRoleSet([{ role, namespaceId: ns }], { globalNamespaceId: globalId });
  const mkUser = async (label: string, r: RoleSet = roles("member", nsId)): Promise<Person> => {
    const word = `${label}${stamp}`;
    const name = `Dbc ${word}`;
    const id = (
      await pool.query<{ id: string }>(`insert into users (external_id, user_name, display_name) values ($1, $2, $3) returning id`, [
        `dbtest-cmention-${label}-${stamp}`,
        `dbtest-cmention-${label}-${stamp}@example.test`,
        name,
      ])
    ).rows[0]!.id;
    rolesOf.set(id, r);
    return { userId: id, roles: r, name, word };
  };
  /** The same role, as the SQL side resolves it: a group, its mapping in the main namespace, a member. */
  const dbGrant = async (person: Person, role: "committee" | "namespace_admin") => {
    const external = `dbtest-cmention-${role}-${stamp}`;
    const groupId = (await pool.query<{ id: string }>(`insert into groups (external_id, display_name) values ($1, $1) returning id`, [external])).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_external_id, role, namespace_id) values ($1, $2, $3)`, [external, role, nsId]);
    await pool.query(`insert into group_members (group_id, user_id) values ($1, $2)`, [groupId, person.userId]);
  };
  const resolveRoles = Object.assign(async (id: string) => rolesOf.get(id) ?? roles("member", globalId), {});
  const ctx = (actorId: string | null) => ({ pool, actorId, resolveRoles });

  const author = await mkUser("author");
  const committee = await mkUser("committee", roles("committee", nsId));
  await dbGrant(committee, "committee");
  const nsAdmin = await mkUser("nsadmin", roles("namespace_admin", nsId));
  await dbGrant(nsAdmin, "namespace_admin");
  // Held in memory only: the stores take the caller's roles as given, and nothing here searches for one.
  const platform = await mkUser("platform", buildRoleSet([{ role: "platform_admin", namespaceId: null }], { globalNamespaceId: globalId }));
  const internal = (await store.listActiveImpactAreas(pool)).find((a) => a.name === "Internal")!;
  const at = (p: Person) => `@${p.name}`;
  const cand = (...people: Person[]): Candidates => people.map((p) => ({ userId: p.userId, name: p.name }));

  const newChallenge = async (label: string, visibility: "org" | "namespace" = "org") => {
    const title = `${label} ${stamp}`;
    const r = await store.createChallenge(pool, author, {
      impactAreaId: internal.id,
      namespaceId: nsId,
      title,
      description: "d",
      clientName: null,
      visibility,
      isAnonymous: false,
    });
    if (r.status !== "ok") throw new Error(`create failed: ${r.status}`);
    const num = r.challenge.number.replace("CH-", "");
    assert.equal((await store.setChallengeStatus(pool, nsAdmin, num, "valid")).status, "ok");
    return { id: r.challenge.id, num, title };
  };
  const propose = async (chNum: string, who: Person, description: string, coAuthorIds: string[] = []) => {
    const r = await store.createSolution(pool, who, chNum, {
      description,
      costVsBenefits: null,
      isAnonymous: false,
      ...(coAuthorIds.length > 0 ? { coAuthors: { ids: coAuthorIds, resolveRoles } } : {}),
    });
    if (r.status !== "ok") throw new Error(`propose failed: ${r.status}`);
    return { id: r.solution.id, num: r.solution.number.replace("SOL-", "") };
  };
  const move = async (actor: Person, sol: { num: string }, status: string) => {
    const r = await store.setSolutionStatus(pool, actor, sol.num, status, resolveRoles);
    if (r.status !== "ok") throw new Error(`move to ${status} failed: ${r.status}`);
  };

  /** The store call alone. `candidates: undefined` sends no list — what an agent's post does. */
  const postRaw = (who: Person, thread: Thread, body: string, candidates?: Candidates) =>
    createComment(pool, who, thread.type, thread.id, body, undefined, null, undefined, candidates ? { candidates, resolveRoles } : undefined);
  /** POST /api/comments, as the route runs it: the save, then event 27, then event 6 without the
   *  people event 27 reached (§44.6). */
  const post = async (who: Person, thread: Thread, body: string, candidates?: Candidates) => {
    const r = await postRaw(who, thread, body, candidates);
    if (r.status !== "ok") throw new Error(`post failed: ${r.status}`);
    const told = await notifyCommentMentioned(ctx(who.userId), r.comment, r.mentioned);
    await notifyCommentPosted(ctx(who.userId), thread.type, thread.id, r.comment.authorId, r.replyToAuthorId, told);
    return { ...r, told };
  };
  /** The store call alone. `undefined` passes no `mentions` at all; `null` is the route's form of an
   *  absent list; `[]` takes every mention out of the text. */
  const editRaw = (who: Person, commentId: string, body: string, candidates?: Candidates | null) =>
    editComment(pool, who, commentId, body, candidates === undefined ? undefined : { candidates, resolveRoles });
  /** PATCH /api/comments/:id, as the route runs it: the save, then event 27. An edit writes no event 6. */
  const edit = async (who: Person, commentId: string, body: string, candidates?: Candidates | null) => {
    const r = await editRaw(who, commentId, body, candidates);
    if (r.status !== "ok") throw new Error(`edit failed: ${r.status}`);
    const told = await notifyCommentMentioned(ctx(who.userId), r.comment, r.mentioned);
    return { ...r, told };
  };

  const rowsOf = async (commentId: string) =>
    (await pool.query<{ user_id: string; mentioned_by: string | null }>(`select user_id, mentioned_by from comment_mentions where comment_id = $1 order by user_id`, [commentId])).rows;
  const storedOf = async (commentId: string) => (await pool.query<{ body: string }>(`select body from comments where id = $1`, [commentId])).rows[0]!.body;
  const commentsBy = async (person: Person) => (await pool.query<{ n: number }>(`select count(*)::int as n from comments where author_id = $1`, [person.userId])).rows[0]!.n;
  /** A person's event-27 inbox rows — all of them, or those about one comment. */
  const inbox27 = async (person: Person, commentId: string | null = null) =>
    (
      await pool.query<{ id: string; payload: Record<string, unknown>; read_at: Date | null; challenge_id: string | null; solution_id: string | null }>(
        `select id, payload, read_at, challenge_id, solution_id from notifications
          where user_id = $1 and type = 'mentioned_in_comment' and ($2::text is null or payload->>'commentId' = $2::text)
          order by created_at, id`,
        [person.userId, commentId],
      )
    ).rows;
  const outbox27 = async (person: Person, commentId: string | null = null) =>
    (
      await pool.query<{ status: string; digest_due_at: Date | null; payload: Record<string, unknown> }>(
        `select status, digest_due_at, payload from notification_outbox
          where user_id = $1 and type = 'mentioned_in_comment' and ($2::text is null or payload->>'commentId' = $2::text)
          order by created_at, id`,
        [person.userId, commentId],
      )
    ).rows;
  /** A person's event-6 inbox rows about one item. */
  const inbox6 = async (person: Person, parentId: string) =>
    (
      await pool.query<{ id: string; payload: Record<string, unknown>; read_at: Date | null; created_at: Date }>(
        `select id, payload, read_at, created_at from notifications
          where user_id = $1 and type = 'comment_posted' and payload->>'parentId' = $2 order by created_at, id`,
        [person.userId, parentId],
      )
    ).rows;
  /** The mention rows a person created since UTC midnight — in solution text and in comments. */
  const sentToday = async (person: Person) => {
    const today = `created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`;
    const { rows } = await pool.query<{ n: number }>(
      `select ((select count(*) from solution_mentions where mentioned_by = $1 and ${today})
             + (select count(*) from comment_mentions where mentioned_by = $1 and ${today}))::int as n`,
      [person.userId],
    );
    return rows[0]!.n;
  };

  return {
    stamp,
    nsId,
    otherNsId,
    roles,
    resolveRoles,
    mkUser,
    author,
    committee,
    nsAdmin,
    platform,
    at,
    cand,
    newChallenge,
    propose,
    move,
    postRaw,
    post,
    editRaw,
    edit,
    rowsOf,
    storedOf,
    commentsBy,
    inbox27,
    outbox27,
    inbox6,
    sentToday,
  };
}

test(
  "comment mentions: save, limits, refusals, a proposed solution's thread, event 27 instead of event 6, edits",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { COMMENT_BODY_MAX, MENTION_CLOSE, MENTION_OPEN, MENTIONS_PER_COMMENT, MENTIONS_PER_DAY, canSeeSolution, commentMentionedMessage, commentMentionedSubject, mentionedUserIds } =
      await import("@innobox/shared");
    const store = await import("../challenges/store");
    const { listComments } = await import("./store");
    const { searchActiveUsers } = await import("../users/store");
    const { toggleFollow } = await import("../follows/store");

    const pool = new Pool({ connectionString: url });
    try {
      const f = await fixtures(pool);
      const { at, cand, stamp, author, committee, nsAdmin } = f;
      const ana = await f.mkUser("ana");
      const bob = await f.mkUser("bob");
      const ch = await f.newChallenge("Main");
      const thread: Thread = { type: "challenge", id: ch.id };
      const place = { challengeNumber: ch.num, solutionNumber: null, challengeTitle: ch.title };
      const word = `kiwi${stamp}`;

      // ── A create with mentions: tokens in the stored text, display text and ranges in the answer. ──
      // The committee member takes a daily digest: event 27 is actionable, so it is never held.
      await pool.query(`update users set email_delivery = 'daily' where id = $1`, [committee.userId]);
      const c1Text = `Ping ${at(bob)} and ${at(committee)} about the ${word} idea.`;
      const c1 = await f.post(ana, thread, c1Text, cand(bob, committee));
      assert.deepEqual(c1.mentioned, [bob.userId, committee.userId], "the save reports the people it gave a row");
      assert.deepEqual(
        Object.fromEntries((await f.rowsOf(c1.comment.id)).map((r) => [r.user_id, r.mentioned_by])),
        { [bob.userId]: ana.userId, [committee.userId]: ana.userId },
        "one row per person, the commenter as its sender",
      );
      const c1Stored = await f.storedOf(c1.comment.id);
      assert.equal(c1Stored.includes(bob.name) || c1Stored.includes(committee.name), false, "the stored text holds no name");
      assert.deepEqual(mentionedUserIds(c1Stored), [bob.userId, committee.userId], "…it holds a token per person");
      assert.equal(c1.comment.body, c1Text, "the answer carries display text");
      assert.deepEqual(spans(c1.comment), [
        [bob.userId, at(bob)],
        [committee.userId, at(committee)],
      ]);
      assert.deepEqual(c1.comment.mentions[0]!.user, { id: bob.userId, displayName: bob.name, active: true });
      assert.equal(c1.comment.mentionsLeft, MENTIONS_PER_COMMENT - 2, "its author's room under the per-comment cap");
      assertNoToken(c1, "the create's answer");

      const listedForBob = await listComments(pool, bob, "challenge", ch.id);
      assert.ok(listedForBob, "the thread is listed");
      const c1Listed = listedForBob.comments.find((c) => c.id === c1.comment.id)!;
      assert.equal(c1Listed.body, c1Text, "the list returns the same display text");
      assert.deepEqual(c1Listed.mentions, c1.comment.mentions, "…and the same ranges");
      assert.equal(c1Listed.mentionsLeft, null, "only the person who may edit a comment gets its room");
      assert.equal(listedForBob.mentionsLeftToday, MENTIONS_PER_DAY);
      assertNoToken(listedForBob, "the list");
      const listedForAna = await listComments(pool, ana, "challenge", ch.id);
      assert.equal(listedForAna!.comments.find((c) => c.id === c1.comment.id)!.mentionsLeft, MENTIONS_PER_COMMENT - 2);
      assert.equal(listedForAna!.mentionsLeftToday, MENTIONS_PER_DAY - 2);

      const { rows: postedAudit } = await pool.query<{ after: Record<string, unknown> }>(`select after from audit_log where action = 'comment.posted' and target_id = $1`, [c1.comment.id]);
      assert.deepEqual(postedAudit[0]!.after.mentions, [bob.userId, committee.userId], "the audit row lists the ids");
      assert.equal(JSON.stringify(postedAudit[0]!.after).includes(bob.name), false, "…and no name");

      // ── Event 27: one inbox row and one outbox row per person told. ──
      const bobRows = await f.inbox27(bob, c1.comment.id);
      assert.equal(bobRows.length, 1, "one inbox row");
      const notice = bobRows[0]!;
      assert.equal(notice.payload.message, commentMentionedMessage(ana.name, place));
      assert.equal(notice.payload.subject, commentMentionedSubject(ana.name, place));
      assert.equal(notice.payload.link, `/challenges/${ch.num}#comment-${c1.comment.id}`, "linked to the comment itself");
      assert.deepEqual(
        {
          commentId: notice.payload.commentId,
          parentType: notice.payload.parentType,
          parentId: notice.payload.parentId,
          challengeId: notice.payload.challengeId,
          challengeNumber: notice.payload.challengeNumber,
          solutionNumber: notice.payload.solutionNumber,
          title: notice.payload.title,
          mentionerId: notice.payload.mentionerId,
          mentionerName: notice.payload.mentionerName,
        },
        {
          commentId: c1.comment.id,
          parentType: "challenge",
          parentId: ch.id,
          challengeId: ch.id,
          challengeNumber: `CH-${ch.num}`,
          solutionNumber: null,
          title: ch.title,
          mentionerId: ana.userId,
          mentionerName: ana.name,
        },
      );
      assert.deepEqual([notice.challenge_id, notice.solution_id], [ch.id, null], "the row carries its item, so the read-time gates apply");
      assert.equal(notice.read_at, null);
      const bobMail = await f.outbox27(bob, c1.comment.id);
      assert.equal(bobMail.length, 1, "one outbox row");
      assert.equal(bobMail[0]!.payload.subject, commentMentionedSubject(ana.name, place));
      assert.equal(bobMail[0]!.payload.notificationId, notice.id);
      for (const payload of [notice.payload, bobMail[0]!.payload]) {
        assert.equal(JSON.stringify(payload).includes(word), false, "neither the bell nor the e-mail quotes the comment");
      }
      assert.equal((await f.inbox27(committee, c1.comment.id)).length, 1);
      const committeeMail = await f.outbox27(committee, c1.comment.id);
      assert.equal(committeeMail.length, 1);
      assert.equal(committeeMail[0]!.digest_due_at, null, "never held for a digest");
      assert.equal("digest" in committeeMail[0]!.payload, false);
      assert.equal((await f.inbox27(ana)).length, 0, "the commenter is told nothing");
      // Never coalesced: a second comment on the same item is a second row.
      const c2 = await f.post(ana, thread, `And again, ${at(bob)}.`, cand(bob));
      assert.deepEqual(
        (await f.inbox27(bob)).map((r) => String(r.payload.commentId)).sort(),
        [c1.comment.id, c2.comment.id].sort(),
        "one row per comment",
      );

      // ── The limit is on the display text: 5 000 characters with ten mentions. ──
      const scribe = await f.mkUser("scribe");
      const crowd: Person[] = [];
      for (let i = 0; i < MENTIONS_PER_COMMENT; i += 1) crowd.push(await f.mkUser(`crowd${String.fromCharCode(97 + i)}`));
      const everyone = crowd.map(at).join(" ");
      const longText = `${everyone} ${"x".repeat(COMMENT_BODY_MAX - everyone.length - 1)}`;
      assert.equal(longText.length, COMMENT_BODY_MAX);
      const long = await f.postRaw(scribe, thread, longText, cand(...crowd));
      assert.equal(long.status, "ok", "5 000 characters of display text with ten mentions is accepted");
      if (long.status !== "ok") throw new Error("long comment");
      assert.equal(long.comment.body.length, COMMENT_BODY_MAX);
      assert.equal(long.comment.mentions.length, MENTIONS_PER_COMMENT);
      assert.equal((await f.rowsOf(long.comment.id)).length, MENTIONS_PER_COMMENT);
      assert.ok((await f.storedOf(long.comment.id)).length > COMMENT_BODY_MAX, "the stored text is longer — the limit is not on it");
      assert.equal((await f.postRaw(scribe, thread, `  ${longText}\r\n`)).status, "ok", "…and it is checked after trimming");
      const scribeComments = await f.commentsBy(scribe);
      assert.equal((await f.postRaw(scribe, thread, `${longText}x`, cand(...crowd))).status, "invalid", "5 001 characters is refused");
      assert.equal(await f.commentsBy(scribe), scribeComments);

      // ── CR LF is one line feed; a typed mark never becomes a mention. ──
      const lines = await f.postRaw(ana, thread, "Line one\r\nLine two\r\n\r\nLine four");
      assert.equal(lines.status, "ok");
      if (lines.status !== "ok") throw new Error("line breaks");
      assert.equal(await f.storedOf(lines.comment.id), "Line one\nLine two\n\nLine four");
      assert.equal(lines.comment.body, "Line one\nLine two\n\nLine four");
      const forged = await f.postRaw(ana, thread, `Forged ${MENTION_OPEN}${bob.userId}${MENTION_CLOSE} token.`, cand(bob));
      assert.equal(forged.status, "ok");
      if (forged.status !== "ok") throw new Error("forged token");
      assert.equal(await f.storedOf(forged.comment.id), `Forged ${bob.userId} token.`, "both marks are removed from a submitted body");
      assert.deepEqual([forged.mentioned, forged.comment.mentions, await f.rowsOf(forged.comment.id)], [[], [], []], "…so it mentions nobody");

      // ── Refusals: one answer for every reason, and nothing written. ──
      const restricted = await f.newChallenge("Restricted", "namespace");
      const restrictedThread: Thread = { type: "challenge", id: restricted.id };
      const outsider = await f.mkUser("outsider", f.roles("member", f.otherNsId));
      const gone = await f.mkUser("gone");
      await pool.query(`update users set active = false where id = $1`, [gone.userId]);
      const written = async () =>
        (
          await pool.query<{ comments: number; mention_rows: number }>(
            `select (select count(*) from comments where author_id = $1)::int as comments,
                    (select count(*) from comment_mentions where mentioned_by = $1)::int as mention_rows`,
            [ana.userId],
          )
        ).rows[0]!;
      const writtenBefore = await written();
      for (const [why, body, candidates] of [
        ["cannot see the challenge", `Ask ${at(outsider)}.`, cand(outsider)],
        ["the commenter", `Ask ${at(ana)}.`, cand(ana)],
        ["deactivated", `Ask ${at(gone)}.`, cand(gone)],
        ["unknown", "Ask @Nobody Atall.", [{ userId: randomUUID(), name: "Nobody Atall" }]],
        ["one bad person among good ones", `Ask ${at(bob)} and ${at(outsider)}.`, cand(bob, outsider)],
      ] as const) {
        assert.deepEqual(await f.postRaw(ana, restrictedThread, body, [...candidates]), { status: "ineligible_mention" }, why);
      }
      assert.deepEqual(await written(), writtenBefore, "a refused post writes nothing — not the comment, not the rows");
      // A newly mentioned ineligible person refuses an edit too, leaving the text as it was.
      const plain = await f.post(ana, restrictedThread, "A remark.");
      assert.deepEqual(await f.editRaw(ana, plain.comment.id, `A remark for ${at(outsider)}.`, cand(outsider)), { status: "ineligible_mention" });
      assert.equal(await f.storedOf(plain.comment.id), "A remark.");
      // Someone who already has a row is not checked again: their mention survives their deactivation.
      const leaver = await f.mkUser("leaver");
      const forLeaver = await f.post(ana, restrictedThread, `For ${at(leaver)}.`, cand(leaver));
      await pool.query(`update users set active = false where id = $1`, [leaver.userId]);
      const kept = await f.editRaw(ana, forLeaver.comment.id, `Reworded, for ${at(leaver)}.`, cand(leaver));
      assert.equal(kept.status, "ok", "an edit that keeps an existing mention is not refused");
      if (kept.status !== "ok") throw new Error("kept mention");
      assert.deepEqual(mentionedUserIds(await f.storedOf(forLeaver.comment.id)), [leaver.userId]);
      assert.deepEqual(kept.comment.mentions[0]!.user, { id: leaver.userId, displayName: leaver.name, active: false }, "a deactivated person's mention says so");

      // ── A `proposed` solution's thread: only its team, the assignee and the reviewers. ──
      const assignee = await f.mkUser("assignee");
      const co = await f.mkUser("co");
      assert.equal((await store.setChallengeAssignee(pool, nsAdmin, ch.num, assignee.userId, f.resolveRoles)).status, "ok");
      const proposed = await f.propose(ch.num, ana, "A proposed idea.", [co.userId]);
      const proposedThread: Thread = { type: "solution", id: proposed.id };
      const audienceFor = (viewer: Person) => store.getCoAuthorPickerAudience(pool, viewer, { canSee: `SOL-${proposed.num}` });
      /** GET /api/users?q=&canSee=<SOL-n>, as the route runs it: null when the caller gets no audience. */
      const offered = async (viewer: Person, person: Person) => {
        const audience = await audienceFor(viewer);
        if (!audience) return null;
        return (await searchActiveUsers(pool, person.word, undefined, { ...audience, callerId: viewer.userId })).some((u) => u.id === person.userId);
      };
      // The SQL twin against the §4.3 rule itself, for every kind of person.
      const seesProposed = (person: Person) =>
        canSeeSolution({ userId: person.userId, roles: person.roles }, { namespaceId: f.nsId, assigneeId: assignee.userId }, { status: "proposed", authorIds: [ana.userId, co.userId], trashed: false });
      for (const [person, expected] of [
        [committee, true],
        [nsAdmin, true],
        [co, true],
        [assignee, true],
        [bob, false],
      ] as const) {
        assert.equal(seesProposed(person), expected, `${person.name}: the §4.3 rule`);
        assert.equal(await offered(ana, person), expected, `${person.name}: the search agrees with it`);
      }
      assert.equal(await offered(ana, ana), false, "the caller is never offered");
      assert.equal(await audienceFor(bob), null, "a solution the caller cannot see answers as an unknown one");
      assert.equal(await store.getCoAuthorPickerAudience(pool, ana, { canSee: "SOL-999999999" }), null);
      assert.deepEqual(
        await f.postRaw(ana, proposedThread, `What does ${at(bob)} think?`, cand(bob)),
        { status: "ineligible_mention" },
        "a colleague who cannot see a proposed solution cannot be mentioned in its thread",
      );
      const forReviewer = await f.post(ana, proposedThread, `Could ${at(committee)} take a look?`, cand(committee));
      assert.deepEqual(forReviewer.told, [committee.userId]);
      const reviewerRows = await f.inbox27(committee, forReviewer.comment.id);
      assert.equal(reviewerRows.length, 1, "a reviewer is told at once");
      const onSolution = { challengeNumber: ch.num, solutionNumber: proposed.num, challengeTitle: ch.title };
      assert.equal(reviewerRows[0]!.payload.message, commentMentionedMessage(ana.name, onSolution));
      assert.equal(reviewerRows[0]!.payload.subject, commentMentionedSubject(ana.name, onSolution));
      assert.equal(reviewerRows[0]!.payload.link, `/challenges/${ch.num}#comment-${forReviewer.comment.id}`);
      assert.deepEqual(
        [reviewerRows[0]!.payload.parentType, reviewerRows[0]!.payload.parentId, reviewerRows[0]!.payload.challengeNumber, reviewerRows[0]!.payload.solutionNumber],
        ["solution", proposed.id, `CH-${ch.num}`, `SOL-${proposed.num}`],
      );
      assert.deepEqual([reviewerRows[0]!.challenge_id, reviewerRows[0]!.solution_id], [ch.id, proposed.id]);
      // Once it leaves `proposed`, whoever can see the challenge can read the thread.
      await f.move(committee, proposed, "in_review");
      assert.equal((await f.inbox27(committee, forReviewer.comment.id)).length, 1, "a proposed solution that opens later sends nothing new");
      assert.equal(await offered(ana, bob), true, "the colleague is offered now");
      assert.equal(await offered(bob, committee), true, "…and can search the thread's readers himself");
      const forBob = await f.post(ana, proposedThread, `Now, what does ${at(bob)} think?`, cand(bob));
      assert.deepEqual(forBob.told, [bob.userId]);
      assert.equal((await f.inbox27(bob, forBob.comment.id)).length, 1);

      // ── Event 27 INSTEAD of event 6. ──
      const followed = await f.newChallenge("Followed");
      const followedThread: Thread = { type: "challenge", id: followed.id };
      const fol = await f.mkUser("fol");
      const late = await f.mkUser("late");
      const quiet = await f.mkUser("quiet");
      await pool.query(`update users set notify_mentions = false where id = $1`, [quiet.userId]);
      for (const person of [fol, quiet]) assert.deepEqual(await toggleFollow(pool, person, "challenge", followed.id), { status: "ok", following: true });
      await f.post(ana, followedThread, "A first remark.");
      for (const person of [author, fol, quiet]) {
        const rows = await f.inbox6(person, followed.id);
        assert.equal(rows.length, 1, `${person.name} holds an unread comment row`);
        assert.equal(rows[0]!.payload.count, 1);
      }
      // `late` follows only now, so holds no comment row yet.
      assert.deepEqual(await toggleFollow(pool, late, "challenge", followed.id), { status: "ok", following: true });
      const heldByAuthor = await f.inbox6(author, followed.id);
      const heldByFol = await f.inbox6(fol, followed.id);
      const forAll = `A second one, for ${at(fol)}, ${at(late)}, ${at(author)} and ${at(quiet)}.`;
      const second = await f.post(ana, followedThread, forAll, cand(fol, late, author, quiet));
      assert.deepEqual(second.mentioned, [fol.userId, late.userId, author.userId, quiet.userId]);
      assert.deepEqual(second.told, [fol.userId, late.userId, author.userId], "a person whose Mentions preference is off is not told");
      for (const person of [fol, late, author]) assert.equal((await f.inbox27(person, second.comment.id)).length, 1, `${person.name} gets event 27`);
      assert.deepEqual(await f.inbox6(fol, followed.id), heldByFol, "a mentioned follower's unread comment row is neither refreshed nor counted up");
      assert.deepEqual(await f.inbox6(author, followed.id), heldByAuthor, "…nor the item's author's");
      assert.equal((await f.inbox6(late, followed.id)).length, 0, "…and the comment opens no row for a mentioned person");
      assert.equal((await f.inbox27(quiet)).length, 0, "the muted person gets no event 27");
      const quietRows = await f.inbox6(quiet, followed.id);
      assert.equal(quietRows.length, 1);
      assert.equal(quietRows[0]!.payload.count, 2, "…and event 6 by its own rules");
      assert.ok((await f.rowsOf(second.comment.id)).some((r) => r.user_id === quiet.userId), "their mention row is written all the same");
      await pool.query(`update users set notify_mentions = true where id = $1`, [quiet.userId]);
      const resaved = await f.edit(ana, second.comment.id, forAll, cand(fol, late, author, quiet));
      assert.deepEqual(resaved.mentioned, []);
      assert.equal((await f.inbox27(quiet)).length, 0, "switching the preference back on brings nothing back");

      // ── Edits: told once per person per comment. ──
      const cy = await f.mkUser("cy");
      const dee = await f.mkUser("dee");
      const draft = await f.post(ana, thread, "An afterthought.");
      assert.deepEqual(draft.mentioned, []);
      const withCy = `An afterthought, for ${at(cy)}.`;
      const added = await f.edit(ana, draft.comment.id, withCy, cand(cy));
      assert.deepEqual([added.mentioned, added.told], [[cy.userId], [cy.userId]], "a mention added in an edit notifies");
      assert.equal((await f.inbox27(cy, draft.comment.id)).length, 1);
      assertNoToken(added, "the edit's answer");
      // `[]` takes the mention out of the text; its row stays and nothing is taken back.
      const removed = await f.edit(ana, draft.comment.id, withCy, []);
      assert.deepEqual([removed.mentioned, removed.comment.body, removed.comment.mentions], [[], withCy, []], "the name is ordinary text now");
      assert.deepEqual(mentionedUserIds(await f.storedOf(draft.comment.id)), []);
      assert.deepEqual(await f.rowsOf(draft.comment.id), [{ user_id: cy.userId, mentioned_by: ana.userId }], "the row is the once-per-comment marker");
      assert.equal((await f.inbox27(cy, draft.comment.id)).length, 1, "removing a mention takes nothing back");
      // Adding it back binds it again and sends nothing.
      const readded = await f.edit(ana, draft.comment.id, withCy, cand(cy));
      assert.deepEqual(readded.mentioned, []);
      assert.deepEqual(mentionedUserIds(await f.storedOf(draft.comment.id)), [cy.userId]);
      assert.equal((await f.inbox27(cy, draft.comment.id)).length, 1, "told once per comment, ever");
      assert.equal((await f.outbox27(cy, draft.comment.id)).length, 1);
      // An edit with no list keeps the current mentions bound, by their current names, and adds nobody.
      const reworded = `Reworded: ${at(cy)} first, then @Someone Else and ${at(dee)}.`;
      const noList = await f.editRaw(ana, draft.comment.id, reworded);
      assert.equal(noList.status, "ok");
      if (noList.status !== "ok") throw new Error("edit with no list");
      assert.deepEqual(noList.mentioned, []);
      assert.equal(noList.comment.body, reworded);
      assert.deepEqual(spans(noList.comment), [[cy.userId, at(cy)]], "the current mention stays bound; a typed name is plain text");
      assert.deepEqual(await f.rowsOf(draft.comment.id), [{ user_id: cy.userId, mentioned_by: ana.userId }], "nobody new gets a row");
      // The route's form of an absent list — `candidates: null` — reads the same.
      const absent = await f.editRaw(ana, draft.comment.id, `Reworded once more, for ${at(cy)}.`, null);
      assert.equal(absent.status, "ok");
      assert.deepEqual(mentionedUserIds(await f.storedOf(draft.comment.id)), [cy.userId]);
      assert.equal((await f.inbox27(dee)).length, 0);
      const { rows: editAudit } = await pool.query<{ after: Record<string, unknown> | null }>(
        `select after from audit_log where action = 'comment.edited' and target_id = $1 order by id`,
        [draft.comment.id],
      );
      assert.deepEqual(
        editAudit.map((r) => r.after),
        [{ mentionsAdded: [cy.userId] }, { mentionsRemoved: [cy.userId] }, { mentionsAdded: [cy.userId] }, null, null],
        "the audit row lists who was put into the text and who was taken out — ids only",
      );
    } finally {
      await pool.end();
    }
  },
);

test(
  "comment mentions: caps, a removed comment, reading, erasure, the delete cascade, agents",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { DEFAULT_MCP_SETTINGS, MENTIONS_PER_COMMENT, MENTIONS_PER_DAY, commentMentionedMessage } = await import("@innobox/shared");
    const store = await import("../challenges/store");
    const { deleteComment, listComments } = await import("./store");
    const { scrubUser } = await import("../users/store");
    const { deleteChallenge, deleteSolution } = await import("../challenges/delete");
    const { getInbox } = await import("../notifications/store");
    const { markCommentNotificationsReadForChallenge } = await import("../../../lib/notify");
    const { commentMentionRoomFor } = await import("../../../lib/mentions");
    const { findTool, runTool } = await import("../../../lib/mcp/tools");
    type ToolContext = import("../../../lib/mcp/tools").ToolContext;

    const pool = new Pool({ connectionString: url });
    try {
      const f = await fixtures(pool);
      const { at, cand, stamp, committee, nsAdmin, platform } = f;
      const ana = await f.mkUser("ana");
      const bob = await f.mkUser("bob");
      const cy = await f.mkUser("cy");
      const ch = await f.newChallenge("Main");
      const thread: Thread = { type: "challenge", id: ch.id };

      // ── The per-comment cap. ──
      const zed = await f.mkUser("zed");
      const crowd: Person[] = [];
      for (let i = 0; i < MENTIONS_PER_COMMENT + 1; i += 1) crowd.push(await f.mkUser(`crowd${String.fromCharCode(97 + i)}`));
      const ten = crowd.slice(0, MENTIONS_PER_COMMENT);
      const nine = crowd.slice(0, MENTIONS_PER_COMMENT - 1);
      const tenth = crowd[MENTIONS_PER_COMMENT - 1]!;
      const eleventh = crowd[MENTIONS_PER_COMMENT]!;
      const naming = (people: Person[]) => people.map(at).join(", ");
      const capped = await f.newChallenge("Caps");
      const cappedThread: Thread = { type: "challenge", id: capped.id };
      const leftToday = async (person: Person) => (await listComments(pool, person, "challenge", capped.id))!.mentionsLeftToday;

      const k1 = await f.post(zed, cappedThread, `For ${naming(nine)}.`, cand(...nine));
      assert.equal(k1.comment.mentionsLeft, 1);
      const withTenth = await f.edit(zed, k1.comment.id, `For ${naming(ten)}.`, cand(...ten));
      assert.deepEqual(withTenth.mentioned, [tenth.userId], "the 10th person is allowed");
      assert.equal(withTenth.comment.mentionsLeft, 0);
      assert.equal((await f.rowsOf(k1.comment.id)).length, MENTIONS_PER_COMMENT);
      const k1Stored = await f.storedOf(k1.comment.id);
      assert.deepEqual(await f.editRaw(zed, k1.comment.id, `For ${naming(crowd)}.`, cand(...crowd)), { status: "mention_cap", reason: "comment_cap" }, "the 11th is refused");
      assert.equal(await f.storedOf(k1.comment.id), k1Stored, "a save over the cap writes nothing — not the text…");
      assert.equal((await f.rowsOf(k1.comment.id)).length, MENTIONS_PER_COMMENT, "…not the rows");
      const zedComments = await f.commentsBy(zed);
      assert.deepEqual(await f.postRaw(zed, cappedThread, `For ${naming(crowd)}.`, cand(...crowd)), { status: "mention_cap", reason: "comment_cap" });
      assert.equal(await f.commentsBy(zed), zedComments, "a refused post leaves no comment behind");
      // A person told and since taken out of the text still counts toward the 10.
      const withoutTenth = await f.edit(zed, k1.comment.id, `For ${naming(nine)}.`, cand(...nine));
      assert.deepEqual(withoutTenth.mentioned, []);
      assert.equal((await f.rowsOf(k1.comment.id)).length, MENTIONS_PER_COMMENT, "the row of a person taken out of the text stays");
      assert.deepEqual(await f.editRaw(zed, k1.comment.id, `For ${naming(nine)} and ${at(eleventh)}.`, cand(...nine, eleventh)), {
        status: "mention_cap",
        reason: "comment_cap",
      });
      const room = await commentMentionRoomFor(pool, zed.userId, [k1.comment.id]);
      assert.equal(room.left.get(k1.comment.id), 0);
      assert.equal(room.leftToday, MENTIONS_PER_DAY - MENTIONS_PER_COMMENT);
      const zedList = await listComments(pool, zed, "challenge", capped.id);
      assert.equal(zedList!.comments.find((c) => c.id === k1.comment.id)!.mentionsLeft, 0, "the editable comment carries its room");
      assert.equal(zedList!.mentionsLeftToday, MENTIONS_PER_DAY - MENTIONS_PER_COMMENT);

      // ── The daily cap is one budget: 10 from the comment, 10 from a solution's text, 9 more here. ──
      const viaSolution = (description: string, people: Person[]) =>
        store.createSolution(pool, zed, capped.num, { description, costVsBenefits: null, isAnonymous: false, mentions: { candidates: cand(...people), resolveRoles: f.resolveRoles } });
      assert.equal((await viaSolution(`With ${naming(ten)}.`, ten)).status, "ok");
      assert.equal(await f.sentToday(zed), 2 * MENTIONS_PER_COMMENT);
      assert.equal(await leftToday(zed), MENTIONS_PER_DAY - 2 * MENTIONS_PER_COMMENT, "a solution's mentions use up the same budget");
      await f.post(zed, cappedThread, `Again ${naming(nine)}.`, cand(...nine));
      assert.equal(await f.sentToday(zed), MENTIONS_PER_DAY - 1);
      assert.equal(await leftToday(zed), 1);
      // Two concurrent posts, each for the last place: exactly one takes it.
      const [raceA, raceB] = await Promise.all([
        f.postRaw(zed, cappedThread, `Race A: ${at(tenth)}.`, cand(tenth)),
        f.postRaw(zed, cappedThread, `Race B: ${at(eleventh)}.`, cand(eleventh)),
      ]);
      assert.deepEqual([raceA.status, raceB.status].sort(), ["mention_cap", "ok"], "the 30th of the day is allowed, the 31st refused");
      assert.deepEqual(raceA.status === "ok" ? raceB : raceA, { status: "mention_cap", reason: "daily_cap" });
      assert.equal(await f.sentToday(zed), MENTIONS_PER_DAY);
      assert.equal(await leftToday(zed), 0);
      // …and a solution save cannot take a 31st either.
      assert.deepEqual(await viaSolution(`One more: ${at(tenth)}.`, [tenth]), { status: "mention_cap", reason: "daily_cap" });
      // Yesterday's rows do not count. The app role cannot move created_at; the owner connection of
      // the throwaway database can.
      for (const table of ["solution_mentions", "comment_mentions"]) {
        const sql = `update ${table} set created_at = created_at - interval '1 day' where mentioned_by = $1`;
        await pool.query(sql, [zed.userId]).catch(async () => {
          const owner = new Pool({ connectionString: process.env.TEST_OWNER_DATABASE_URL });
          try {
            await owner.query(sql, [zed.userId]);
          } finally {
            await owner.end();
          }
        });
      }
      assert.equal(await f.sentToday(zed), 0);
      assert.equal(await leftToday(zed), MENTIONS_PER_DAY);
      assert.equal((await f.postRaw(zed, cappedThread, `A new day: ${at(tenth)}.`, cand(tenth))).status, "ok");

      // ── A removed comment: its notices go, its rows stay. ──
      const d1 = await f.post(ana, thread, `Soon gone, ${at(bob)} and ${at(cy)}.`, cand(bob, cy));
      // cy's e-mail has already left: a sent row is dispatch history.
      await pool.query(`update notification_outbox set status = 'sent', sent_at = now() where user_id = $1 and type = 'mentioned_in_comment' and payload->>'commentId' = $2`, [
        cy.userId,
        d1.comment.id,
      ]);
      const usedByAna = await f.sentToday(ana);
      assert.equal((await deleteComment(pool, ana, d1.comment.id)).status, "ok", "the owner, inside the window");
      for (const person of [bob, cy]) assert.equal((await f.inbox27(person, d1.comment.id)).length, 0, "its event-27 inbox rows go");
      assert.equal((await f.outbox27(bob, d1.comment.id)).length, 0, "…and its unsent e-mail");
      assert.deepEqual(
        (await f.outbox27(cy, d1.comment.id)).map((r) => r.status),
        ["sent"],
        "a sent one stays",
      );
      assert.equal((await f.rowsOf(d1.comment.id)).length, 2, "the mention rows stay");
      assert.equal(await f.sentToday(ana), usedByAna, "…so the caps stay honest");
      const d1Listed = (await listComments(pool, bob, "challenge", ch.id))!.comments.find((c) => c.id === d1.comment.id)!;
      assert.deepEqual([d1Listed.deleted, d1Listed.body, d1Listed.mentions], [true, "Comment removed by a moderator", []], "a removed comment shows its placeholder only");
      assert.equal(JSON.stringify(d1Listed).includes(bob.word), false, "…none of its text or mentions");
      const d2 = await f.post(ana, thread, `Moderated, ${at(bob)}.`, cand(bob));
      assert.equal((await f.inbox27(bob, d2.comment.id)).length, 1);
      assert.equal((await deleteComment(pool, nsAdmin, d2.comment.id)).status, "ok", "a moderator");
      assert.equal((await f.inbox27(bob, d2.comment.id)).length, 0);
      assert.equal((await f.outbox27(bob, d2.comment.id)).length, 0);
      assert.equal((await f.rowsOf(d2.comment.id)).length, 1);

      // ── Reading: opening the challenge reads its thread's mentions and its solutions'. ──
      const reader = await f.mkUser("reader");
      const open = await f.propose(ch.num, ana, "An idea everyone can see.");
      await f.move(committee, open, "in_review");
      await f.post(ana, thread, `On the challenge, ${at(reader)}.`, cand(reader));
      await f.post(ana, { type: "solution", id: open.id }, `On its solution, ${at(reader)}.`, cand(reader));
      const unread = await f.inbox27(reader);
      assert.equal(unread.length, 2);
      assert.ok(unread.every((r) => r.challenge_id === ch.id && r.read_at === null), "both rows are about this challenge, unread");
      assert.deepEqual(unread.map((r) => r.solution_id).sort(), [null, open.id].sort(), "one from its own thread, one from its solution's");
      await markCommentNotificationsReadForChallenge(pool, reader.userId, ch.id);
      assert.ok((await f.inbox27(reader)).every((r) => r.read_at !== null), "opening the challenge reads both");

      // The read-time gate: the row is kept, hidden while the recipient cannot see the challenge.
      const outsider = await f.mkUser("outsider", f.roles("member", f.otherNsId));
      const forOutsider = await f.post(ana, thread, `For ${at(outsider)}.`, cand(outsider));
      const link = `/challenges/${ch.num}#comment-${forOutsider.comment.id}`;
      const shown = async () => (await getInbox(pool, outsider)).notifications.filter((n) => n.link === link);
      assert.deepEqual(
        (await shown()).map((n) => [n.type, n.message]),
        [["mentioned_in_comment", commentMentionedMessage(ana.name, { challengeNumber: ch.num, solutionNumber: null, challengeTitle: ch.title })]],
      );
      assert.equal((await store.setChallengeVisibility(pool, nsAdmin, ch.num, "namespace")).status, "ok");
      assert.equal((await shown()).length, 0, "the gate hides it once the challenge is narrowed away from the recipient");
      assert.equal((await f.inbox27(outsider, forOutsider.comment.id)).length, 1, "…the row itself is kept");
      const narrowed = (await listComments(pool, ana, "challenge", ch.id))!.comments.find((c) => c.id === forOutsider.comment.id)!;
      assert.equal(narrowed.mentions[0]!.user?.id, outsider.userId, "…and their name stays in the comment");
      assert.equal((await store.setChallengeVisibility(pool, nsAdmin, ch.num, "org")).status, "ok");
      assert.equal((await shown()).length, 1, "it comes back with access");

      // ── Erasure: rows gone, sender nulled, text untouched, the name gone. ──
      const ghost = await f.mkUser("ghost");
      const sender = await f.mkUser("sender");
      const eve = await f.mkUser("eve");
      const forGhost = await f.post(ana, thread, `Erasure case: ${at(ghost)}.`, cand(ghost));
      const fromSender = await f.post(sender, thread, `From a sender: ${at(eve)}.`, cand(eve));
      const forGhostStored = await f.storedOf(forGhost.comment.id);
      assert.equal((await scrubUser(pool, platform.userId, ghost.userId)).status, "ok");
      assert.equal((await pool.query(`select 1 from comment_mentions where user_id = $1`, [ghost.userId])).rows.length, 0, "erasure deletes the rows that name the person");
      assert.equal(await f.storedOf(forGhost.comment.id), forGhostStored, "no comment is rewritten");
      const forGhostAfter = (await listComments(pool, bob, "challenge", ch.id))!.comments.find((c) => c.id === forGhost.comment.id)!;
      assert.equal(forGhostAfter.body, "Erasure case: @Deleted User.");
      assert.deepEqual(spans(forGhostAfter), [[null, "@Deleted User"]], "an erased person's mention names nobody");
      assert.equal(forGhostAfter.mentions[0]!.user, null);
      assert.deepEqual(await f.rowsOf(fromSender.comment.id), [{ user_id: eve.userId, mentioned_by: sender.userId }]);
      assert.equal((await scrubUser(pool, platform.userId, sender.userId)).status, "ok");
      assert.deepEqual(await f.rowsOf(fromSender.comment.id), [{ user_id: eve.userId, mentioned_by: null }], "the rows an erased commenter wrote lose their sender");

      // ── The §10.3 cascade removes the rows and the notices of every comment that goes. ──
      const doomed = await f.newChallenge("Doomed");
      const doomedSolution = await f.propose(doomed.num, ana, "A doomed idea.");
      await f.move(committee, doomedSolution, "in_review");
      const onChallenge = await f.post(ana, { type: "challenge", id: doomed.id }, `On the challenge: ${at(bob)}.`, cand(bob));
      const onSolution = await f.post(ana, { type: "solution", id: doomedSolution.id }, `On the solution: ${at(bob)}.`, cand(bob));
      for (const c of [onChallenge, onSolution]) {
        assert.equal((await f.rowsOf(c.comment.id)).length, 1);
        assert.equal((await f.inbox27(bob, c.comment.id)).length, 1);
        assert.equal((await f.outbox27(bob, c.comment.id)).length, 1);
      }
      const storage = { deleteObject: async () => {}, abortMultipartUpload: async () => {} };
      assert.equal((await deleteSolution({ pool, storage } as never, platform, doomedSolution.num, "dbtest cleanup")).status, "ok");
      assert.equal((await f.rowsOf(onSolution.comment.id)).length, 0, "a deleted solution's comment mentions go");
      assert.equal((await f.inbox27(bob, onSolution.comment.id)).length, 0, "…with their event-27 inbox rows");
      assert.equal((await f.outbox27(bob, onSolution.comment.id)).length, 0, "…and unsent e-mails");
      assert.equal((await f.rowsOf(onChallenge.comment.id)).length, 1, "its challenge's own thread is untouched");
      assert.equal((await f.inbox27(bob, onChallenge.comment.id)).length, 1);
      assert.equal((await deleteChallenge({ pool, storage } as never, platform, doomed.num, "dbtest cleanup")).status, "ok");
      assert.equal((await f.rowsOf(onChallenge.comment.id)).length, 0, "a deleted challenge's comment mentions go");
      assert.equal((await f.inbox27(bob, onChallenge.comment.id)).length, 0);
      assert.equal((await f.outbox27(bob, onChallenge.comment.id)).length, 0);

      // ── Agents: `post_comment` mentions nobody; `list_comments` returns display text. ──
      const forAgents = await f.newChallenge("Agents");
      const client = `Dbtest Client ${stamp}`;
      const toolCtx = (person: Person): ToolContext => ({
        pool,
        viewer: { userId: person.userId, roles: person.roles, orgVisibleOnly: true },
        principal: { userId: person.userId, grantId: randomUUID(), clientRowId: randomUUID(), clientName: client },
        settings: { ...DEFAULT_MCP_SETTINGS, enabled: true },
        baseUrl: "https://innobox.example.test",
        resolveRoles: f.resolveRoles,
      });
      const call = async (c: ToolContext, name: string, args: Record<string, unknown>) => {
        const tool = findTool(`innobox_${name}`);
        assert.ok(tool, name);
        return runTool(tool, c, args);
      };
      const fromWeb = `From the web, for ${at(bob)}.`;
      const fromAgent = `From an agent, for ${at(bob)}.`;
      const webComment = await f.post(ana, { type: "challenge", id: forAgents.id }, fromWeb, cand(bob));
      const posted = await call(toolCtx(ana), "post_comment", { parentType: "challenge", number: forAgents.num, body: fromAgent });
      assert.ok(posted.ok, posted.ok ? "" : `${posted.status} ${posted.message}`);
      if (!posted.ok) throw new Error("post_comment");
      const agentCommentId = String(posted.data.id);
      assert.equal(await f.storedOf(agentCommentId), fromAgent, "an @ in an agent's comment is plain text");
      assert.equal((await f.rowsOf(agentCommentId)).length, 0, "post_comment creates no mention");
      assert.equal((await f.inbox27(bob, agentCommentId)).length, 0);
      assert.equal((await f.inbox27(bob, webComment.comment.id)).length, 1);
      const listed = await call(toolCtx(bob), "list_comments", { parentType: "challenge", number: forAgents.num });
      assert.ok(listed.ok, listed.ok ? "" : `${listed.status} ${listed.message}`);
      if (!listed.ok) throw new Error("list_comments");
      const seen = listed.data.comments as Record<string, unknown>[];
      assert.deepEqual(
        seen.map((c) => c.body),
        [fromWeb, fromAgent],
        "list_comments returns display text",
      );
      assert.ok(seen.every((c) => !("mentions" in c)), "…and no mentions field");
      assertNoToken(listed, "list_comments");
    } finally {
      await pool.end();
    }
  },
);

test(
  'comment mentions: the discussion summary is sent "@colleague", never a name',
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomBytes } = await import("node:crypto");
    const { AI_STORED_MENTION } = await import("@innobox/shared");
    const { DISCUSSION_MIN_COMMENTS } = await import("@innobox/shared/ai");
    const support = await import("../ai/dbtest-support");
    const { summarize } = await import("../ai/summary/store");

    const pool = new Pool({ connectionString: url });
    const stub = await support.startProviderStub();
    try {
      const key = randomBytes(32);
      const ai = support.testAiClient(pool, key);
      await support.configureAi(pool, key, stub.baseUrl);
      await support.setSwitch(pool, "ai_discussion_summary_enabled", true);
      stub.reply(() => ({ text: JSON.stringify({ summary: "They agree on an owner.", openQuestions: [] }) }));

      const f = await fixtures(pool);
      const { at, cand } = f;
      const ana = await f.mkUser("ana");
      const bob = await f.mkUser("bob");
      const ch = await f.newChallenge("Summary");
      const thread: Thread = { type: "challenge", id: ch.id };
      const word = `quince${f.stamp}`;
      const mentioning = await f.postRaw(ana, thread, `**Agreed**: ${at(bob)} should own the ${word} rollout.`, cand(bob));
      assert.equal(mentioning.status, "ok");
      for (let i = 1; i < DISCUSSION_MIN_COMMENTS; i += 1) {
        assert.equal((await f.postRaw(i % 2 ? bob : ana, thread, `Remark ${i}.`)).status, "ok");
      }

      const out = await summarize(pool, ai, ana, "challenge", ch.num);
      assert.equal(out.status, "ok");
      const call = stub.calls.at(-1)!;
      // §44.7: the text as written — Markdown neither rendered nor stripped — each mention a placeholder.
      assert.ok(call.user.includes(`**Agreed**: ${AI_STORED_MENTION} should own the ${word} rollout.`), "the mention reaches the provider as a placeholder");
      for (const text of [call.user, call.system]) {
        assert.equal(text.includes(bob.name) || text.includes(bob.word), false, "the mentioned person's name never reaches the provider");
        assert.equal(text.includes(bob.userId), false, "…nor their id");
        assertNoToken(text, "the prompt");
      }
    } finally {
      await pool.query(`delete from ai_integration`).catch(() => {});
      await support.setSwitch(pool, "ai_discussion_summary_enabled", false).catch(() => {});
      await stub.close();
      await pool.end();
    }
  },
);
