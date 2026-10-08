// GDPR erasure — the optional successor for open assignments (INNOBOX_SPEC.md §3, §12.1 event
// 12, §15). Called from scrubUser (./store.ts) INSIDE the scrub transaction, so the hand-over
// and the de-identification commit or roll back together.
//
// What moves: every challenge the erased user is assignee of whose status is non-terminal,
// locked FOR UPDATE against a concurrent assignment, and only when the successor can see it
// under §4.3 (roles resolved from SCIM-synced membership, invariant 1 — never token claims).
// Each move is an ordinary §7.3 assignment change (applyChallengeAssigneeChange: assignee_id,
// updated_at, the auto-follow, one `challenge.assigned` audit row with the §7.3 before/after
// shape). Everything the successor cannot see is skipped and stays with "Deleted User".
// Authorship never moves — only the assignee role is handed over.
import type { PoolClient } from "pg";
import {
  CHALLENGE_TERMINAL_STATUSES,
  assignmentsTransferredMessage,
  canSeeChallenge,
  formatChallengeNumber,
  type ChallengeStatus,
  type RoleSet,
} from "@innobox/shared";
import { applyChallengeAssigneeChange } from "../challenges/store";
import { dispatchToUser, type NotifyContext } from "../../../lib/notify";

/** The successor named on an erasure, plus the role resolver for the §4.3 gate — injected so
 *  this module does not pull in the session layer (the route passes `resolveRolesForUser`). */
export interface SuccessorHandover {
  successorId: string;
  resolveRoles: (userId: string) => Promise<RoleSet>;
}

export interface ReassignedChallenge {
  /** Display number, e.g. "CH-12". */
  number: string;
  title: string;
}

/** The §16 `reassignment` response object. Titles are safe in it: the caller is a platform
 *  admin, who sees every item, and a title carries no author identity. */
export interface ReassignmentResult {
  successorId: string;
  moved: ReassignedChallenge[];
  skipped: (ReassignedChallenge & { reason: "not_visible" })[];
}

/**
 * §3 successor rules: an ACTIVE, not-scrubbed user other than the one being erased. The row is
 * locked FOR SHARE so a concurrent erasure/deactivation of the successor cannot slip in between
 * this check and the moves. Runs before the scrub changes anything.
 */
export async function isEligibleSuccessor(client: PoolClient, successorId: string, erasedUserId: string): Promise<boolean> {
  if (successorId.toLowerCase() === erasedUserId.toLowerCase()) return false;
  const { rows } = await client.query(`select 1 from users where id = $1 and active = true and scrubbed_at is null for share`, [
    successorId,
  ]);
  return rows.length > 0;
}

/** Move the erased user's visible, non-terminal assignments to the successor. Lowest number first. */
export async function handOverOpenAssignments(
  client: PoolClient,
  adminUserId: string,
  erasedUserId: string,
  handover: SuccessorHandover,
): Promise<ReassignmentResult> {
  const { rows } = await client.query<{
    id: string;
    number: string;
    title: string;
    namespace_id: string;
    visibility: "org" | "namespace";
    status: ChallengeStatus;
    author_id: string;
    assignee_id: string;
  }>(
    `select id, number::text as number, title, namespace_id, visibility, status, author_id, assignee_id
       from challenges
      where assignee_id = $1 and status::text <> all($2::text[])
      order by challenges.number
        for update`,
    [erasedUserId, [...CHALLENGE_TERMINAL_STATUSES]],
  );

  const result: ReassignmentResult = { successorId: handover.successorId, moved: [], skipped: [] };
  if (rows.length === 0) return result;

  const successor = { userId: handover.successorId, roles: await handover.resolveRoles(handover.successorId) };
  for (const row of rows) {
    const item = { number: formatChallengeNumber(row.number), title: row.title };
    const visible = canSeeChallenge(successor, {
      namespaceId: row.namespace_id,
      visibility: row.visibility,
      status: row.status,
      authorId: row.author_id,
    });
    if (!visible) {
      result.skipped.push({ ...item, reason: "not_visible" });
      continue;
    }
    await applyChallengeAssigneeChange(client, { userId: adminUserId }, { id: row.id, assignee_id: row.assignee_id }, handover.successorId);
    result.moved.push(item);
  }
  return result;
}

/**
 * §12.1 event 12, AFTER commit: one summary item to the successor listing the moved challenges
 * (not one event-7 item per move). Nothing when nothing moved; nothing when the acting admin
 * named themselves (actors never notify themselves — dispatchToUser drops it). The erased user
 * is never notified and never named. Link: the lowest-numbered moved challenge.
 */
export async function notifyAssignmentsTransferred(ctx: NotifyContext, reassignment: ReassignmentResult): Promise<void> {
  if (reassignment.moved.length === 0) return;
  const numbers = reassignment.moved.map((m) => m.number);
  const lowest = numbers[0]!.replace(/\D/g, "");
  await dispatchToUser(ctx, reassignment.successorId, "assignments_transferred", {
    message: assignmentsTransferredMessage(numbers),
    link: `/challenges/${lowest}`,
    count: numbers.length,
    numbers,
  });
}
