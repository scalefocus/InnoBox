// §43 mentions — the server side (INNOBOX_SPEC.md §43): the one serializer every reader of solution
// text goes through (stored text → display text, §43.2), the rows a save writes with its eligibility
// and caps (§43.4, §43.5), and the check that settles pending mentions (§43.4). The pure rules — the
// token, binding, the status table, the caps' arithmetic — live in @innobox/shared/mentions; event
// 26 itself is written after the commit, by notifyMentioned (./notify-events).
// Relative imports only (no `@/`) so the gated dbtests can load the stores that call this.
import type { Pool, PoolClient } from "pg";
import {
  MENTION_DELETED_NAME,
  canSeeSolution,
  displayMentions,
  hasMentions,
  mentionCapRefusal,
  mentionRoom,
  mentionSettleScope,
  mentionedUserIds,
  renderMentions,
  utcDayStart,
  type MentionCandidate,
  type RoleSet,
  type SolutionStatus,
} from "@innobox/shared";

type Db = Pool | PoolClient;

// ── The serializer (§43.2, §43.7) ────────────────────────────────────────────────────────

/** A mentioned person as the serializer needs them. */
interface MentionPerson {
  id: string;
  displayName: string;
  active: boolean;
  scrubbed: boolean;
}

/** Where one mention sits in a solution's display text, and whom it names (§43.11). `user` is null
 *  for an erased person: the page then shows plain "@Deleted User", with no link and no card. */
export interface MentionView {
  field: "description" | "costVsBenefits";
  start: number;
  length: number;
  user: { id: string; displayName: string; active: boolean } | null;
}

/** The people behind every token of the given stored texts — one query, none when no text has one. */
async function loadMentionPeople(db: Db, stored: readonly (string | null | undefined)[]): Promise<Map<string, MentionPerson>> {
  const ids = mentionedUserIds(...stored);
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; display_name: string; active: boolean; scrubbed: boolean }>(
    `select id, display_name, active, scrubbed_at is not null as scrubbed from users where id = any($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, displayName: r.display_name, active: r.active, scrubbed: r.scrubbed }]));
}

/** The name a token reads as: the person's CURRENT display name, or the erased one (§43.2). */
function nameOf(people: ReadonlyMap<string, MentionPerson>): (userId: string) => string {
  return (userId) => {
    const person = people.get(userId);
    return !person || person.scrubbed ? MENTION_DELETED_NAME : person.displayName;
  };
}

/**
 * §43.2 "one serializer": turns the named text fields of every row into display text, in place.
 * Every read of solution text that leaves the server goes through this (or through
 * `serializeSolutionTexts`, which also reports the ranges), so no response ever carries a token.
 */
export async function displayTextFields<T extends object>(db: Db, rows: readonly T[], fields: readonly (keyof T)[]): Promise<void> {
  const texts: string[] = [];
  for (const row of rows) for (const f of fields) if (typeof row[f] === "string" && hasMentions(row[f] as string)) texts.push(row[f] as string);
  if (texts.length === 0) return;
  const name = nameOf(await loadMentionPeople(db, texts));
  for (const row of rows) {
    for (const f of fields) {
      const value = row[f];
      if (typeof value === "string" && hasMentions(value)) (row as Record<keyof T, unknown>)[f] = displayMentions(value, name);
    }
  }
}

/** The stored description and cost vs benefits of a solution row, as the detail builders read them. */
interface SolutionTextRow {
  description: string;
  cost_vs_benefits: string | null;
  mentions?: MentionView[];
}

/**
 * The detail page's form of the serializer: each row's two texts become display text, in place, and
 * the row gains `mentions` — where each mention sits in that display text and whom it names
 * (§43.11). Rows without a token get an empty list and cost no query.
 */
export async function serializeSolutionTexts(db: Db, rows: readonly SolutionTextRow[]): Promise<void> {
  const people = await loadMentionPeople(db, rows.flatMap((r) => [r.description, r.cost_vs_benefits]));
  const name = nameOf(people);
  for (const row of rows) {
    const views: MentionView[] = [];
    const render = (field: MentionView["field"], stored: string): string => {
      const { text, ranges } = renderMentions(stored, name);
      for (const r of ranges) {
        const person = people.get(r.userId);
        views.push({
          field,
          start: r.start,
          length: r.length,
          user: person && !person.scrubbed ? { id: person.id, displayName: person.displayName, active: person.active } : null,
        });
      }
      return text;
    };
    row.description = render("description", row.description);
    if (row.cost_vs_benefits !== null) row.cost_vs_benefits = render("costVsBenefits", row.cost_vs_benefits);
    row.mentions = views;
  }
}

/** §43.2: the candidates a save that sends no list binds — the people the stored texts name, by
 *  their current display names. An erased person is on no list: their "@Deleted User" becomes
 *  ordinary text at this save. */
export async function currentMentionCandidates(db: Db, stored: readonly (string | null)[]): Promise<MentionCandidate[]> {
  const people = await loadMentionPeople(db, stored);
  return mentionedUserIds(...stored)
    .map((id) => people.get(id))
    .filter((p): p is MentionPerson => p !== undefined && !p.scrubbed && p.displayName !== "")
    .map((p) => ({ userId: p.id, name: p.displayName }));
}

// ── What a save writes (§43.4, §43.5) ────────────────────────────────────────────────────

/**
 * §43.5: of `userIds`, whether every one may be given a NEW mention row by `saverId` — an active,
 * not-erased person with a display name, who is not the saver and passes `canSee` (the challenge's
 * full §4.3 predicate) with their own roles. One answer for every reason.
 */
export async function areEligibleForMention(
  db: Db,
  userIds: readonly string[],
  saverId: string,
  canSee: (userId: string) => Promise<boolean>,
): Promise<boolean> {
  if (userIds.length === 0) return true;
  if (userIds.includes(saverId)) return false;
  const { rows } = await db.query<{ id: string }>(
    `select id from users where id = any($1::uuid[]) and active and scrubbed_at is null and display_name <> ''`,
    [userIds],
  );
  if (rows.length !== userIds.length) return false;
  for (const userId of userIds) if (!(await canSee(userId))) return false;
  return true;
}

/** The people a solution's rows name — settled or pending. */
export async function mentionRowUserIds(db: Db, solutionId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(`select user_id from solution_mentions where solution_id = $1`, [solutionId]);
  return rows.map((r) => r.user_id);
}

/** Thrown from inside a save's transaction when the mentions it would add break a cap (§43.5), so
 *  the whole save rolls back — "a refused save writes nothing, not the text, not the rows". */
export class MentionCapError extends Error {
  constructor(readonly reason: "solution_cap" | "daily_cap") {
    super(reason);
  }
}

/**
 * §43.5: the per-saver lock that serializes the daily cap. Taken first in a save's transaction —
 * before any write and before the audit chain's lock — by every path, so two saves by one person
 * never both take the last place and never deadlock.
 */
export async function lockMentionSaver(client: PoolClient, saverId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`mentions:${saverId}`]);
}

/**
 * §43.4 / §43.5: brings a solution's rows in line with the people its stored text now names, inside
 * the save's transaction and under `lockMentionSaver`. A pending row whose person is no longer named
 * is deleted (cancelled, its place under the daily cap free again); a settled row is never touched;
 * a named person with no row gets one, with the saver as `mentioned_by`. Breaking a cap throws
 * `MentionCapError`. The caller has already checked eligibility for the people it expects to be new.
 * Returns the people who got a row.
 */
export async function syncMentionRows(client: PoolClient, solutionId: string, saverId: string, namedUserIds: readonly string[]): Promise<string[]> {
  await client.query(`delete from solution_mentions where solution_id = $1 and settled_at is null and not (user_id = any($2::uuid[]))`, [solutionId, namedUserIds]);
  const existing = new Set(await mentionRowUserIds(client, solutionId));
  const added = namedUserIds.filter((id) => !existing.has(id));
  if (added.length === 0) return added;
  const { rows } = await client.query<{ today: number }>(
    `select count(*)::int as today from solution_mentions where mentioned_by = $1 and created_at >= $2`,
    [saverId, utcDayStart(new Date())],
  );
  const refusal = mentionCapRefusal(existing.size + added.length, (rows[0]?.today ?? 0) + added.length);
  if (refusal) throw new MentionCapError(refusal);
  await client.query(`insert into solution_mentions (solution_id, user_id, mentioned_by) select $1, u, $2 from unnest($3::uuid[]) as u`, [solutionId, saverId, added]);
  return added;
}

// ── The settling check (§43.4) ───────────────────────────────────────────────────────────

/** A mention the check just settled — what event 26 needs after the commit. */
export interface SettledMention {
  userId: string;
  /** Who wrote the mention — null once that person has been erased. */
  mentionedBy: string | null;
}

/**
 * §43.4: settles a solution's pending mentions, inside the transaction of the save or status change
 * that triggered the check. Whom it settles follows the status table — everyone pending once the
 * solution is open to all who can see the challenge; only the pending people who can already see it
 * while it is `proposed`; nobody while it is closed or in the trash. The stamp is what keeps the
 * notice to one per person per solution; the caller hands the result to notifyMentioned after the
 * commit, which decides who is told and who is passed over in silence.
 *
 * While `proposed`, "can already see it" is the §4.3 rule itself (`canSeeSolution`): the solution's
 * team and the challenge's assignee, read from the rows, and the namespace's committee and admins,
 * through `resolveRoles` (invariant 1 — roles are never guessed here). Without a resolver, only the
 * team and the assignee settle; a reviewer then simply waits for the solution to leave `proposed`.
 */
export async function settlePendingMentions(
  client: PoolClient,
  solutionId: string,
  resolveRoles?: (userId: string) => Promise<RoleSet>,
): Promise<SettledMention[]> {
  const { rows } = await client.query<{ status: string; trashed: boolean; namespace_id: string; assignee_id: string | null; author_ids: string[] }>(
    `select s.status, (s.trashed_at is not null or c.trashed_at is not null) as trashed, c.namespace_id, c.assignee_id,
            array(select sa.user_id from solution_authors sa where sa.solution_id = s.id) as author_ids
       from solutions s join challenges c on c.id = s.challenge_id
      where s.id = $1
        and exists (select 1 from solution_mentions m where m.solution_id = s.id and m.settled_at is null)`,
    [solutionId],
  );
  const solution = rows[0];
  if (!solution || solution.trashed) return [];
  const scope = mentionSettleScope(solution.status as SolutionStatus);
  if (scope === "none") return [];
  const returning = `returning m.user_id as "userId", m.mentioned_by as "mentionedBy"`;
  if (scope === "all") {
    const settled = await client.query<SettledMention>(
      `update solution_mentions m set settled_at = now() where m.solution_id = $1 and m.settled_at is null ${returning}`,
      [solutionId],
    );
    return settled.rows;
  }
  const { rows: pending } = await client.query<{ user_id: string }>(`select user_id from solution_mentions where solution_id = $1 and settled_at is null`, [solutionId]);
  const viewers: string[] = [];
  for (const { user_id: userId } of pending) {
    const onRows = solution.author_ids.includes(userId) || userId === solution.assignee_id;
    const sees =
      onRows ||
      (resolveRoles !== undefined &&
        canSeeSolution(
          { userId, roles: await resolveRoles(userId) },
          { namespaceId: solution.namespace_id, assigneeId: solution.assignee_id },
          { status: "proposed", authorIds: solution.author_ids, trashed: false },
        ));
    if (sees) viewers.push(userId);
  }
  if (viewers.length === 0) return [];
  const settled = await client.query<SettledMention>(
    `update solution_mentions m set settled_at = now() where m.solution_id = $1 and m.settled_at is null and m.user_id = any($2::uuid[]) ${returning}`,
    [solutionId, viewers],
  );
  return settled.rows;
}

// ── The forms' room (§43.11) ─────────────────────────────────────────────────────────────

/** §43.11: `mentionsLeftToday` for a viewer, and `mentionsLeft` for each of the given solutions —
 *  the room under the daily and the per-solution cap. */
export async function mentionRoomFor(db: Db, userId: string, solutionIds: readonly string[]): Promise<{ leftToday: number; left: Map<string, number> }> {
  const { rows: today } = await db.query<{ n: number }>(`select count(*)::int as n from solution_mentions where mentioned_by = $1 and created_at >= $2`, [
    userId,
    utcDayStart(new Date()),
  ]);
  const createdToday = today[0]?.n ?? 0;
  const left = new Map<string, number>(solutionIds.map((id) => [id, mentionRoom(0, createdToday).left]));
  if (solutionIds.length > 0) {
    const { rows } = await db.query<{ solution_id: string; n: number }>(
      `select solution_id, count(*)::int as n from solution_mentions where solution_id = any($1::uuid[]) group by solution_id`,
      [solutionIds],
    );
    for (const r of rows) left.set(r.solution_id, mentionRoom(r.n, createdToday).left);
  }
  return { leftToday: mentionRoom(0, createdToday).leftToday, left };
}
