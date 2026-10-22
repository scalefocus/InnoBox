// The database half of feature ideas (INNOBOX_SPEC.md §38) that the web stores share: the proposals
// switch, the audience test against resolved roles, and the two notifications — event 19 (a proposal
// was reviewed) and event 20 (a planned entry is now available, §38.8), which the web tier writes when
// an admin deletes a planned entry as shipped. Server-only. Authorization is the caller's job.
//
// Neither event names a challenge or a solution: the payload carries no parentType/parentId and its
// link points at What's new or the profile, so the 0051 trigger leaves both item columns null and
// the §12.1 read-time gates pass the rows through.
import { nextDigestSlot, type DigestCadence, type DigestFacts } from "./email-digest.js";
import type { DbClient } from "./email-graph.js";
import {
  featureAvailableCandidates,
  featureAvailableNotification,
  ideaReviewedNotification,
  type EntryAudience,
  type IdeaNotification,
  type ReviewOutcome,
} from "./feature-ideas.js";

export const FEATURE_IDEAS_ENABLED_KEY = "feature_ideas_enabled";
export const FEATURE_IDEA_REVIEWED_TYPE = "feature_idea_reviewed";
export const FEATURE_AVAILABLE_TYPE = "feature_available";

/** §38.11: whether people who are not platform admins may propose — on unless the stored value is
 *  exactly `false` (the migration seeds `true`). Nothing else reads it: the list, votes and review
 *  always work. */
export async function getFeatureIdeasEnabled(db: DbClient): Promise<boolean> {
  const { rows } = await db.query<{ value: unknown }>(`select value from platform_settings where key = $1`, [FEATURE_IDEAS_ENABLED_KEY]);
  return rows[0]?.value !== false;
}

/**
 * Of `userIds`, the ones an entry with `audience` applies to (§13.9 `appliesTo`), resolved the only
 * way roles ever are (invariant 1): SCIM-synced group membership + role_mappings, plus the
 * bootstrap group while it is configured.
 */
export async function audienceMembers(db: DbClient, userIds: readonly string[], audience: EntryAudience, bootstrapAdminGroup: string | undefined): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  if (audience === "everyone") return new Set(userIds);
  const roles = audience === "platform_admin" ? ["platform_admin"] : ["platform_admin", "namespace_admin"];
  const { rows } = await db.query<{ user_id: string }>(
    `select distinct gm.user_id
       from group_members gm
       join groups g on g.id = gm.group_id
      where gm.user_id = any($1::uuid[])
        and (exists (select 1 from role_mappings rm where rm.group_external_id = g.external_id and rm.role = any($2::text[]))
             or ($3::text is not null and g.external_id = $3))`,
    [[...userIds], roles, bootstrapAdminGroup || null],
  );
  return new Set(rows.map((r) => r.user_id));
}

/** Of `userIds`, the active, not-erased ones — the only people who may receive anything (§12.1). */
async function activeOf(db: DbClient, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const { rows } = await db.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and active and scrubbed_at is null`, [[...userIds]]);
  return new Set(rows.map((r) => r.id));
}

/** One inbox row and its outbox row. `digest` holds the e-mail until the recipient's next slot. */
async function writeOne(db: DbClient, userId: string, type: string, note: IdeaNotification, digest: { slot: Date; facts: DigestFacts } | null): Promise<void> {
  const payload = { message: note.message, link: note.link, subject: note.subject, emailText: note.emailText };
  const { rows } = await db.query<{ id: string }>(`insert into notifications (user_id, type, payload) values ($1, $2, $3::jsonb) returning id`, [
    userId,
    type,
    JSON.stringify(payload),
  ]);
  await db.query(`insert into notification_outbox (user_id, type, payload, digest_due_at) values ($1, $2, $3::jsonb, $4)`, [
    userId,
    type,
    JSON.stringify({ ...payload, notificationId: rows[0]!.id, ...(digest ? { digest: digest.facts } : {}) }),
    digest?.slot ?? null,
  ]);
}

export interface IdeaReviewedInput {
  proposerId: string;
  actorId: string | null;
  outcome: ReviewOutcome;
  title?: string | null;
  teaser?: string | null;
  text: string;
  note?: string | null;
}

/** §12.1 event 19: the proposer only, immediate and never digested. Nothing for an inactive or
 *  erased proposer, or when the deciding admin is the proposer. Returns whether a row was written. */
export async function deliverIdeaReviewed(db: DbClient, input: IdeaReviewedInput): Promise<boolean> {
  if (input.proposerId === input.actorId) return false;
  if (!(await activeOf(db, [input.proposerId])).has(input.proposerId)) return false;
  await writeOne(db, input.proposerId, FEATURE_IDEA_REVIEWED_TYPE, ideaReviewedNotification(input.outcome, input), null);
  return true;
}

export interface FeatureAvailableInput {
  title: string;
  /** The entry's proposer; null for an entry without one (§38.2). */
  proposerId: string | null;
  voterIds: readonly string[];
  audience: EntryAudience;
  actorId: string | null;
  bootstrapAdminGroup: string | undefined;
}

/**
 * §12.1 event 20: the proposer and every voter, deduplicated, to whom the entry still applies, minus
 * the actor and anyone inactive or erased. A follower-type event: held for a recipient on a daily or
 * weekly digest (one line per feature there). Returns how many people were notified.
 */
export async function deliverFeatureAvailable(db: DbClient, input: FeatureAvailableInput): Promise<number> {
  const candidates = featureAvailableCandidates(input.proposerId, input.voterIds, input.actorId);
  if (candidates.length === 0) return 0;
  const ids = candidates.map((c) => c.userId);
  const [active, inAudience] = await Promise.all([activeOf(db, ids), audienceMembers(db, ids, input.audience, input.bootstrapAdminGroup)]);
  const recipients = candidates.filter((c) => active.has(c.userId) && inAudience.has(c.userId));
  if (recipients.length === 0) return 0;

  const { rows } = await db.query<{ id: string; email_delivery: DigestCadence }>(
    `select id, email_delivery from users where id = any($1::uuid[]) and email_delivery <> 'immediate'`,
    [recipients.map((r) => r.userId)],
  );
  const now = new Date();
  const slots = new Map(rows.map((r) => [r.id, nextDigestSlot(r.email_delivery, now)]));
  const facts: DigestFacts = { kind: "feature", challengeNumber: "", challengeTitle: "", featureTitle: input.title };
  for (const r of recipients) {
    const slot = slots.get(r.userId);
    await writeOne(db, r.userId, FEATURE_AVAILABLE_TYPE, featureAvailableNotification(input.title, r.relation), slot ? { slot, facts } : null);
  }
  return recipients.length;
}
