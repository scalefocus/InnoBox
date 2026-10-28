// §40.5 — when an invitation to propose a solution pays off (INNOBOX_SPEC.md §40.5, §40.7). Called
// INSIDE the transaction that moves a solution out of `proposed` — an enforced move, an admin
// override, the author's withdrawal, the §8.3 auto-close of a sibling — or that self-reveals it,
// after that action's own audit row (the one lock order: audit chain first, then the awards'
// per-recipient lock). It stamps each invitation the solution pays off, once, and hands back the
// 0-point `invite_fulfilled` awards for the caller to write with its own, plus the event-23 notices
// to send after the commit.
//
// An invitation pays off when a solution ANSWERS it — on its challenge, created after it, with the
// invitee on the team from the create — and the solution, at that moment, has left `proposed` (so
// the inviter may see it, §4.3), is not anonymous (invariant 3) and does not have the inviter on its
// team. Every inviter of that person is credited; `paid_off_at is null` keeps it once per invitation.
// Relative imports only (no `@/`) so the gated dbtests can load the stores that call this.
import type { PoolClient } from "pg";
import { awardKey, type AwardInput } from "@innobox/shared";

/**
 * SQL boolean: `user` was on solution `alias`'s team FROM THE CREATE — its creator, or a co-author
 * named on the §6.2 form, whose add the create audits as `solution.author_added` with `via: "submit"`
 * (§39.13). Someone who joined later through the Team panel never counts (§40.3).
 */
export function memberFromCreateSql(alias: string, user: string): string {
  return `(${alias}.author_id = ${user}
           or exists (select 1 from audit_log fa
                       where fa.target_type = 'solution' and fa.target_id = ${alias}.id::text
                         and fa.action = 'solution.author_added' and fa.after->>'via' = 'submit'
                         and fa.after->>'userId' = (${user})::text))`;
}

/** One invitation the solution paid off — what event 23 needs after the commit. */
export interface InvitationPayoff {
  invitationId: string;
  challengeId: string;
  solutionId: string;
  inviterId: string;
  inviteeId: string;
}

export interface PayoffOutcome {
  payoffs: InvitationPayoff[];
  /** The inviters' 0-point `invite_fulfilled` rows — the caller writes them with its own awards, so
   *  one transaction still writes one event-13 row per person. */
  awards: AwardInput[];
}

const NONE: PayoffOutcome = { payoffs: [], awards: [] };

/** §40.5: counts every invitation `solutionId` pays off, now. A no-op unless the solution is out of
 *  `proposed` and named — the self-reveal of one still `proposed` counts on its first move out. */
export async function recordInvitationPayoffs(client: PoolClient, solutionId: string): Promise<PayoffOutcome> {
  const { rows } = await client.query<{ id: string; challenge_id: string; inviter_id: string; invitee_id: string }>(
    `update challenge_invitations i
        set paid_off_at = now(), paid_off_solution_id = s.id
       from solutions s
      where s.id = $1
        and i.challenge_id = s.challenge_id
        and i.paid_off_at is null
        and i.created_at < s.created_at
        and not s.is_anonymous
        and s.status <> 'proposed'
        and ${memberFromCreateSql("s", "i.invitee_id")}
        and not exists (select 1 from solution_authors sa where sa.solution_id = s.id and sa.user_id = i.inviter_id)
      returning i.id::text as id, i.challenge_id, i.inviter_id, i.invitee_id`,
    [solutionId],
  );
  if (rows.length === 0) return NONE;
  // The payoff's moment is the solution's first move out of `proposed` — this transaction's own, or,
  // when it lands at a self-reveal, the earlier one (the §23.2 replay rule).
  const { rows: exits } = await client.query<{ at: Date | null }>(
    `select min(created_at) as at from audit_log
      where target_type = 'solution' and target_id = $1 and action = 'solution.status_changed' and before->>'status' = 'proposed'`,
    [solutionId],
  );
  const occurredAt = exits[0]?.at ?? new Date();
  return {
    payoffs: rows.map((r) => ({ invitationId: r.id, challengeId: r.challenge_id, solutionId, inviterId: r.inviter_id, inviteeId: r.invitee_id })),
    awards: rows.map((r) => ({
      userId: r.inviter_id,
      reason: "invite_fulfilled" as const,
      itemType: "solution" as const,
      itemId: solutionId,
      awardKey: awardKey.inviteFulfilled(r.challenge_id, r.invitee_id, r.inviter_id),
      // §40.7: the inviter acted in the browser — an invitation cannot be sent through an agent — so
      // the row is never `via_mcp`, even when the solution was proposed through one.
      viaMcp: false,
      occurredAt,
    })),
  };
}
