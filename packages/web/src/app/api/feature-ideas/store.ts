// Data layer for §38 feature ideas (INNOBOX_SPEC.md §38): the Coming soon read with its votes,
// voters and proposers (GET /api/coming-soon), the vote toggle, proposing, the proposer's own list
// and withdraw, and the platform admin's review — list, count, approve, decline, merge, edit and
// delete. The pure rules (limits, validation, order, voter split, copy) live in @innobox/shared
// (feature-ideas.ts); the switch, the audience test and events 19–20 in feature-ideas-db.ts, which
// the worker shares.
//
// Visibility (invariant 2): ideas carry no namespace, and every entry is filtered by its audience
// against the viewer's resolved roles before anything about it — a count, a voter, a proposer — is
// returned. The raw proposal text is returned only to its author and to platform admins.
// Names (§38.6): a proposer or voter is named only while their name switch is on and they are not
// erased — read live, never copied onto a row.
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool, PoolClient } from "pg";
import {
  MAX_PENDING_IDEAS,
  PENDING_ROW_EXCERPT_MAX,
  UPCOMING,
  appliesTo,
  audienceMembers,
  compareEntries,
  deliverFeatureAvailable,
  deliverIdeaReviewed,
  entryIdOf,
  ideaEntryId,
  ideaExcerpt,
  specEntryId,
  splitVoters,
  upcomingByKey,
  upcomingFor,
  upcomingViewerOf,
  type EntryRef,
  type FeatureIdeaStatus,
  type PublishedCopy,
  type RoleSet,
  type UpcomingAudience,
  type UpcomingEntry,
  type VoteRow,
  type VoterList,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { awardIdeaApproved, awardIdeaShipped } from "../../../lib/gamification";

type Db = Pool | PoolClient;

export interface IdeaViewer {
  userId: string;
  roles: RoleSet;
}

/** A named person on an entry: a voter or the proposer. */
export interface NamedPerson {
  id: string;
  displayName: string;
  deactivated: boolean;
}

/** One Coming soon entry while feature ideas are on (§38.14). */
export interface ComingSoonEntry extends VoterList {
  id: string;
  kind: "spec" | "idea";
  title: string;
  teaser: string;
  proposedBy: NamedPerson | null;
}

/** While feature ideas are off: the specified teasers alone, read-only (§38.11). */
export interface ComingSoonTeaser {
  id: string;
  kind: "spec";
  title: string;
  teaser: string;
}

export type ComingSoon =
  | { enabled: true; entries: ComingSoonEntry[]; myPendingCount: number; maxPending: number; /** The viewer's §38.6 switch — the propose dialog's sub-line. */ named: boolean }
  | { enabled: false; entries: ComingSoonTeaser[] };

const bootstrapGroup = (): string | undefined => process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP;

/** The audiences an entry may have to reach this viewer (§13.9 `appliesTo`). */
function audiencesFor(roles: RoleSet): UpcomingAudience[] {
  const viewer = upcomingViewerOf(roles);
  return (["everyone", "admins", "platform_admin"] as const).filter((a) => appliesTo(a, viewer));
}

// ── Votes ────────────────────────────────────────────────────────────────────────────────

/** Every vote on the given entries, newest first, grouped by entry id. */
async function loadVotes(db: Db, specKeys: readonly string[], ideaIds: readonly string[]): Promise<Map<string, VoteRow[]>> {
  const out = new Map<string, VoteRow[]>();
  if (specKeys.length === 0 && ideaIds.length === 0) return out;
  const { rows } = await db.query<{ spec_key: string | null; idea_id: string | null; user_id: string; display_name: string; deactivated: boolean; named: boolean }>(
    `select v.spec_key, v.idea_id, v.user_id, u.display_name, not u.active as deactivated,
            (u.feature_ideas_named and u.scrubbed_at is null) as named
       from feature_idea_votes v join users u on u.id = v.user_id
      where v.spec_key = any($1::text[]) or v.idea_id = any($2::uuid[])
      order by v.created_at desc, v.user_id`,
    [[...specKeys], [...ideaIds]],
  );
  for (const r of rows) {
    const id = r.spec_key !== null ? specEntryId(r.spec_key) : ideaEntryId(r.idea_id!);
    const list = out.get(id) ?? [];
    list.push({ userId: r.user_id, displayName: r.display_name, deactivated: r.deactivated, named: r.named });
    out.set(id, list);
  }
  return out;
}

async function entryVoters(db: Db, ref: EntryRef, viewerId: string): Promise<VoterList> {
  const votes = await loadVotes(db, ref.kind === "spec" ? [ref.key] : [], ref.kind === "idea" ? [ref.id] : []);
  return splitVoters(votes.get(entryIdOf(ref)) ?? [], viewerId);
}

// ── The Coming soon read (GET /api/coming-soon) ──────────────────────────────────────────

/**
 * The entries that apply to the viewer, in the §38.2 order, each with its votes, the viewer's own
 * vote, the named voters and the proposer. While feature ideas are off, the specified teasers alone
 * in hand order. `entries` is UPCOMING outside tests.
 */
export async function getComingSoon(db: Db, viewer: IdeaViewer, enabled: boolean, entries: readonly UpcomingEntry[] = UPCOMING): Promise<ComingSoon> {
  const specs = upcomingFor(upcomingViewerOf(viewer.roles), entries);
  if (!enabled) return { enabled: false, entries: specs.map((e) => ({ id: specEntryId(e.key), kind: "spec", title: e.title, teaser: e.teaser })) };

  const { rows: ideas } = await db.query<{
    id: string;
    title: string;
    teaser: string;
    decided_at: Date;
    author_id: string;
    display_name: string;
    deactivated: boolean;
    named: boolean;
  }>(
    `select f.id, f.title, f.teaser, f.decided_at, f.author_id, u.display_name, not u.active as deactivated,
            (u.feature_ideas_named and u.scrubbed_at is null) as named
       from feature_ideas f join users u on u.id = f.author_id
      where f.status = 'planned' and f.audience = any($1::text[])`,
    [audiencesFor(viewer.roles)],
  );
  const votes = await loadVotes(
    db,
    specs.map((e) => e.key),
    ideas.map((i) => i.id),
  );
  const index = new Map(entries.map((e, i) => [e.key, i]));
  const rows = [
    ...specs.map((e) => {
      const id = specEntryId(e.key);
      return {
        order: { kind: "spec" as const, votes: votes.get(id)?.length ?? 0, specIndex: index.get(e.key) ?? 0 },
        entry: { id, kind: "spec" as const, title: e.title, teaser: e.teaser, proposedBy: null, ...splitVoters(votes.get(id) ?? [], viewer.userId) },
      };
    }),
    ...ideas.map((i) => {
      const id = ideaEntryId(i.id);
      return {
        order: { kind: "idea" as const, votes: votes.get(id)?.length ?? 0, approvedAt: i.decided_at.toISOString() },
        entry: {
          id,
          kind: "idea" as const,
          title: i.title,
          teaser: i.teaser,
          proposedBy: i.named ? { id: i.author_id, displayName: i.display_name, deactivated: i.deactivated } : null,
          ...splitVoters(votes.get(id) ?? [], viewer.userId),
        },
      };
    }),
  ].sort((a, b) => compareEntries(a.order, b.order));
  const [myPendingCount, named] = await Promise.all([pendingCount(db, viewer.userId), getFeatureIdeasNamed(db, viewer.userId)]);
  return { enabled: true, entries: rows.map((r) => r.entry), myPendingCount, maxPending: MAX_PENDING_IDEAS, named };
}

/** The §38.6 name switch. */
export async function getFeatureIdeasNamed(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ feature_ideas_named: boolean }>(`select feature_ideas_named from users where id = $1`, [userId]);
  return rows[0]?.feature_ideas_named ?? true;
}

/** Silent (not audited, like every profile preference) and immediate: read live on every render. */
export async function setFeatureIdeasNamed(db: Db, userId: string, named: boolean): Promise<void> {
  await db.query(`update users set feature_ideas_named = $2, updated_at = now() where id = $1`, [userId, named]);
}

async function pendingCount(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from feature_ideas where author_id = $1 and status = 'pending'`, [userId]);
  return rows[0]?.n ?? 0;
}

// ── The vote toggle (POST /api/coming-soon/votes) ────────────────────────────────────────

export type ToggleVoteResult = ({ status: "ok" } & VoterList) | { status: "not_found" };

/**
 * One click: removes the viewer's vote on the entry if there is one, adds it otherwise — in one
 * transaction under a per-(person, entry) advisory lock, so a double click is two toggles in order,
 * never two rows. 404 for an entry that is not live or does not apply to the viewer: a retired
 * teaser key, an idea that is not planned, an audience the viewer is outside of.
 */
export async function toggleVote(pool: Pool, viewer: IdeaViewer, ref: EntryRef, entries: readonly UpcomingEntry[] = UPCOMING): Promise<ToggleVoteResult> {
  const audience = upcomingViewerOf(viewer.roles);
  const entryId = entryIdOf(ref);
  return inTransaction(pool, async (client) => {
    if (ref.kind === "spec") {
      const entry = upcomingByKey(ref.key, entries);
      if (!entry || !appliesTo(entry.audience, audience)) return { status: "not_found" } as const;
    } else {
      // FOR SHARE: a concurrent delete or edit waits, so a vote never lands on a vanishing idea.
      const { rows } = await client.query<{ audience: UpcomingAudience }>(`select audience from feature_ideas where id = $1 and status = 'planned' for share`, [ref.id]);
      if (!rows[0] || !appliesTo(rows[0].audience, audience)) return { status: "not_found" } as const;
    }
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`feature-vote:${viewer.userId}:${entryId}`]);
    const removed = await client.query(
      ref.kind === "spec"
        ? `delete from feature_idea_votes where user_id = $1 and spec_key = $2`
        : `delete from feature_idea_votes where user_id = $1 and idea_id = $2::uuid`,
      [viewer.userId, ref.kind === "spec" ? ref.key : ref.id],
    );
    const voted = (removed.rowCount ?? 0) === 0;
    if (voted) {
      await client.query(
        ref.kind === "spec"
          ? `insert into feature_idea_votes (user_id, spec_key) values ($1, $2) on conflict do nothing`
          : `insert into feature_idea_votes (user_id, idea_id) values ($1, $2::uuid) on conflict do nothing`,
        [viewer.userId, ref.kind === "spec" ? ref.key : ref.id],
      );
    }
    await appendAudit(client, { actorUserId: viewer.userId, action: voted ? "feature_idea.voted" : "feature_idea.unvoted", targetType: "coming_soon_entry", targetId: entryId });
    return { status: "ok", ...(await entryVoters(client, ref, viewer.userId)) } as const;
  });
}

// ── Proposing (POST /api/feature-ideas) ──────────────────────────────────────────────────

export type ProposeResult = { status: "ok"; id: string } | { status: "too_many_pending" };

/** A new pending proposal. The pending cap is re-checked under a per-person advisory lock, so two
 *  tabs can never both slip under it. Audited without its text (§38.14). */
export async function proposeIdea(pool: Pool, userId: string, text: string): Promise<ProposeResult> {
  return inTransaction(pool, async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`feature-idea:${userId}`]);
    if ((await pendingCount(client, userId)) >= MAX_PENDING_IDEAS) return { status: "too_many_pending" } as const;
    const { rows } = await client.query<{ id: string }>(`insert into feature_ideas (author_id, description) values ($1, $2) returning id`, [userId, text]);
    const id = rows[0]!.id;
    await appendAudit(client, { actorUserId: userId, action: "feature_idea.proposed", targetType: "feature_idea", targetId: id });
    return { status: "ok", id } as const;
  });
}

// ── The proposer's own list (§38.7) ──────────────────────────────────────────────────────

export interface OwnIdea {
  id: string;
  status: FeatureIdeaStatus;
  createdAt: string;
  description: string | null;
  /** Planned: the published title and its votes. */
  title: string | null;
  votes: number | null;
  /** Declined: the admin's note. */
  decisionNote: string | null;
  /** Merged: the entry it was merged into, while that is still planned; null once it is gone. */
  mergedTitle: string | null;
}

/** A live Coming soon entry's copy — a teaser still in UPCOMING, or a planned idea (read FOR SHARE
 *  when `lock`, so a merge can rely on it until commit). */
async function liveEntryTitle(
  db: Db,
  entryId: string | null,
  entries: readonly UpcomingEntry[],
  lock = false,
): Promise<{ title: string; teaser: string; audience: UpcomingAudience } | null> {
  if (!entryId) return null;
  if (entryId.startsWith("spec:")) {
    const entry = upcomingByKey(entryId.slice("spec:".length), entries);
    return entry ? { title: entry.title, teaser: entry.teaser, audience: entry.audience } : null;
  }
  const id = entryId.slice("idea:".length);
  const { rows } = await db.query<{ title: string; teaser: string; audience: UpcomingAudience }>(
    `select title, teaser, audience from feature_ideas where id = $1::uuid and status = 'planned'${lock ? " for share" : ""}`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listOwnIdeas(db: Db, userId: string, entries: readonly UpcomingEntry[] = UPCOMING): Promise<OwnIdea[]> {
  const { rows } = await db.query<{
    id: string;
    status: FeatureIdeaStatus;
    created_at: Date;
    description: string | null;
    title: string | null;
    decision_note: string | null;
    merged_into: string | null;
    votes: number;
  }>(
    `select f.id, f.status, f.created_at, f.description, f.title, f.decision_note, f.merged_into,
            (select count(*)::int from feature_idea_votes v where v.idea_id = f.id) as votes
       from feature_ideas f
      where f.author_id = $1
      order by f.created_at desc, f.id`,
    [userId],
  );
  const out: OwnIdea[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      description: r.description,
      title: r.status === "planned" ? r.title : null,
      votes: r.status === "planned" ? r.votes : null,
      decisionNote: r.status === "declined" ? r.decision_note : null,
      mergedTitle: r.status === "merged" ? ((await liveEntryTitle(db, r.merged_into, entries))?.title ?? null) : null,
    });
  }
  return out;
}

export type WithdrawResult = { status: "ok" } | { status: "not_found" } | { status: "conflict" };

/** Deletes one of the person's own PENDING proposals; 409 once it was decided, 404 for anyone else's. */
export async function withdrawIdea(pool: Pool, userId: string, id: string): Promise<WithdrawResult> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(`delete from feature_ideas where id = $1 and author_id = $2 and status = 'pending' returning id`, [id, userId]);
    if (rows.length === 0) {
      const { rows: mine } = await client.query(`select 1 from feature_ideas where id = $1 and author_id = $2`, [id, userId]);
      return { status: mine.length > 0 ? "conflict" : "not_found" } as const;
    }
    await appendAudit(client, { actorUserId: userId, action: "feature_idea.withdrawn", targetType: "feature_idea", targetId: id });
    return { status: "ok" } as const;
  });
}

// ── The review page (platform admin, §38.5) ──────────────────────────────────────────────

export type AdminTab = "pending" | "planned" | "decided";

export interface AdminPerson {
  id: string;
  displayName: string;
  deactivated: boolean;
  scrubbed: boolean;
  /** The §38.6 switch, so the Planned tab can say the name is hidden on What's new. */
  named: boolean;
}

export interface AdminIdeaRow {
  id: string;
  status: FeatureIdeaStatus;
  createdAt: string;
  description: string | null;
  excerpt: string;
  proposer: AdminPerson;
  /** Pending: the widest audience the proposer belongs to — a merge target outside it is disabled. */
  proposerScope: UpcomingAudience | null;
  title: string | null;
  teaser: string | null;
  audience: UpcomingAudience | null;
  votes: number;
  decisionNote: string | null;
  mergedInto: string | null;
  mergedTitle: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

/** A Coming soon entry a pending proposal can be merged into. */
export interface MergeTarget {
  id: string;
  kind: "spec" | "idea";
  title: string;
  audience: UpcomingAudience;
}

export interface AdminIdeaList {
  ideas: AdminIdeaRow[];
  /** Pending tab only: every live entry, every audience. */
  targets: MergeTarget[];
}

/** The widest audience that still includes each user: platform_admin ⊂ admins ⊂ everyone. */
async function scopesOf(db: Db, userIds: readonly string[]): Promise<Map<string, UpcomingAudience>> {
  const [platform, admins] = await Promise.all([
    audienceMembers(db, userIds, "platform_admin", bootstrapGroup()),
    audienceMembers(db, userIds, "admins", bootstrapGroup()),
  ]);
  return new Map(userIds.map((id) => [id, platform.has(id) ? "platform_admin" : admins.has(id) ? "admins" : "everyone"]));
}

/** True when an entry with `audience` reaches someone whose widest audience is `scope`. */
export function audienceIncludesScope(audience: UpcomingAudience, scope: UpcomingAudience): boolean {
  if (audience === "everyone") return true;
  if (audience === "admins") return scope !== "everyone";
  return scope === "platform_admin";
}

export async function listAdminIdeas(db: Db, tab: AdminTab, entries: readonly UpcomingEntry[] = UPCOMING): Promise<AdminIdeaList> {
  const where =
    tab === "pending"
      ? `f.status = 'pending'`
      : tab === "planned"
        ? `f.status = 'planned'`
        : `f.status in ('declined', 'merged') and f.decided_at >= now() - interval '90 days'`;
  const order = tab === "pending" ? `f.created_at asc, f.id` : tab === "planned" ? `f.decided_at asc, f.id` : `f.decided_at desc, f.id`;
  const { rows } = await db.query<{
    id: string;
    status: FeatureIdeaStatus;
    created_at: Date;
    description: string | null;
    author_id: string;
    display_name: string;
    deactivated: boolean;
    scrubbed: boolean;
    named: boolean;
    title: string | null;
    teaser: string | null;
    audience: UpcomingAudience | null;
    decision_note: string | null;
    merged_into: string | null;
    decided_by_name: string | null;
    decided_at: Date | null;
    votes: number;
  }>(
    `select f.id, f.status, f.created_at, f.description, f.author_id, u.display_name, not u.active as deactivated,
            u.scrubbed_at is not null as scrubbed, u.feature_ideas_named as named,
            f.title, f.teaser, f.audience, f.decision_note, f.merged_into, d.display_name as decided_by_name, f.decided_at,
            (select count(*)::int from feature_idea_votes v where v.idea_id = f.id) as votes
       from feature_ideas f
       join users u on u.id = f.author_id
       left join users d on d.id = f.decided_by
      where ${where}
      order by ${order}`,
  );
  const scopes = tab === "pending" ? await scopesOf(db, [...new Set(rows.map((r) => r.author_id))]) : new Map<string, UpcomingAudience>();
  const ideas: AdminIdeaRow[] = [];
  for (const r of rows) {
    ideas.push({
      id: r.id,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      description: r.description,
      excerpt: r.description ? ideaExcerpt(r.description, PENDING_ROW_EXCERPT_MAX) : "",
      proposer: { id: r.author_id, displayName: r.display_name, deactivated: r.deactivated, scrubbed: r.scrubbed, named: r.named },
      proposerScope: scopes.get(r.author_id) ?? null,
      title: r.title,
      teaser: r.teaser,
      audience: r.audience,
      votes: r.votes,
      decisionNote: r.decision_note,
      mergedInto: r.merged_into,
      mergedTitle: r.status === "merged" ? ((await liveEntryTitle(db, r.merged_into, entries))?.title ?? null) : null,
      decidedBy: r.decided_by_name,
      decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    });
  }
  if (tab === "planned") {
    // The §38.2 order among ideas: votes, then the oldest approval (the query's order).
    ideas.sort((a, b) => compareEntries({ kind: "idea", votes: a.votes, approvedAt: a.decidedAt ?? "" }, { kind: "idea", votes: b.votes, approvedAt: b.decidedAt ?? "" }));
  }
  return { ideas, targets: tab === "pending" ? await mergeTargets(db, entries) : [] };
}

async function mergeTargets(db: Db, entries: readonly UpcomingEntry[]): Promise<MergeTarget[]> {
  const { rows } = await db.query<{ id: string; title: string; audience: UpcomingAudience }>(
    `select id, title, audience from feature_ideas where status = 'planned' order by decided_at, id`,
  );
  return [
    ...entries.map((e) => ({ id: specEntryId(e.key), kind: "spec" as const, title: e.title, audience: e.audience })),
    ...rows.map((r) => ({ id: ideaEntryId(r.id), kind: "idea" as const, title: r.title, audience: r.audience })),
  ];
}

export async function countPendingIdeas(db: Db): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from feature_ideas where status = 'pending'`);
  return rows[0]?.n ?? 0;
}

export type DecisionResult = { status: "ok" } | { status: "not_found" } | { status: "conflict" } | { status: "not_visible" } | { status: "bad_target" };

/** 404 when the idea does not exist, 409 when it is in another status than the action needs. */
async function missOrConflict(db: Db, id: string): Promise<DecisionResult> {
  const { rows } = await db.query(`select 1 from feature_ideas where id = $1`, [id]);
  return { status: rows.length > 0 ? "conflict" : "not_found" };
}

/**
 * Approve (§38.5), in one transaction: the row becomes `planned` with the admin's copy, the
 * proposer's vote is added, the audit row, the `idea_approved` award and event 19. A guarded UPDATE
 * on `status = 'pending'`, so a second admin deciding at the same moment gets the 409.
 */
export async function approveIdea(pool: Pool, actorId: string, id: string, copy: PublishedCopy): Promise<DecisionResult> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ author_id: string; description: string }>(
      `update feature_ideas set status = 'planned', title = $2, teaser = $3, audience = $4, decided_by = $5, decided_at = now(), updated_at = now()
        where id = $1 and status = 'pending' returning author_id, description`,
      [id, copy.title, copy.teaser, copy.audience, actorId],
    );
    const idea = rows[0];
    if (!idea) return missOrConflict(client, id);
    await client.query(`insert into feature_idea_votes (user_id, idea_id) values ($1, $2) on conflict do nothing`, [idea.author_id, id]);
    await appendAudit(client, { actorUserId: actorId, action: "feature_idea.approved", targetType: "feature_idea", targetId: id, after: copy });
    await awardIdeaApproved(client, idea.author_id, id);
    await deliverIdeaReviewed(client, { proposerId: idea.author_id, actorId, outcome: "approved", title: copy.title, teaser: copy.teaser, text: idea.description });
    return { status: "ok" } as const;
  });
}

/** Decline with an optional note, which event 19 carries to the proposer. */
export async function declineIdea(pool: Pool, actorId: string, id: string, note: string | null): Promise<DecisionResult> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ author_id: string; description: string }>(
      `update feature_ideas set status = 'declined', decision_note = $2, decided_by = $3, decided_at = now(), updated_at = now()
        where id = $1 and status = 'pending' returning author_id, description`,
      [id, note, actorId],
    );
    const idea = rows[0];
    if (!idea) return missOrConflict(client, id);
    await appendAudit(client, { actorUserId: actorId, action: "feature_idea.declined", targetType: "feature_idea", targetId: id, after: { note } });
    await deliverIdeaReviewed(client, { proposerId: idea.author_id, actorId, outcome: "declined", text: idea.description, note });
    return { status: "ok" } as const;
  });
}

/**
 * Merge as duplicate: the proposal points at a live entry whose audience includes the proposer
 * (otherwise event 19 would name an entry they cannot see — `not_visible`), the proposer's vote moves
 * to it, and event 19 says it is already planned. No award.
 */
export async function mergeIdea(pool: Pool, actorId: string, id: string, target: EntryRef, entries: readonly UpcomingEntry[] = UPCOMING): Promise<DecisionResult> {
  return inTransaction(pool, async (client) => {
    if (target.kind === "idea" && target.id === id) return { status: "bad_target" } as const;
    const targetId = entryIdOf(target);
    const live = await liveEntryTitle(client, targetId, entries, true);
    if (!live) return { status: "bad_target" } as const;
    const { rows: pending } = await client.query<{ author_id: string; description: string }>(
      `select author_id, description from feature_ideas where id = $1 and status = 'pending' for update`,
      [id],
    );
    const idea = pending[0];
    if (!idea) return missOrConflict(client, id);
    const scope = (await scopesOf(client, [idea.author_id])).get(idea.author_id) ?? "everyone";
    if (!audienceIncludesScope(live.audience, scope)) return { status: "not_visible" } as const;
    await client.query(
      `update feature_ideas set status = 'merged', merged_into = $2, decided_by = $3, decided_at = now(), updated_at = now() where id = $1`,
      [id, targetId, actorId],
    );
    await client.query(
      target.kind === "spec"
        ? `insert into feature_idea_votes (user_id, spec_key) values ($1, $2) on conflict do nothing`
        : `insert into feature_idea_votes (user_id, idea_id) values ($1, $2::uuid) on conflict do nothing`,
      [idea.author_id, target.kind === "spec" ? target.key : target.id],
    );
    await appendAudit(client, { actorUserId: actorId, action: "feature_idea.merged", targetType: "feature_idea", targetId: id, after: { entry: targetId } });
    await deliverIdeaReviewed(client, { proposerId: idea.author_id, actorId, outcome: "merged", title: live.title, teaser: live.teaser, text: idea.description });
    return { status: "ok" } as const;
  });
}

/** Edit a planned idea's title, teaser and audience. Votes are kept; nobody is notified. */
export async function editIdea(pool: Pool, actorId: string, id: string, copy: PublishedCopy): Promise<DecisionResult> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<PublishedCopy>(`select title, teaser, audience from feature_ideas where id = $1 and status = 'planned' for update`, [id]);
    const before = rows[0];
    if (!before) return missOrConflict(client, id);
    await client.query(`update feature_ideas set title = $2, teaser = $3, audience = $4, updated_at = now() where id = $1`, [id, copy.title, copy.teaser, copy.audience]);
    const diffBefore: Partial<PublishedCopy> = {};
    const diffAfter: Partial<PublishedCopy> = {};
    for (const key of ["title", "teaser", "audience"] as const) {
      if (before[key] !== copy[key]) {
        (diffBefore as Record<string, string>)[key] = before[key];
        (diffAfter as Record<string, string>)[key] = copy[key];
      }
    }
    await appendAudit(client, { actorUserId: actorId, action: "feature_idea.edited", targetType: "feature_idea", targetId: id, before: diffBefore, after: diffAfter });
    return { status: "ok" } as const;
  });
}

export type DeleteResult = DecisionResult | { status: "needs_choice" };

/**
 * Delete (§38.5): a PENDING row is the spam delete — gone at once, nothing sent. A PLANNED row needs
 * `notifyShipped`: its votes go with it (cascade), and, ticked, event 20 reaches the proposer and
 * every voter the idea still applies to, and the proposer earns `idea_shipped`. Declined and merged
 * rows are not deleted here. The audit row never carries the proposal's text.
 */
export async function deleteIdea(pool: Pool, actorId: string, id: string, notifyShipped: boolean | undefined): Promise<DeleteResult> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: FeatureIdeaStatus; author_id: string; title: string | null; audience: UpcomingAudience | null }>(
      `select status, author_id, title, audience from feature_ideas where id = $1 for update`,
      [id],
    );
    const idea = rows[0];
    if (!idea) return { status: "not_found" } as const;
    if (idea.status !== "pending" && idea.status !== "planned") return { status: "conflict" } as const;
    if (idea.status === "planned" && typeof notifyShipped !== "boolean") return { status: "needs_choice" } as const;

    const { rows: voters } = await client.query<{ user_id: string }>(`select user_id from feature_idea_votes where idea_id = $1 order by created_at`, [id]);
    await client.query(`delete from feature_ideas where id = $1`, [id]);
    await appendAudit(client, {
      actorUserId: actorId,
      action: "feature_idea.deleted",
      targetType: "feature_idea",
      targetId: id,
      before: { status: idea.status, title: idea.title },
      ...(idea.status === "planned" ? { after: { notifyShipped } } : {}),
    });
    if (idea.status === "planned" && notifyShipped) {
      await awardIdeaShipped(client, idea.author_id, id);
      await deliverFeatureAvailable(client, {
        title: idea.title!,
        proposerId: idea.author_id,
        voterIds: voters.map((v) => v.user_id),
        audience: idea.audience!,
        actorId,
        bootstrapAdminGroup: bootstrapGroup(),
      });
    }
    return { status: "ok" } as const;
  });
}
