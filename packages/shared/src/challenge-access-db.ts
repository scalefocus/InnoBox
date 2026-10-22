// The database half of challenges shared with specific people (INNOBOX_SPEC.md §4.3 `people`,
// §7.3, §12.1 event 15, §15). Shared so the web tier (the list editor, the §24.5 accept, the
// assignment auto-add, JIT sign-in) and the worker (SCIM and reconciliation user writes) run
// exactly the same rules. Authorization is the caller's job: nothing here checks who is asking.
//
// Two rules hold throughout:
//   - an address never enters the append-only audit log — `challenge.access_changed` carries user
//     ids and only a COUNT of pending e-mails (§15);
//   - event 15 fires at most once per entry, pinned by `challenge_access.notified_at`, and only
//     while the challenge is past triage, not withdrawn and not trashed (§12.1).
import { appendAudit } from "./audit.js";
import { formatChallengeNumber } from "./challenges.js";
import { challengeTeamJsonSql, teamDisplayText } from "./coauthors-db.js";
import type { TeamMemberRow } from "./coauthors.js";
import type { AccessEntryView, AccessListInput } from "./challenge-access.js";
import type { DbClient } from "./email-graph.js";

export type AccessChangeVia = "editor" | "accept" | "assignment" | "binding";

/** One side of an access-list change as the audit row records it. */
export interface AccessListSide {
  userIds: string[];
  pending: number;
}

/** The `challenge.access_changed` payload (§15). */
export interface AccessListChange {
  added: AccessListSide;
  removed: AccessListSide;
  via: AccessChangeVia;
}

/** The §12.1 event 15 notification type. */
export const CHALLENGE_SHARED_TYPE = "challenge_shared";
export const CHALLENGE_SHARED_SUBJECT = "A challenge has been shared with you";

function emptySide(): AccessListSide {
  return { userIds: [], pending: 0 };
}

function isChange(diff: { added: AccessListSide; removed: AccessListSide }): boolean {
  return diff.added.userIds.length + diff.added.pending + diff.removed.userIds.length + diff.removed.pending > 0;
}

async function auditAccessChange(db: DbClient, challengeId: string, actorId: string | null, change: AccessListChange): Promise<void> {
  await appendAudit(db, {
    actorUserId: actorId,
    action: "challenge.access_changed",
    targetType: "challenge",
    targetId: challengeId,
    after: change,
  });
}

/** Active, unscrubbed users matching these lower-cased addresses by e-mail or user name (the UPN),
 *  as address → user id. An address matching more than one user resolves to none of them: it
 *  stays pending rather than guess. */
export async function resolveAccessEmails(db: DbClient, emails: readonly string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; email: string | null; user_name: string | null }>(
    `select id, lower(email) as email, lower(user_name) as user_name
       from users
      where active and scrubbed_at is null and (lower(email) = any($1::text[]) or lower(user_name) = any($1::text[]))`,
    [emails],
  );
  const matches = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const key of [row.email, row.user_name]) {
      if (key && emails.includes(key)) {
        const set = matches.get(key) ?? new Set<string>();
        set.add(row.id);
        matches.set(key, set);
      }
    }
  }
  const out = new Map<string, string>();
  for (const [email, ids] of matches) if (ids.size === 1) out.set(email, [...ids][0]!);
  return out;
}

export type ReplaceAccessResult =
  | { status: "ok"; change: AccessListChange | null }
  /** A user id that names no active user. */
  | { status: "unknown_user"; userId: string };

/**
 * Replaces a challenge's whole access list with `input` (§4.3, §16): addresses matching an active
 * user become that user's entry, the rest stay pending. Entries already on the list keep their
 * `notified_at`, so re-saving a list never re-notifies. Audits the difference, if any. Run it in
 * the caller's transaction; follow it with deliverShareNotifications after the visibility is set.
 */
export async function replaceAccessList(
  db: DbClient,
  opts: { challengeId: string; input: AccessListInput; actorId: string | null; via: AccessChangeVia },
): Promise<ReplaceAccessResult> {
  const { challengeId, input, actorId, via } = opts;
  if (input.userIds.length > 0) {
    const { rows } = await db.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and active and scrubbed_at is null`, [input.userIds]);
    const known = new Set(rows.map((r) => r.id));
    const unknown = input.userIds.find((id) => !known.has(id));
    if (unknown) return { status: "unknown_user", userId: unknown };
  }
  const resolved = await resolveAccessEmails(db, input.emails);
  const wantedUsers = new Set([...input.userIds, ...resolved.values()]);
  const wantedPending = new Set(input.emails.filter((e) => !resolved.has(e)));

  const { rows: current } = await db.query<{ id: string; user_id: string | null; email: string | null }>(
    `select id, user_id, email from challenge_access where challenge_id = $1`,
    [challengeId],
  );
  const added = emptySide();
  const removed = emptySide();
  const removeIds: string[] = [];
  for (const row of current) {
    if (row.user_id !== null) {
      if (wantedUsers.has(row.user_id)) wantedUsers.delete(row.user_id);
      else {
        removeIds.push(row.id);
        removed.userIds.push(row.user_id);
      }
    } else if (row.email !== null) {
      if (wantedPending.has(row.email)) wantedPending.delete(row.email);
      else {
        removeIds.push(row.id);
        removed.pending += 1;
      }
    }
  }
  if (removeIds.length > 0) await db.query(`delete from challenge_access where id = any($1::uuid[])`, [removeIds]);
  for (const userId of wantedUsers) {
    await db.query(
      `insert into challenge_access (challenge_id, user_id, added_by) values ($1, $2, $3)
       on conflict (challenge_id, user_id) where user_id is not null do nothing`,
      [challengeId, userId, actorId],
    );
    added.userIds.push(userId);
  }
  for (const email of wantedPending) {
    await db.query(
      `insert into challenge_access (challenge_id, email, added_by) values ($1, $2, $3)
       on conflict (challenge_id, email) where email is not null do nothing`,
      [challengeId, email, actorId],
    );
    added.pending += 1;
  }
  const change: AccessListChange = { added, removed, via };
  if (!isChange(change)) return { status: "ok", change: null };
  await auditAccessChange(db, challengeId, actorId, change);
  return { status: "ok", change };
}

/** Deletes a challenge's whole list — switching away from `people` (§4.3). Returns what was removed
 *  for the `challenge.visibility_changed` audit row; writes no audit row of its own. */
export async function clearAccessList(db: DbClient, challengeId: string): Promise<AccessListSide> {
  const { rows } = await db.query<{ user_id: string | null }>(`delete from challenge_access where challenge_id = $1 returning user_id`, [challengeId]);
  return {
    userIds: rows.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    pending: rows.filter((r) => r.user_id === null).length,
  };
}

/** §7.3: assigning someone who cannot yet see a `people` challenge adds them to its list. The entry
 *  is stamped as notified — event 7 already tells them, so no event 15 and no auto-follow. True
 *  when an entry was added (and audited). */
export async function addAccessForAssignment(db: DbClient, opts: { challengeId: string; userId: string; actorId: string }): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `insert into challenge_access (challenge_id, user_id, added_by, notified_at) values ($1, $2, $3, now())
     on conflict (challenge_id, user_id) where user_id is not null do nothing
     returning id`,
    [opts.challengeId, opts.userId, opts.actorId],
  );
  if (rows.length === 0) return false;
  // A pending entry for the same person (their address) is now redundant.
  await db.query(
    `delete from challenge_access ca using users u
      where u.id = $2 and ca.challenge_id = $1 and ca.email is not null and (ca.email = lower(u.email) or ca.email = lower(u.user_name))`,
    [opts.challengeId, opts.userId],
  );
  await auditAccessChange(db, opts.challengeId, opts.actorId, { added: { userIds: [opts.userId], pending: 0 }, removed: emptySide(), via: "assignment" });
  return true;
}

/** The list as the item's admins see it (§4.3): users first by name, then pending addresses. */
export async function listAccessEntries(db: DbClient, challengeId: string): Promise<AccessEntryView[]> {
  const { rows } = await db.query<{ user_id: string | null; display_name: string | null; user_email: string | null; active: boolean | null; email: string | null }>(
    `select ca.user_id, u.display_name, u.email as user_email, u.active, ca.email
       from challenge_access ca
       left join users u on u.id = ca.user_id
      where ca.challenge_id = $1
      order by ca.user_id is null, lower(coalesce(u.display_name, ca.email))`,
    [challengeId],
  );
  return rows.map((r) =>
    r.user_id !== null
      ? { user: { id: r.user_id, displayName: r.display_name ?? "", email: r.user_email, active: r.active ?? false }, email: null }
      : { user: null, email: r.email },
  );
}

/**
 * §4.3: binds every pending entry whose address is this user's e-mail or user name (compared
 * lower-cased) to the user — called after SCIM, JIT sign-in or reconciliation creates or updates
 * a user. A pending entry on a list that already names the user is simply dropped. Each touched
 * challenge gets a `challenge.access_changed` row (`via: "binding"`, no actor) and then event 15.
 * Returns the challenges touched. Safe to call for any user, any number of times.
 */
export async function bindPendingAccess(db: DbClient, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string; challenge_id: string; already: boolean }>(
    `select ca.id, ca.challenge_id,
            exists (select 1 from challenge_access x where x.challenge_id = ca.challenge_id and x.user_id = u.id) as already
       from challenge_access ca
       join users u on u.id = $1 and u.active and u.scrubbed_at is null
      where ca.email is not null and (ca.email = lower(u.email) or ca.email = lower(u.user_name))`,
    [userId],
  );
  const touched: string[] = [];
  for (const row of rows) {
    if (row.already) {
      await db.query(`delete from challenge_access where id = $1`, [row.id]);
      continue;
    }
    const { rowCount } = await db.query(`update challenge_access set user_id = $2, email = null where id = $1 and email is not null`, [row.id, userId]);
    if (!rowCount) continue;
    await auditAccessChange(db, row.challenge_id, null, { added: { userIds: [userId], pending: 0 }, removed: { userIds: [], pending: 1 }, via: "binding" });
    touched.push(row.challenge_id);
  }
  for (const challengeId of touched) await deliverShareNotifications(db, challengeId);
  return touched;
}

/** The event-15 message: number, title and the author masked per §9 (or the §24.6 label). It names
 *  neither the admin who shared it nor anyone else on the list. */
export function challengeSharedMessage(input: { number: string; title: string; author: string }): string {
  return `${formatChallengeNumber(input.number)} "${input.title}" (submitted by ${input.author}) has been shared with you.`;
}

/**
 * §12.1 event 15: for every bound, not-yet-notified entry on a `people` challenge that is past
 * triage, not withdrawn and not trashed — the in-app row, the outbox row (immediate: event 15 is
 * never digested), the auto-follow (§12.3), and `notified_at`. An entry for `actorId` (an admin who
 * put themselves on the list) is stamped without a notification: actors never notify themselves.
 * Returns how many people were notified. Idempotent: a second call finds nothing to do.
 */
export async function deliverShareNotifications(db: DbClient, challengeId: string, actorId: string | null = null): Promise<number> {
  const { rows } = await db.query<{
    access_id: string;
    user_id: string;
    number: string;
    title: string;
    is_anonymous: boolean;
    author_id: string | null;
    author_display_name: string | null;
    company: string | null;
    team: TeamMemberRow[];
  }>(
    `select ca.id as access_id, ca.user_id, c.number::text as number, c.title, c.is_anonymous, c.author_id,
            au.display_name as author_display_name, ps.company, ${challengeTeamJsonSql("c")} as team
       from challenge_access ca
       join challenges c on c.id = ca.challenge_id
       join users u on u.id = ca.user_id and u.active and u.scrubbed_at is null
       left join users au on au.id = c.author_id
       left join public_submissions ps on ps.id = c.public_submission_id
      where ca.challenge_id = $1 and ca.notified_at is null
        and c.visibility = 'people' and c.status not in ('awaiting_triage', 'withdrawn') and c.trashed_at is null`,
    [challengeId],
  );
  let sent = 0;
  for (const row of rows) {
    const { rowCount } = await db.query(`update challenge_access set notified_at = now() where id = $1 and notified_at is null`, [row.access_id]);
    if (!rowCount || row.user_id === actorId) continue;
    // §39.7: a team is named by its first member plus "and N others".
    const author = teamDisplayText({ isAnonymous: row.is_anonymous, authorId: row.author_id, authorDisplayName: row.author_display_name, externalCompany: row.company, team: row.team });
    const payload = {
      message: challengeSharedMessage({ number: row.number, title: row.title, author }),
      link: `/challenges/${row.number}`,
      parentType: "challenge",
      parentId: challengeId,
    };
    const { rows: inserted } = await db.query<{ id: string }>(
      `insert into notifications (user_id, type, payload) values ($1, $2, $3) returning id`,
      [row.user_id, CHALLENGE_SHARED_TYPE, JSON.stringify(payload)],
    );
    await db.query(`insert into notification_outbox (user_id, type, payload) values ($1, $2, $3)`, [
      row.user_id,
      CHALLENGE_SHARED_TYPE,
      JSON.stringify({ ...payload, subject: CHALLENGE_SHARED_SUBJECT, notificationId: inserted[0]!.id }),
    ]);
    await db.query(
      `insert into follows (user_id, parent_type, parent_id) values ($1, 'challenge', $2) on conflict do nothing`,
      [row.user_id, challengeId],
    );
    // §34.5: being told through event 15 counts — event 18 never tells them about it again.
    await db.query(
      `insert into topic_notices (challenge_id, user_id, via) values ($1, $2, 'shared') on conflict do nothing`,
      [challengeId, row.user_id],
    );
    sent += 1;
  }
  return sent;
}
