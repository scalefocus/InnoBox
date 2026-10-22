// Notification dispatch (INNOBOX_SPEC.md §12.1): every event writes an in-app `notifications`
// row per recipient AND queues a `notification_outbox` row the worker sweeps for e-mail
// (§12). This module owns RECIPIENT computation (dedup, actor-exclusion via
// @innobox/shared's finalizeRecipients, and visibility-dropping, invariant 2) — callers own
// MESSAGE construction, since they already have the full challenge/solution context (a
// solution has no title of its own; only the caller knows whether to reference the parent
// challenge's). Messages must never leak an anonymous author's identity (§9) — callers pass
// already-masked display names.
//
// §12.1 e-mail digests: a follower-type event's outbox row is HELD for a recipient on a daily or
// weekly digest — written with `digest_due_at` = their next send slot and the facts the digest
// needs (payload.digest), plus the id of its inbox row (payload.notificationId) so the digest job
// can drop what was already read. The inbox row is written exactly as for everyone else.
import type { Pool, PoolClient } from "pg";
import {
  NOTIFICATION_PREFERENCE_COLUMN,
  applyPreferenceMute,
  commentNotificationMessage,
  finalizeRecipients,
  hypeEmailSubject,
  hypeNotificationMessage,
  isDigestableEvent,
  nextDigestSlot,
  sortTopicNames,
  TOPICS_PATH,
  topicNoticeFootnote,
  topicNoticeMessage,
  topicNoticeSubject,
  type ChallengeVisibility,
  type DigestCadence,
  type DigestFacts,
  type NotificationEventNumber,
  type NotificationPayload,
  type NotificationPreference,
  type NotificationTarget,
  type NotificationType,
  type TopicNoticeVia,
} from "@innobox/shared";
import { loadParentVisibility, parentAccessFor, type ParentVisibility, type Viewer } from "../app/api/challenges/store";
import { inTransaction } from "./db";

type Db = Pool | PoolClient;

/** Stamp the row's target (§10.3, §12.1) onto the payload. A payload that already names its own
 *  target keeps it — the one case is the "solution proposed" event, visible per its challenge
 *  but about the new solution. */
function withTarget(payload: NotificationPayload, target: NotificationTarget): NotificationPayload {
  return payload.parentType && payload.parentId ? payload : { ...payload, parentType: target.parentType, parentId: target.parentId };
}

/** §12.1 e-mail digests: which §12.1 event a dispatch is, who is on its admin route (an attention
 *  event — never held), and what the digest says about it. Absent = never held. */
export interface DigestHold {
  event: NotificationEventNumber;
  adminRoute?: string[];
  facts: DigestFacts;
}

/** The send slot of every recipient whose copy of this event is held for a digest: the event is
 *  digestable for them and they chose a daily or weekly digest. */
async function digestSlots(db: Db, userIds: string[], hold: DigestHold | undefined): Promise<Map<string, Date>> {
  if (!hold) return new Map();
  const adminRoute = new Set(hold.adminRoute ?? []);
  const eligible = userIds.filter((id) => isDigestableEvent(hold.event, adminRoute.has(id)));
  if (eligible.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; email_delivery: DigestCadence }>(
    `select id, email_delivery from users where id = any($1::uuid[]) and email_delivery <> 'immediate'`,
    [eligible],
  );
  const now = new Date();
  return new Map(rows.map((r) => [r.id, nextDigestSlot(r.email_delivery, now)]));
}

/** The outbox row's payload for one recipient: immediate, or held until `slot` with the digest's facts. */
function outboxPayload(payload: NotificationPayload, notificationId: string, slot: Date | undefined, hold: DigestHold | undefined): NotificationPayload {
  return { ...payload, notificationId, ...(slot && hold ? { digest: hold.facts } : {}) };
}

/** The outbox row for one recipient. */
async function writeOutbox(db: Db, userId: string, type: NotificationType, payload: NotificationPayload, notificationId: string, slot: Date | undefined, hold: DigestHold | undefined): Promise<void> {
  await db.query(`insert into notification_outbox (user_id, type, payload, digest_due_at) values ($1, $2, $3, $4)`, [
    userId,
    type,
    JSON.stringify(outboxPayload(payload, notificationId, slot, hold)),
    slot ?? null,
  ]);
}

/** The inbox row and the outbox row for every recipient — two multi-row inserts whatever the
 *  count, so an event's cost does not grow with its recipient list. `userIds` are distinct
 *  (finalizeRecipients dedupes), which is what keys each returned inbox id to its outbox row. */
async function writeNotifications(db: Db, userIds: string[], type: NotificationType, payload: NotificationPayload, hold?: DigestHold): Promise<void> {
  if (userIds.length === 0) return;
  const slots = await digestSlots(db, userIds, hold);
  const { rows } = await db.query<{ id: string; user_id: string }>(
    `insert into notifications (user_id, type, payload)
     select u, $2, $3 from unnest($1::uuid[]) as u
     returning id, user_id`,
    [userIds, type, JSON.stringify(payload)],
  );
  const inboxIds = new Map(rows.map((r) => [r.user_id, r.id]));
  await db.query(
    `insert into notification_outbox (user_id, type, payload, digest_due_at)
     select u, $2, p::jsonb, d from unnest($1::uuid[], $3::text[], $4::timestamptz[]) as t(u, p, d)`,
    [
      userIds,
      type,
      userIds.map((id) => JSON.stringify(outboxPayload(payload, inboxIds.get(id)!, slots.get(id), hold))),
      userIds.map((id) => slots.get(id)?.toISOString() ?? null),
    ],
  );
}

/** The namespace's admins plus every platform admin (§12.1 admin notifications), resolved from
 *  SCIM-synced membership + role_mappings (invariant 1) — active, not-erased users only (§12.1). */
export async function getNamespaceAdminUserIds(db: Db, namespaceId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
       join users u on u.id = gm.user_id and u.active and u.scrubbed_at is null
      where (rm.role = 'namespace_admin' and rm.namespace_id = $1) or rm.role = 'platform_admin'`,
    [namespaceId],
  );
  return rows.map((r) => r.user_id);
}

/** Every active platform admin, resolved the only way roles ever are (invariant 1): SCIM-synced
 *  group membership + role_mappings, plus the bootstrap group while it is configured. */
export async function getPlatformAdminUserIds(db: Db, bootstrapAdminGroup: string | undefined = process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
       join users u on u.id = gm.user_id and u.active and u.scrubbed_at is null
      where exists (select 1 from role_mappings rm where rm.group_external_id = g.external_id and rm.role = 'platform_admin')
         or ($1::text is not null and g.external_id = $1)`,
    [bootstrapAdminGroup || null],
  );
  return rows.map((r) => r.user_id);
}

/** An admin attention event about no single item (§12.1 event 14): the in-app row and the outbox
 *  row for each recipient, deduplicated — never muted, no visibility scope to check. */
export async function dispatchAdminAttention(db: Db, userIds: string[], type: NotificationType, payload: NotificationPayload): Promise<void> {
  await writeNotifications(db, finalizeRecipients(userIds, null), type, payload);
}

/** The namespace's committee (invariant 1) — active, not-erased users only (§12.1). */
export async function getNamespaceCommitteeUserIds(db: Db, namespaceId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
       join role_mappings rm on rm.group_external_id = g.external_id
       join users u on u.id = gm.user_id and u.active and u.scrubbed_at is null
      where rm.role = 'committee' and rm.namespace_id = $1`,
    [namespaceId],
  );
  return rows.map((r) => r.user_id);
}

export async function getFollowerUserIds(db: Db, parentType: "challenge" | "solution", parentId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `select user_id from follows where parent_type = $1 and parent_id = $2`,
    [parentType, parentId],
  );
  return rows.map((r) => r.user_id);
}

export async function getOtherCommenterUserIds(db: Db, parentType: "challenge" | "solution", parentId: string): Promise<string[]> {
  const { rows } = await db.query<{ author_id: string }>(
    `select distinct author_id from comments where parent_type = $1 and parent_id = $2`,
    [parentType, parentId],
  );
  return rows.map((r) => r.author_id);
}

export interface NotifyContext {
  pool: Pool;
  actorId: string | null;
  /** Resolves a user's RoleSet for the visibility check — injected so this module doesn't
   *  duplicate getSessionUser's role-resolution SQL for arbitrary (non-session) user ids. The web
   *  tier's resolveRolesForUser also carries `many`, the bulk form, which the fan-out uses to
   *  resolve every recipient in a fixed number of queries; without it, one call per recipient. */
  resolveRoles: ((userId: string) => Promise<Viewer["roles"]>) & {
    many?: (userIds: readonly string[]) => Promise<Map<string, Viewer["roles"]>>;
  };
}

/** Every recipient's RoleSet — in bulk when the resolver offers it, one call per user otherwise. */
async function resolveAllRoles(resolveRoles: NotifyContext["resolveRoles"], userIds: string[]): Promise<Map<string, Viewer["roles"]>> {
  if (resolveRoles.many) return resolveRoles.many(userIds);
  const roles = new Map<string, Viewer["roles"]>();
  for (const userId of userIds) roles.set(userId, await resolveRoles(userId));
  return roles;
}

/** §12.1 per-event preferences: which mutable event this dispatch is, and who it is a duty for
 *  (never filtered — admins/committee on a new solution, the assignee on a status change). */
export interface PreferenceMute {
  preference: NotificationPreference;
  exempt?: string[];
}

/** §12.1: of `userIds`, the ones who may receive anything at all — active and not erased. A
 *  deactivated leaver keeps their e-mail, group memberships and follows, so every other filter
 *  would still pass them; this one is what stops the inbox row and the outbox row. */
async function activeRecipients(db: Db, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and active and scrubbed_at is null`, [userIds]);
  const active = new Set(rows.map((r) => r.id));
  return userIds.filter((id) => active.has(id));
}

/** The recipients who switched this preference off. The column comes from a fixed map. */
async function optedOutOf(db: Db, preference: NotificationPreference, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const column = NOTIFICATION_PREFERENCE_COLUMN[preference];
  const { rows } = await db.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and not ${column}`, [userIds]);
  return new Set(rows.map((r) => r.id));
}

/**
 * Compute the final recipient list for an event (§12.1: actors never notify themselves,
 * recipients deduplicated, recipients outside the item's visibility dropped) and write both
 * the in-app notification and the outbox row for each. `candidates` is whatever raw
 * author/admin/committee/assignee/follower ids the caller gathered for this event. The row's
 * target is the visibility scope unless the payload names its own (`withTarget`). `digest` makes
 * a follower-type event holdable for recipients on a digest (§12.1).
 */
export async function dispatchEvent(
  ctx: NotifyContext,
  visibilityScope: { parentType: "challenge" | "solution"; parentId: string },
  candidates: readonly (string | null)[],
  type: NotificationType,
  payload: NotificationPayload,
  mute?: PreferenceMute,
  digest?: DigestHold,
): Promise<void> {
  const recipients = await finalRecipients(ctx, visibilityScope, candidates, mute);
  if (recipients.length === 0) return;
  await writeNotifications(ctx.pool, recipients, type, withTarget(payload, visibilityScope), digest);
}

/** Dedup + actor exclusion, then the §12.1 deactivated/erased drop, then the visibility drop
 *  (invariant 2), then the §12.1 preference mute — all row-level, at insert time: a dropped
 *  recipient gets neither the inbox row nor the outbox row, so there is nothing for the bell or
 *  the e-mail sweep to deliver. */
async function finalRecipients(
  ctx: NotifyContext,
  visibilityScope: { parentType: "challenge" | "solution"; parentId: string },
  candidates: readonly (string | null)[],
  mute?: PreferenceMute,
): Promise<string[]> {
  const deduped = await activeRecipients(ctx.pool, finalizeRecipients(candidates, ctx.actorId));
  if (deduped.length === 0) return [];
  // The item is read once and every recipient checked against it in memory, with all their
  // roles resolved together — a fixed number of queries, whatever the recipient count.
  const parent = await loadParentVisibility(ctx.pool, visibilityScope.parentType, visibilityScope.parentId);
  if (!parent) return [];
  const roles = await resolveAllRoles(ctx.resolveRoles, deduped);
  // `live` only: a trashed item (§10.4) notifies nobody, platform admins included.
  const visible = deduped.filter((userId) => parentAccessFor({ userId, roles: roles.get(userId)! }, parent) === "live");
  return mute ? applyPreferenceMute(visible, await optedOutOf(ctx.pool, mute.preference, visible), new Set(mute.exempt ?? [])) : visible;
}

// ── §12.1 event 6: coalesced comment notifications ──────────────────────────────────────

export interface CommentNotification {
  /** The item the comment was posted on — the coalescing key. */
  parentType: "challenge" | "solution";
  parentId: string;
  /** The challenge whose page shows it (itself, or a solution's parent) — opening it reads the row. */
  challengeId: string;
  challengeNumber: string; // "CH-412"
  challengeTitle: string;
  /** The commenter's display name. Comments are never anonymous (§9). */
  latestBy: string;
  link: string;
  /** §10.2: the author of the comment this one replies to (null on a top-level comment) — their
   *  row counts it in `repliesToYou`. */
  replyToAuthorId: string | null;
}

/** The refreshed message, rendered in SQL with the same text as `commentNotificationMessage` for
 *  count ≥ 2 (a dbtest pins the two together). `n` is the NEW count, `r` the NEW `repliesToYou`. */
const COALESCED_MESSAGE_SQL = (n: string, r: string, p: string) =>
  `format('%s new comments on %s "%s"%s — latest by %s.', ${n}, ${p}->>'challengeNumber', ${p}->>'challengeTitle',
          case when ${r} > 0 then format(', %s %s to you', ${r}, case when ${r} = 1 then 'reply' else 'replies' end) else '' end,
          ${p}->>'latestBy')`;

/**
 * Event 6 delivery: one UNREAD inbox row per recipient per item. The first comment inserts the
 * row and its outbox row (one e-mail); every further comment on the same item while that row is
 * unread refreshes it IN PLACE — count + 1, `repliesToYou` + 1 when the comment answers the
 * recipient's own (§10.2), latest commenter, created_at bumped so it re-sorts to
 * the top — through a single atomic upsert against the migration-0024 partial unique index, and
 * writes no outbox row, so the recipient is e-mailed at most once per item until they read it.
 * Once read, the next comment starts a fresh row (and a fresh e-mail). For a recipient on a digest
 * that outbox row is held (§12.1), and the digest reports the inbox row's count at send time.
 */
export async function dispatchCoalescedComment(
  ctx: NotifyContext,
  candidates: readonly (string | null)[],
  comment: CommentNotification,
  mute?: PreferenceMute,
): Promise<void> {
  const recipients = await finalRecipients(ctx, { parentType: comment.parentType, parentId: comment.parentId }, candidates, mute);
  const hold: DigestHold = {
    event: 6,
    facts: { kind: "comment", challengeNumber: comment.challengeNumber.replace(/\D/g, ""), challengeTitle: comment.challengeTitle },
  };
  const slots = await digestSlots(ctx.pool, recipients, hold);
  for (const userId of recipients) {
    const repliesToYou = userId === comment.replyToAuthorId ? 1 : 0;
    const payload = {
      message: commentNotificationMessage(1, comment.challengeNumber, comment.challengeTitle, comment.latestBy, repliesToYou),
      link: comment.link,
      parentType: comment.parentType,
      parentId: comment.parentId,
      challengeId: comment.challengeId,
      challengeNumber: comment.challengeNumber,
      challengeTitle: comment.challengeTitle,
      latestBy: comment.latestBy,
      latestAt: new Date().toISOString(),
      count: 1,
      repliesToYou,
    };
    const newCount = `(coalesce((notifications.payload->>'count')::int, 1) + 1)`;
    // Rows written before replies existed carry no repliesToYou: they count from 0.
    const newReplies = `(coalesce((notifications.payload->>'repliesToYou')::int, 0) + (excluded.payload->>'repliesToYou')::int)`;
    const { rows } = await ctx.pool.query<{ id: string; inserted: boolean }>(
      `insert into notifications (user_id, type, payload) values ($1, 'comment_posted', $2::jsonb)
       on conflict (user_id, (payload->>'parentType'), (payload->>'parentId'))
         where read_at is null and type = 'comment_posted'
       do update set
         payload = notifications.payload
           || jsonb_build_object(
                'count', ${newCount},
                'repliesToYou', ${newReplies},
                'latestBy', excluded.payload->>'latestBy',
                'latestAt', excluded.payload->>'latestAt',
                'challengeTitle', excluded.payload->>'challengeTitle',
                'message', ${COALESCED_MESSAGE_SQL(newCount, newReplies, "excluded.payload")}),
         created_at = now()
       returning id, (xmax = 0) as inserted`,
      [userId, JSON.stringify(payload)],
    );
    // A refresh preserves the delivery bookkeeping: the e-mail went out with the first comment.
    if (rows[0]?.inserted) {
      await writeOutbox(ctx.pool, userId, "comment_posted", payload, rows[0].id, slots.get(userId), hold);
    }
  }
}

/** §12.1 read action: opening a challenge's page reads the viewer's unread comment rows — and,
 *  since §26.6, their unread "hyped" rows, and since §34.5 their event-18 row — for the challenge
 *  itself AND its solutions (the page shows both). A solution row carries its challenge in
 *  `challenge_id` (§5, migration 0051), so one probe of the (user_id, challenge_id) unread index
 *  covers both. */
export async function markCommentNotificationsReadForChallenge(db: Db, userId: string, challengeId: string): Promise<void> {
  await db.query(
    `update notifications set read_at = now()
      where user_id = $1 and type in ('comment_posted', 'hyped', 'topic_challenge') and read_at is null and challenge_id = $2::uuid`,
    [userId, challengeId],
  );
}

// ── §12.1 event 18 / §34.5: a new challenge in a followed topic ──────────────────────────

/** One event-18 trigger, as the dispatch needs it. */
export interface TopicNotice {
  challenge: { id: string; number: string; title: string; namespaceSlug: string; /** Masked per §9. */ author: string };
  /** Each candidate follower → the names of the relevant topics they follow. */
  followers: ReadonlyMap<string, readonly string[]>;
  /** The challenge's authors — every member of its team (§39.12) — never recipients: event 3 already
   *  told them it is valid. */
  authorIds: readonly string[];
  via: Exclude<TopicNoticeVia, "shared">;
  /** "widened" only: the visibility before the change — whoever could already see it is skipped. */
  previousVisibility?: ChallengeVisibility;
}

/**
 * Event 18 delivery. Of the candidate followers, the actor and the authors are dropped, then the
 * deactivated and erased (§12.1), then everyone who cannot see the challenge now (invariant 2) —
 * and, for a widening, everyone who could see it before. The survivors' `topic_notices` markers
 * are written in the same transaction as their inbox and outbox rows, and only a person whose
 * marker is NEW gets a row: at most one notice per person per challenge, ever, however triggers
 * race. Nobody dropped is marked, so a later trigger can still reach them. Returns how many people
 * were told.
 */
export async function dispatchTopicNotices(ctx: NotifyContext, notice: TopicNotice): Promise<number> {
  const candidates = finalizeRecipients([...notice.followers.keys()], ctx.actorId).filter((id) => !notice.authorIds.includes(id));
  const active = await activeRecipients(ctx.pool, candidates);
  if (active.length === 0) return 0;
  const parent = await loadParentVisibility(ctx.pool, "challenge", notice.challenge.id);
  if (!parent || parent.parentType !== "challenge") return 0;
  const before: ParentVisibility | null = notice.previousVisibility
    ? { parentType: "challenge", row: { ...parent.row, visibility: notice.previousVisibility } }
    : null;
  const roles = await resolveAllRoles(ctx.resolveRoles, active);
  const recipients = active.filter((userId) => {
    const viewer = { userId, roles: roles.get(userId)! };
    if (parentAccessFor(viewer, parent) !== "live") return false;
    return before === null || parentAccessFor(viewer, before) !== "live";
  });
  if (recipients.length === 0) return 0;

  const { id, number, title } = notice.challenge;
  return inTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query<{ user_id: string }>(
      `insert into topic_notices (challenge_id, user_id, via)
       select $1, u, $3 from unnest($2::uuid[]) as u
       on conflict do nothing
       returning user_id`,
      [id, recipients, notice.via],
    );
    // One message per distinct set of followed topics, so each group is one multi-row write.
    const groups = new Map<string, { topics: string[]; userIds: string[] }>();
    for (const { user_id } of rows) {
      const topics = sortTopicNames(notice.followers.get(user_id) ?? []);
      const key = topics.join("\u0000");
      const group = groups.get(key) ?? { topics, userIds: [] };
      group.userIds.push(user_id);
      groups.set(key, group);
    }
    for (const { topics, userIds } of groups.values()) {
      const payload: NotificationPayload = {
        message: topicNoticeMessage({ topics, number, title }),
        subject: topicNoticeSubject(topics, number),
        // The e-mail's second line and closing note (the worker's composeOutboxEmail).
        emailDetail: `In /${notice.challenge.namespaceSlug} · submitted by ${notice.challenge.author}`,
        footnote: { text: topicNoticeFootnote(topics), link: TOPICS_PATH },
        link: `/challenges/${number}`,
        parentType: "challenge",
        parentId: id,
        topics,
      };
      await writeNotifications(client, userIds, "topic_challenge", payload, {
        event: 18,
        facts: { kind: "topic", challengeNumber: number, challengeTitle: title, topics },
      });
    }
    return rows.length;
  });
}

// ── §12.1 event 16 / §26.6: coalesced "hyped" notifications ─────────────────────────────

export interface HypeNotification {
  /** The hyped item — the coalescing key. */
  parentType: "challenge" | "solution";
  parentId: string;
  /** The challenge whose page shows it — opening it reads the row. */
  challengeId: string;
  itemNumber: string; // "CH-412" / "SOL-34"
  /** `challenge CH-412 "Title"` / `solution SOL-34 on CH-412 "Title"`. */
  itemLabel: string;
  /** The hyper's display name — hypers are public (§26 decision 8). */
  latestBy: string;
  /** The item's hype points after this hype. */
  hype: number;
  link: string;
  /** For the digest line: the parent challenge, and the solution when the item is one. */
  challengeNumber: string;
  challengeTitle: string;
  solutionNumber: string | null;
}

/** The count ≥ 2 message, rendered in SQL with the same text as `hypeNotificationMessage`. */
const HYPED_MESSAGE_SQL = (n: string, p: string) => `format('%s people hyped your %s — latest %s.', ${n}, ${p}->>'itemLabel', ${p}->>'latestBy')`;

/**
 * Event 16 delivery: one UNREAD inbox row per recipient per item, refreshed in place by every
 * further hype while unread (the 0050 partial unique index), with ONE outbox row — the e-mail
 * goes out with the first hype and is not re-sent until the row is read (§26.6). The recipients are
 * the item's authors only — every member of its team (§39.8); the usual drops apply (the actor, a
 * deactivated or erased author, an item they can no longer see). No per-event preference: the
 * e-mail switch and digest choice are the controls, and the outbox row is held for a recipient on a
 * digest.
 */
export async function dispatchCoalescedHype(ctx: NotifyContext, authorIds: readonly string[], hype: HypeNotification): Promise<void> {
  const recipients = await finalRecipients(ctx, { parentType: hype.parentType, parentId: hype.parentId }, authorIds);
  const hold: DigestHold = {
    event: 16,
    facts: {
      kind: "hype",
      challengeNumber: hype.challengeNumber.replace(/\D/g, ""),
      challengeTitle: hype.challengeTitle,
      solutionNumber: hype.solutionNumber ? hype.solutionNumber.replace(/\D/g, "") : null,
    },
  };
  const slots = await digestSlots(ctx.pool, recipients, hold);
  for (const userId of recipients) {
    const payload = {
      message: hypeNotificationMessage(1, hype.itemLabel, hype.latestBy, hype.hype),
      subject: hypeEmailSubject(hype.latestBy, hype.parentType, hype.itemNumber),
      link: hype.link,
      parentType: hype.parentType,
      parentId: hype.parentId,
      challengeId: hype.challengeId,
      itemLabel: hype.itemLabel,
      latestBy: hype.latestBy,
      latestAt: new Date().toISOString(),
      count: 1,
    };
    const newCount = `(coalesce((notifications.payload->>'count')::int, 1) + 1)`;
    const { rows } = await ctx.pool.query<{ id: string; inserted: boolean }>(
      `insert into notifications (user_id, type, payload) values ($1, 'hyped', $2::jsonb)
       on conflict (user_id, (payload->>'parentType'), (payload->>'parentId'))
         where read_at is null and type = 'hyped'
       do update set
         payload = notifications.payload
           || jsonb_build_object(
                'count', ${newCount},
                'latestBy', excluded.payload->>'latestBy',
                'latestAt', excluded.payload->>'latestAt',
                'itemLabel', excluded.payload->>'itemLabel',
                'message', ${HYPED_MESSAGE_SQL(newCount, "excluded.payload")}),
         created_at = now()
       returning id, (xmax = 0) as inserted`,
      [userId, JSON.stringify(payload)],
    );
    // A refresh preserves the delivery bookkeeping: the e-mail went out with the first hype.
    if (rows[0]?.inserted) {
      await writeOutbox(ctx.pool, userId, "hyped", payload, rows[0].id, slots.get(userId), hold);
    }
  }
}

/**
 * §12.1 event 21 (§39.8): the one person another member added to or removed from an item's team. An
 * add passes the visibility check by construction (§39.2) and a removal is delivered directly — the
 * person could see the item a moment ago — so no visibility drop; the actor, a deactivated and an
 * erased recipient are dropped (§12.1). Immediate and never digested. The daily e-mail cap: only the
 * first event-21 row about this item for this person since UTC midnight gets an outbox row; later
 * ones that day are in-app only, like event 13. Returns whether an e-mail was queued.
 */
export async function dispatchTeamChange(ctx: NotifyContext, userId: string, payload: NotificationPayload, target: NotificationTarget): Promise<boolean> {
  if (userId === ctx.actorId) return false;
  if ((await activeRecipients(ctx.pool, [userId])).length === 0) return false;
  return inTransaction(ctx.pool, async (client) => {
    // One recipient at a time per item: two changes racing for "the first today" serialize here.
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`coauthor_changed:${userId}:${target.parentId}`]);
    const itemColumn = target.parentType === "challenge" ? "challenge_id" : "solution_id";
    const solutionClause = target.parentType === "challenge" ? " and solution_id is null" : "";
    const { rows: earlier } = await client.query(
      `select 1 from notifications
        where user_id = $1 and type = 'coauthor_changed' and ${itemColumn} = $2::uuid${solutionClause}
          and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
        limit 1`,
      [userId, target.parentId],
    );
    const full = withTarget(payload, target);
    const { rows } = await client.query<{ id: string }>(`insert into notifications (user_id, type, payload) values ($1, 'coauthor_changed', $2) returning id`, [
      userId,
      JSON.stringify(full),
    ]);
    if (earlier.length > 0) return false;
    await writeOutbox(client, userId, "coauthor_changed", full, rows[0]!.id, undefined, undefined);
    return true;
  });
}

/** Single-recipient events (assignment) skip the visibility check — the assignee is, by
 *  definition, someone the admin just granted per-item powers to (§4.2). `target` is the item
 *  the row is about (§10.3), or null for an event about no single item (the event-12 summary). */
export async function dispatchToUser(
  ctx: NotifyContext,
  userId: string,
  type: NotificationType,
  payload: NotificationPayload,
  target: NotificationTarget | null,
): Promise<void> {
  if (userId === ctx.actorId) return;
  await writeNotifications(ctx.pool, [userId], type, target ? withTarget(payload, target) : payload);
}
