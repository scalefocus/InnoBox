// The Entra reconciliation pass (ENTRA_AUTH_SPEC.md §5): leader-only safety net behind
// SCIM push. TENANT-based, not app-assignment-based — sign-in is open to the tenant, so
// a JIT user who was never assigned to the provisioning app must not be "healed" into
// deactivation; only tenant-gone/disabled accounts are. Every Graph failure is logged
// (structured JSON) and audited as scim.anomaly, then the pass CONTINUES with the next
// item — a partial pass must never abort. DB failures do propagate; the caller wraps
// each scheduled run. Actor is null (system) on every audit entry, per spec §15.
//
// The FIRST DIRECTORY SYNC (INNOBOX_SPEC.md §3, runFirstSync below) runs the pass's per-user step
// once, early, for each new row, so a new colleague's directory profile and photo do not wait
// for the hourly pass. It shares refreshUser with the pass; it never deactivates, and its Graph
// failures are logged but not audited.
import { appendAudit, bindPendingAccess, revokeUserGrants, type DbClient, type DbPool } from "@innobox/shared";
import {
  computeFirstSyncHeal,
  computeMembershipDiff,
  computeUserHeal,
  type GraphUser,
  type LocalUserAttrs,
  type UserFieldPatch,
} from "./diff.js";
import { createGraphClient, GraphRequestError, type GraphClient, type GraphEnv, type GraphGroup } from "./graph.js";

/** §3: how long a new row stays the first sync's — and out of the hourly pass's user list. */
export const FIRST_SYNC_WINDOW_MINUTES = 5;
/** §3: rows one first-sync sweep takes, newest first. */
export const FIRST_SYNC_BATCH = 20;

/** `users` predicate: the row is new and no pass has read it yet. Built from a constant only. */
const IN_FIRST_SYNC_WINDOW = `first_synced_at is null and created_at > now() - interval '${FIRST_SYNC_WINDOW_MINUTES} minutes'`;

const USER_COLUMNS =
  "id, external_id, user_name, display_name, email, department, job_title, office_location, photo_etag, first_synced_at";

export interface ReconciliationSummary {
  usersChecked: number;
  deactivated: number;
  refreshed: number;
  groupsSynced: number;
  membershipAdds: number;
  membershipRemoves: number;
  errors: number;
}

interface ActiveUserRow {
  id: string;
  external_id: string;
  user_name: string;
  display_name: string;
  email: string | null;
  department: string | null;
  job_title: string | null;
  office_location: string | null;
  photo_etag: string | null;
  first_synced_at: Date | null;
}

export interface FirstSyncSummary {
  /** Rows the sweep picked up. */
  taken: number;
  /** Rows read from Graph without a failure, and stamped. */
  synced: number;
  /** Rows whose attributes or photo changed (audited `recon.user_refreshed`). */
  refreshed: number;
  /** Rows Graph reported missing or disabled — left untouched for the hourly pass. */
  absent: number;
  /** Graph failures; the row stays pending and is retried while inside the window. */
  errors: number;
}

interface GroupRow {
  id: string;
  external_id: string;
  display_name: string;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
}

/** Runs `fn` in one transaction when `pool` can hand out a client; a bare client (a test's, or a
 *  caller's own transaction) runs it as is. */
async function atomically(pool: DbClient, fn: (db: DbClient) => Promise<void>): Promise<void> {
  const connect = (pool as Partial<DbPool>).connect;
  if (!connect) return fn(pool);
  const client = await connect.call(pool);
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function localAttrs(u: ActiveUserRow): LocalUserAttrs {
  return {
    userName: u.user_name,
    displayName: u.display_name,
    email: u.email,
    department: u.department,
    jobTitle: u.job_title,
    officeLocation: u.office_location,
  };
}

function errorText(err: unknown): string {
  return String((err as Error).message ?? err).slice(0, 500);
}

/** A present, enabled user's decision from diff.ts — never the deactivate / absent branch. */
type LiveHeal = { action: "refresh"; patch: UserFieldPatch } | { action: "none" };

/**
 * Step 1 for one user Graph reports as present and enabled: write the drifted attributes, sync
 * the photo by etag, and audit `recon.user_refreshed` when anything changed. The hourly pass and
 * the first directory sync both call this, so the two cannot drift apart (INNOBOX_SPEC.md §3).
 * A photo failure is returned, not thrown: the attribute refresh before it stands and is audited,
 * and each caller reports the failure its own way.
 */
async function refreshUser(
  pool: DbClient,
  graph: GraphClient,
  u: ActiveUserRow,
  heal: LiveHeal,
): Promise<{ refreshed: boolean; photoFailure: { error: unknown } | null }> {
  let before: Record<string, unknown> | undefined;
  if (heal.action === "refresh") {
    // Column names come from the fixed UserFieldPatch key set, never from input.
    // scim_synced is deliberately untouched: recon refreshes attributes but a JIT stub
    // (scim_synced=false) stays claims-refreshable until SCIM itself writes it.
    const cols = Object.keys(heal.patch) as (keyof UserFieldPatch)[];
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
    await pool.query(`update users set ${sets}, updated_at = now() where id = $1`, [
      u.id,
      ...cols.map((c) => heal.patch[c] ?? null),
    ]);
    // §4.3: a changed address or user name may match a pending access-list entry.
    if (heal.patch.email !== undefined || heal.patch.user_name !== undefined) await bindPendingAccess(pool, u.id);
    const current: Record<keyof UserFieldPatch, unknown> = {
      user_name: u.user_name,
      display_name: u.display_name,
      email: u.email,
      department: u.department,
      job_title: u.job_title,
      office_location: u.office_location,
    };
    before = {};
    for (const c of cols) before[c] = current[c];
  }

  let photo: "updated" | "removed" | null = null;
  let photoFailure: { error: unknown } | null = null;
  try {
    const p = await graph.getUserPhoto240(u.external_id, u.photo_etag);
    if (p.changed) {
      photo = p.bytes ? "updated" : "removed";
      await pool.query(`update users set photo = $2, photo_etag = $3, updated_at = now() where id = $1`, [
        u.id,
        p.bytes ?? null,
        p.etag ?? null,
      ]);
    }
  } catch (error) {
    photoFailure = { error };
  }

  const refreshed = heal.action === "refresh" || photo !== null;
  if (refreshed) {
    await appendAudit(pool, {
      actorUserId: null,
      action: "recon.user_refreshed",
      targetType: "user",
      targetId: u.id,
      before,
      after: { ...(heal.action === "refresh" ? heal.patch : {}), ...(photo !== null ? { photo } : {}) },
    });
  }
  return { refreshed, photoFailure };
}

/** Records the row's first successful Graph read (INNOBOX_SPEC.md §3). Guarded on NULL, so a row
 *  the other path reached first keeps its original instant. `updated_at` is left alone — this is
 *  bookkeeping, not a change to the user. */
async function stampFirstSync(pool: DbClient, userId: string): Promise<void> {
  await pool.query(`update users set first_synced_at = now() where id = $1 and first_synced_at is null`, [userId]);
}

/**
 * One first-directory-sync sweep (INNOBOX_SPEC.md §3): up to FIRST_SYNC_BATCH new rows no pass has
 * read yet, newest first — the person who signed in a moment ago goes ahead of a bulk SCIM load.
 * Each gets the pass's step 1 (refreshUser) and, on success, its `first_synced_at` stamp.
 *
 * It NEVER deactivates: a missing or disabled account is left unchanged and unstamped for the
 * hourly pass, because an account created minutes ago may not be readable through Graph yet. A
 * Graph failure is logged, NOT audited (the hourly pass already audits a persistent one as
 * `scim.anomaly`), leaves the row pending for the next sweep, and never stops the sweep.
 */
export async function runFirstSync(pool: DbClient, graph: GraphClient): Promise<FirstSyncSummary> {
  const summary: FirstSyncSummary = { taken: 0, synced: 0, refreshed: 0, absent: 0, errors: 0 };
  const { rows } = await pool.query(
    `select ${USER_COLUMNS}
       from users
      where active = true and scrubbed_at is null and ${IN_FIRST_SYNC_WINDOW}
      order by created_at desc, id
      limit $1`,
    [FIRST_SYNC_BATCH],
  );

  for (const u of rows as ActiveUserRow[]) {
    summary.taken += 1;
    const failed = (err: unknown): void => {
      summary.errors += 1;
      log("warn", "first directory sync graph failure", { userId: u.id, error: errorText(err) });
    };

    let gu: GraphUser;
    try {
      gu = await graph.getUser(u.external_id);
    } catch (err) {
      failed(err);
      continue;
    }

    const heal = computeFirstSyncHeal(localAttrs(u), gu);
    if (heal.action === "absent") {
      summary.absent += 1;
      continue;
    }

    const { refreshed, photoFailure } = await refreshUser(pool, graph, u, heal);
    if (refreshed) summary.refreshed += 1;
    if (photoFailure) {
      failed(photoFailure.error);
      continue;
    }
    await stampFirstSync(pool, u.id);
    summary.synced += 1;
  }
  return summary;
}

export async function runReconciliation(
  pool: DbClient,
  graphEnv: GraphEnv,
  opts: { bootstrapAdminGroup?: string; graphClient?: GraphClient } = {},
): Promise<ReconciliationSummary> {
  const graph = opts.graphClient ?? createGraphClient(graphEnv);
  const summary: ReconciliationSummary = {
    usersChecked: 0,
    deactivated: 0,
    refreshed: 0,
    groupsSynced: 0,
    membershipAdds: 0,
    membershipRemoves: 0,
    errors: 0,
  };

  async function anomaly(targetType: "user" | "group", targetId: string, err: unknown): Promise<void> {
    summary.errors += 1;
    const error = errorText(err);
    log("error", "reconciliation graph failure", { targetType, targetId, error });
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.anomaly",
      targetType,
      targetId,
      after: { phase: "reconciliation", error },
    });
  }

  // ── Pass 1: every local active user vs the tenant ────────────────────────────────────
  // §3: a row still inside the first-sync window is left out — the first directory sync runs
  // alongside this pass, and no row may be handled by both at once. If that sync never completes
  // for a row, the row has aged out of the window by the next pass, which takes it then.
  const { rows: activeUsers } = await pool.query(
    `select ${USER_COLUMNS}
       from users
      where active = true and scrubbed_at is null and not (${IN_FIRST_SYNC_WINDOW})
      order by external_id`,
  );

  for (const u of activeUsers as ActiveUserRow[]) {
    summary.usersChecked += 1;
    let gu: GraphUser;
    try {
      gu = await graph.getUser(u.external_id);
    } catch (err) {
      await anomaly("user", u.external_id, err);
      continue;
    }

    const heal = computeUserHeal(localAttrs(u), gu);

    if (heal.action === "deactivate") {
      // §3.1: drop the cached photo on deactivation — the user renders as a greyed initials
      // bubble thereafter, and no stale face lingers in the avatar gateway.
      // §25.3 leavers: the deactivation, its audit row and the revocation of every AI agent grant
      // and token commit together.
      await atomically(pool, async (db) => {
        await db.query(
          `update users set active = false, deactivated_at = now(), photo = null, photo_etag = null, updated_at = now()
            where id = $1 and active = true`,
          [u.id],
        );
        await appendAudit(db, {
          actorUserId: null,
          action: "recon.user_deactivated",
          targetType: "user",
          targetId: u.id,
          before: { active: true },
          after: { active: false, reason: gu.exists ? "accountDisabled" : "missingInTenant" },
        });
        await revokeUserGrants(db, u.id, "deactivated");
      });
      summary.deactivated += 1;
      log("info", "reconciliation deactivated user", { userId: u.id });
      continue;
    }

    const { refreshed, photoFailure } = await refreshUser(pool, graph, u, heal);
    if (refreshed) summary.refreshed += 1;
    if (photoFailure) await anomaly("user", u.external_id, photoFailure.error);
    // §3: the first Graph read that went through end to end stamps the marker, so it stays
    // truthful for rows this pass reached before (or instead of) the first directory sync.
    else if (u.first_synced_at === null) await stampFirstSync(pool, u.id);
  }

  // ── Pass 2: group set = local groups ∪ role_mappings targets ∪ bootstrap group ───────
  const { rows: groupRows } = await pool.query(`select id, external_id, display_name from groups`);
  const localGroups = groupRows as GroupRow[];
  const { rows: mappingRows } = await pool.query(`select distinct group_external_id from role_mappings`);

  const groupIds = new Set<string>(localGroups.map((g) => g.external_id));
  for (const m of mappingRows as { group_external_id: string }[]) groupIds.add(m.group_external_id);
  if (opts.bootstrapAdminGroup) groupIds.add(opts.bootstrapAdminGroup);

  const localByExternalId = new Map(localGroups.map((g) => [g.external_id, g]));

  for (const gid of groupIds) {
    let local = localByExternalId.get(gid);

    let memberOids: string[];
    try {
      memberOids = await graph.listGroupMembers(gid);
    } catch (err) {
      if (err instanceof GraphRequestError && err.status === 404) {
        if (local) {
          // Gone in Entra: drop the mirror (memberships cascade). role_mappings rows
          // survive and surface as "dead" in the admin UI, per spec §5.
          await pool.query(`delete from groups where id = $1`, [local.id]);
          await appendAudit(pool, {
            actorUserId: null,
            action: "recon.group_deleted",
            targetType: "group",
            targetId: local.id,
            before: { externalId: gid, displayName: local.display_name },
          });
          log("info", "reconciliation deleted group gone in Entra", { groupExternalId: gid });
        } else {
          // Mapped/bootstrap group that never existed in Entra — a dead mapping; nothing
          // local to heal and the admin UI flags it.
          log("warn", "reconciliation: mapped group not found in Entra", { groupExternalId: gid });
        }
        continue;
      }
      await anomaly("group", gid, err);
      continue;
    }

    // Mapped-but-unknown group: mirror it locally so membership (and thus roles) resolve
    // before any SCIM assignment — this is what makes the bootstrap admin group work
    // from worker boot.
    if (!local) {
      let g: GraphGroup;
      try {
        g = await graph.getGroup(gid);
      } catch (err) {
        await anomaly("group", gid, err);
        continue;
      }
      if (!g.exists) {
        log("warn", "reconciliation: mapped group not found in Entra", { groupExternalId: gid });
        continue;
      }
      const { rows } = await pool.query(
        `insert into groups (external_id, display_name) values ($1, $2)
           on conflict (external_id) do update set display_name = excluded.display_name, updated_at = now()
         returning id, display_name`,
        [gid, g.displayName],
      );
      local = { id: rows[0].id as string, external_id: gid, display_name: rows[0].display_name as string };
      await appendAudit(pool, {
        actorUserId: null,
        action: "scim.group_created",
        targetType: "group",
        targetId: local.id,
        after: { externalId: gid, displayName: g.displayName, via: "reconciliation" },
      });
    }

    const { rows: memberRows } = await pool.query(
      `select u.id, u.external_id
         from group_members gm
         join users u on u.id = gm.user_id
        where gm.group_id = $1`,
      [local.id],
    );
    const localMembers = memberRows as { id: string; external_id: string }[];
    const diff = computeMembershipDiff(
      localMembers.map((m) => m.external_id),
      memberOids,
    );

    let adds = 0;
    for (const oid of diff.add) {
      try {
        let userId: string | undefined = (
          await pool.query(`select id from users where external_id = $1`, [oid])
        ).rows[0]?.id;
        if (!userId) {
          // Unknown member: JIT-grade stub, active accounts only — a disabled/gone
          // account must not enter via a membership race.
          const gu = await graph.getUser(oid);
          if (!gu.exists || !gu.accountEnabled) continue;
          const { rows } = await pool.query(
            `insert into users (external_id, user_name, email, display_name, department, job_title, office_location)
               values ($1, $2, $3, $4, $5, $6, $7)
               on conflict (external_id) do nothing
             returning id`,
            [oid, gu.userPrincipalName, gu.mail, gu.displayName, gu.department, gu.jobTitle, gu.officeLocation],
          );
          userId = rows[0]?.id ?? (await pool.query(`select id from users where external_id = $1`, [oid])).rows[0]?.id;
          if (!userId) continue;
          await bindPendingAccess(pool, userId); // §4.3
          await appendAudit(pool, {
            actorUserId: null,
            action: "user.jit_created",
            targetType: "user",
            targetId: userId,
            after: { externalId: oid, userName: gu.userPrincipalName, via: "reconciliation" },
          });
        }
        const res = await pool.query(
          `insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing`,
          [local.id, userId],
        );
        if ((res.rowCount ?? 0) > 0) adds += 1;
      } catch (err) {
        await anomaly("user", oid, err);
      }
    }

    let removes = 0;
    if (diff.remove.length > 0) {
      const res = await pool.query(
        `delete from group_members gm
          using users u
          where gm.group_id = $1 and gm.user_id = u.id and u.external_id = any($2)`,
        [local.id, diff.remove],
      );
      removes = res.rowCount ?? 0;
    }

    if (adds > 0 || removes > 0) {
      await appendAudit(pool, {
        actorUserId: null,
        action: "recon.membership_healed",
        targetType: "group",
        targetId: local.id,
        after: { externalId: gid, adds, removes },
      });
    }
    summary.groupsSynced += 1;
    summary.membershipAdds += adds;
    summary.membershipRemoves += removes;
  }

  log("info", "reconciliation pass complete", { ...summary });
  return summary;
}
