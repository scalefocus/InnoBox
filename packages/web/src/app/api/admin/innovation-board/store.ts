// Data layer for the innovation board (INNOBOX_SPEC.md §45.2, §45.10): the roster a platform admin
// keeps on Platform settings — list, add (up to 20 people at a time, all-or-nothing, at most 100 on
// the board) and remove — and the two facts `me` carries (is the caller a member, does the board
// have anyone on it). The roster is returned to platform admins only (the routes gate it); nothing
// else in the app says who is on the board (§45.7). Every add and removal is audited, one row per
// person. Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under plain node.
import type { Pool, PoolClient } from "pg";
import { INNOVATION_BOARD_MAX } from "@innobox/shared";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";

type Db = Pool | PoolClient;

export interface BoardMemberView {
  user: { id: string; displayName: string; email: string | null; active: boolean };
  addedAt: string;
  /** Null once the admin who added them has been erased (§45.8). */
  addedBy: { id: string; displayName: string } | null;
}

/** The roster, in name order (§45.2). A deactivated member stays on it and is flagged. */
export async function listBoardMembers(db: Db): Promise<BoardMemberView[]> {
  const { rows } = await db.query<{
    user_id: string;
    display_name: string;
    email: string | null;
    active: boolean;
    added_at: Date;
    added_by: string | null;
    added_by_name: string | null;
  }>(
    `select m.user_id, u.display_name, u.email, u.active, m.added_at, m.added_by, a.display_name as added_by_name
       from innovation_board_members m
       join users u on u.id = m.user_id
       left join users a on a.id = m.added_by
      order by lower(u.display_name), m.user_id`,
  );
  return rows.map((r) => ({
    user: { id: r.user_id, displayName: r.display_name, email: r.email, active: r.active },
    addedAt: r.added_at.toISOString(),
    addedBy: r.added_by && r.added_by_name !== null ? { id: r.added_by, displayName: r.added_by_name } : null,
  }));
}

export type AddBoardMembersResult =
  | { status: "ok"; added: string[] }
  /** An id that names no active, not-erased user — the whole call is refused (→ 422). */
  | { status: "ineligible" }
  /** The add would take the board past INNOVATION_BOARD_MAX (→ 409). */
  | { status: "full" };

/**
 * §45.10: add people to the board, all-or-nothing. Everyone must be an active, not-erased user; a
 * person already on the board is skipped. The cap check and the inserts run under one
 * transaction-scoped advisory lock, so two concurrent adds cannot both take the last place.
 * Returns the people actually added — the ones event 28 is for.
 */
export async function addBoardMembers(pool: Pool, actorUserId: string, userIds: readonly string[]): Promise<AddBoardMembersResult> {
  return inTransaction(pool, async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('innobox.innovation_board.cap'))`);
    const { rows: eligible } = await client.query<{ id: string }>(`select id from users where id = any($1::uuid[]) and active and scrubbed_at is null`, [userIds]);
    if (eligible.length !== userIds.length) return { status: "ineligible" as const };
    const { rows: existing } = await client.query<{ user_id: string }>(`select user_id from innovation_board_members where user_id = any($1::uuid[])`, [userIds]);
    const onBoard = new Set(existing.map((r) => r.user_id));
    const fresh = userIds.filter((id) => !onBoard.has(id));
    const { rows: count } = await client.query<{ n: number }>(`select count(*)::int as n from innovation_board_members`);
    if ((count[0]?.n ?? 0) + fresh.length > INNOVATION_BOARD_MAX) return { status: "full" as const };
    for (const userId of fresh) {
      await client.query(`insert into innovation_board_members (user_id, added_by) values ($1, $2)`, [userId, actorUserId]);
      await appendAudit(client, { actorUserId, action: "innovation_board.member_added", targetType: "user", targetId: userId });
    }
    return { status: "ok" as const, added: fresh };
  });
}

/** §45.10: take one person off the board. Silent for them — a removal writes no notification. */
export async function removeBoardMember(pool: Pool, actorUserId: string, userId: string): Promise<"ok" | "not_found"> {
  return inTransaction(pool, async (client) => {
    const { rowCount } = await client.query(`delete from innovation_board_members where user_id = $1`, [userId]);
    if (!rowCount) return "not_found" as const;
    await appendAudit(client, { actorUserId, action: "innovation_board.member_removed", targetType: "user", targetId: userId });
    return "ok" as const;
  });
}

/** §45.7: whether the board has at least one ACTIVE member — what makes the submit forms say that
 *  the board can read a submission. A bare boolean: it names nobody. */
export async function boardHasActiveMember(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ active: boolean }>(
    `select exists (
       select 1 from innovation_board_members m
         join users u on u.id = m.user_id and u.active and u.scrubbed_at is null
     ) as active`,
  );
  return rows[0]?.active === true;
}
