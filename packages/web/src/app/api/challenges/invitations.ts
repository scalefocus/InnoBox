// Data layer for §40 invite a solver (INNOBOX_SPEC.md §40.2–§40.4, §40.11): the picker's audience,
// sending invitations (POST /api/challenges/:number/invitations), the invitee's quiet "Not for me"
// (…/invitations/dismiss), and the per-viewer fields the challenge detail payload carries. The pure
// rules — the caps, the parser, the "answered" rule, the copy — live in @innobox/shared
// (invitations.ts); the payoff lives in lib/invitation-payoffs.ts, inside the transitions.
//
// Visibility (invariant 2): every path starts from a challenge the caller can see, and an invitee
// must be able to see it too — an invitation never widens visibility. Nothing here counts or lists
// invitations for anyone but the two people involved: the inviter's own "You invited" list and the
// invitee's own open invitations. The picker and the send filter only on what the inviter can see
// for themselves, so neither reveals a hidden `proposed` solution, an anonymous author or a decline.
// Relative imports only (no `@/`) so the gated dbtests can load it.
import type { Pool, PoolClient } from "pg";
import { canSeeChallenge, invitationCapRefusal, invitationRoom, isAnswered, utcDayStart, type InvitationRequest } from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { memberFromCreateSql } from "../../../lib/invitation-payoffs";
import { loadInvitationChallenge, visibleOpenSolutionMemberIds, type InvitationChallenge, type ResolveAssigneeRoles, type Viewer } from "./store";

type Db = Pool | PoolClient;

/** A person in an invitation list. Erasure deletes a person's invitations (§40.8), so nobody listed
 *  is ever scrubbed; a deactivated one shows the greyed bubble. */
export interface InvitationPerson {
  id: string;
  displayName: string;
  active: boolean;
}

/** The inviter's own block (§40.2): who they invited here, newest first, and their room left. */
export interface InvitationsSent {
  sent: InvitationPerson[];
  left: number;
  leftToday: number;
}

/** One open invitation as the invitee's banner shows it (§40.3). */
export interface InvitedBy extends InvitationPerson {
  note: string | null;
  invitedAt: string;
}

/** The per-viewer fields on the challenge detail payload (§40.11). */
export interface InvitationDetailFields {
  canInvite: boolean;
  invitations: InvitationsSent | null;
  invited: { inviters: InvitedBy[] } | null;
}

/** The database's clock — the daily cap's UTC day and created_at read the same one. */
async function dbNow(db: Db): Promise<Date> {
  const { rows } = await db.query<{ now: Date }>(`select now() as now`);
  return rows[0]!.now;
}

async function sentToday(db: Db, inviterId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from challenge_invitations where inviter_id = $1 and created_at >= $2`, [
    inviterId,
    utcDayStart(await dbNow(db)),
  ]);
  return rows[0]?.n ?? 0;
}

/** The inviter's invitations to this challenge, newest first. */
async function sentOnChallenge(db: Db, challengeId: string, inviterId: string): Promise<InvitationPerson[]> {
  const { rows } = await db.query<{ id: string; display_name: string; active: boolean }>(
    `select i.invitee_id as id, u.display_name, u.active
       from challenge_invitations i join users u on u.id = i.invitee_id
      where i.challenge_id = $1 and i.inviter_id = $2
      order by i.created_at desc, i.id desc`,
    [challengeId, inviterId],
  );
  return rows.map((r) => ({ id: r.id, displayName: r.display_name, active: r.active }));
}

async function sentBlock(db: Db, challengeId: string, inviterId: string): Promise<InvitationsSent> {
  // Sequential: inside a send this runs on the transaction's one client.
  const sent = await sentOnChallenge(db, challengeId, inviterId);
  return { sent, ...invitationRoom(sent.length, await sentToday(db, inviterId)) };
}

/**
 * §40.2: who the picker leaves out besides the caller — everyone they already invited here, the
 * challenge's named team (an anonymous challenge's author is never left out), and the members of the
 * named, open solutions on it that they can see. Nothing hidden from the caller is filtered on.
 */
async function pickerExclusions(db: Db, viewer: Viewer, challenge: InvitationChallenge): Promise<string[]> {
  const invited = await sentOnChallenge(db, challenge.id, viewer.userId);
  const solutionMembers = await visibleOpenSolutionMemberIds(db, viewer, challenge);
  return [...invited.map((p) => p.id), ...(challenge.isAnonymous ? [] : challenge.authorIds), ...solutionMembers];
}

/** §40.2: the `inviteFor=<CH-n>` picker — null (no users) unless the caller can see the challenge
 *  and it accepts solutions. The search then applies the full §4.3 predicate to every candidate. */
export async function getInvitePickerAudience(
  pool: Pool,
  viewer: Viewer,
  inviteFor: string,
): Promise<{ challenge: InvitationChallenge["visibility"]; full: true; exclude: string[] } | null> {
  const challenge = await loadInvitationChallenge(pool, viewer, inviteFor.replace(/^CH-/i, ""));
  if (!challenge || !challenge.open) return null;
  return { challenge: challenge.visibility, full: true, exclude: await pickerExclusions(pool, viewer, challenge) };
}

// ── Sending (POST /api/challenges/:number/invitations) ───────────────────────────────────

/** One invitation the send wrote — what event 22 needs after the commit. */
export interface CreatedInvitation {
  inviteeId: string;
  note: string | null;
}

export type SendInvitationsResult =
  | { status: "ok"; challengeId: string; sent: number; invitations: InvitationsSent; created: CreatedInvitation[] }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "not_open" }
  | { status: "ineligible" }
  | { status: "challenge_cap" }
  | { status: "daily_cap" };

/** The refusals a challenge can give before anything else is checked (§40.11's order). */
function challengeRefusal(challenge: InvitationChallenge | null): Exclude<SendInvitationsResult, { status: "ok" }> | null {
  if (!challenge) return { status: "not_found" };
  if (challenge.trashed) return { status: "trashed" };
  if (!challenge.open) return { status: "not_open" };
  return null;
}

/**
 * §40.2: one request, 1–5 people, one note, all-or-nothing. A per-inviter advisory lock serializes the
 * eligibility check, the two caps and the inserts, so two concurrent sends can never both take the
 * last place; the challenge is read FOR SHARE so a concurrent close cannot slip past the open check.
 * Every invitee must be active, not erased, not the caller, not already invited here by the caller,
 * not visible to the caller as an author here, and able to see the challenge under the full §4.3
 * predicate with their own roles (invariant 1) — any failure is one refusal for the whole request.
 * Each invitation is audited (never its note); the audit rows come last.
 */
export async function sendInvitations(
  pool: Pool,
  viewer: Viewer,
  number: string,
  request: InvitationRequest,
  resolveRoles: ResolveAssigneeRoles,
): Promise<SendInvitationsResult> {
  const early = challengeRefusal(await loadInvitationChallenge(pool, viewer, number));
  if (early) return early;

  return inTransaction(pool, async (client): Promise<SendInvitationsResult> => {
    await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`invitation_send:${viewer.userId}`]);
    const challenge = await loadInvitationChallenge(client, viewer, number, true);
    const refused = challengeRefusal(challenge);
    if (refused || !challenge) return refused ?? { status: "not_found" };

    const exclude = new Set([viewer.userId.toLowerCase(), ...(await pickerExclusions(client, viewer, challenge)).map((id) => id.toLowerCase())]);
    const { rows: active } = await client.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and active and scrubbed_at is null`, [
      request.userIds,
    ]);
    const activeIds = new Set(active.map((r) => r.id.toLowerCase()));
    for (const userId of request.userIds) {
      if (exclude.has(userId) || !activeIds.has(userId)) return { status: "ineligible" };
      if (!canSeeChallenge({ userId, roles: await resolveRoles(userId) }, challenge.visibility)) return { status: "ineligible" };
    }

    const already = (await sentOnChallenge(client, challenge.id, viewer.userId)).length;
    const cap = invitationCapRefusal(request.userIds.length, already, await sentToday(client, viewer.userId));
    if (cap) return { status: cap };

    await client.query(
      `insert into challenge_invitations (challenge_id, inviter_id, invitee_id, note)
       select $1, $2, u, $3 from unnest($4::uuid[]) as u`,
      [challenge.id, viewer.userId, request.note, request.userIds],
    );
    for (const inviteeId of request.userIds) {
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "invitation.sent",
        targetType: "challenge",
        targetId: challenge.id,
        after: { inviteeId, withNote: request.note !== null },
      });
    }
    return {
      status: "ok",
      challengeId: challenge.id,
      sent: request.userIds.length,
      invitations: await sentBlock(client, challenge.id, viewer.userId),
      created: request.userIds.map((inviteeId) => ({ inviteeId, note: request.note })),
    };
  });
}

// ── Not for me (POST /api/challenges/:number/invitations/dismiss) ────────────────────────

export type DismissInvitationsResult = { status: "ok" } | { status: "not_found" } | { status: "trashed" } | { status: "no_invitation" };

/**
 * §40.3: the invitee's quiet decline. Writes the dismissal (a repeat writes nothing new), marks their
 * unread event-22 rows about the challenge read, and tells nobody. Later invitations to it are still
 * recorded but write no event 22 (§40.6). A preference, so not audited.
 */
export async function dismissInvitations(pool: Pool, viewer: Viewer, number: string): Promise<DismissInvitationsResult> {
  const challenge = await loadInvitationChallenge(pool, viewer, number);
  if (!challenge) return { status: "not_found" };
  if (challenge.trashed) return { status: "trashed" };
  const { rows } = await pool.query(`select 1 from challenge_invitations where challenge_id = $1 and invitee_id = $2 limit 1`, [challenge.id, viewer.userId]);
  if (rows.length === 0) return { status: "no_invitation" };
  await inTransaction(pool, async (client) => {
    await client.query(`insert into challenge_invitation_dismissals (challenge_id, user_id) values ($1, $2) on conflict do nothing`, [challenge.id, viewer.userId]);
    await client.query(
      `update notifications set read_at = now()
        where user_id = $1 and type = 'invitation' and read_at is null and challenge_id = $2::uuid`,
      [viewer.userId, challenge.id],
    );
  });
  return { status: "ok" };
}

// ── The detail payload (§40.11) ──────────────────────────────────────────────────────────

/**
 * §40.3: the viewer's OPEN invitations to a challenge, newest first — none once they dismissed it;
 * otherwise those no solution of theirs answers yet (one they were on the team of from the create,
 * created after the invitation — `isAnswered`).
 */
async function openInvitations(db: Db, challengeId: string, inviteeId: string): Promise<InvitedBy[]> {
  const { rows: dismissed } = await db.query(`select 1 from challenge_invitation_dismissals where challenge_id = $1 and user_id = $2`, [challengeId, inviteeId]);
  if (dismissed.length > 0) return [];
  const { rows } = await db.query<{ id: string; display_name: string; active: boolean; note: string | null; created_at: Date }>(
    `select i.inviter_id as id, u.display_name, u.active, i.note, i.created_at
       from challenge_invitations i join users u on u.id = i.inviter_id
      where i.challenge_id = $1 and i.invitee_id = $2
      order by i.created_at desc, i.id desc`,
    [challengeId, inviteeId],
  );
  if (rows.length === 0) return [];
  const { rows: answers } = await db.query<{ created_at: Date }>(
    `select s.created_at from solutions s where s.challenge_id = $1 and ${memberFromCreateSql("s", "$2::uuid")}`,
    [challengeId, inviteeId],
  );
  const answeredAt = answers.map((a) => a.created_at);
  return rows
    .filter((r) => !isAnswered(r.created_at, answeredAt))
    .map((r) => ({ id: r.id, displayName: r.display_name, active: r.active, note: r.note, invitedAt: r.created_at.toISOString() }));
}

/**
 * The §40 fields for a challenge detail the viewer is already allowed to see. `canInvite` is the
 * challenge half of `canPropose` — `valid`, namespace not archived, not trashed — and both blocks are
 * null while the challenge does not accept solutions: the button and the banner then simply go
 * (§40.8), and the invitations stay.
 */
export async function invitationDetailFields(db: Db, viewer: Viewer, detail: { id: string; canPropose: boolean }): Promise<InvitationDetailFields> {
  if (!detail.canPropose) return { canInvite: false, invitations: null, invited: null };
  const [invitations, inviters] = await Promise.all([sentBlock(db, detail.id, viewer.userId), openInvitations(db, detail.id, viewer.userId)]);
  return { canInvite: true, invitations, invited: inviters.length > 0 ? { inviters } : null };
}
