// The Entra reconciliation pass (ENTRA_AUTH_SPEC.md §5): leader-only safety net behind
// SCIM push. TENANT-based, not app-assignment-based — sign-in is open to the tenant, so
// a JIT user who was never assigned to the provisioning app must not be "healed" into
// deactivation; only tenant-gone/disabled accounts are. Every Graph failure is logged
// (structured JSON) and audited as scim.anomaly, then the pass CONTINUES with the next
// item — a partial pass must never abort. DB failures do propagate; the caller wraps
// each scheduled run. Actor is null (system) on every audit entry, per spec §15.
import { appendAudit, type DbClient } from "@innobox/shared";
import { computeMembershipDiff, computeUserHeal, type GraphUser, type UserFieldPatch } from "./diff.js";
import { createGraphClient, GraphRequestError, type GraphClient, type GraphEnv, type GraphGroup } from "./graph.js";

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
}

interface GroupRow {
  id: string;
  external_id: string;
  display_name: string;
}

function log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, ...extra }));
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
    const error = String((err as Error).message ?? err).slice(0, 500);
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
  const { rows: activeUsers } = await pool.query(
    `select id, external_id, user_name, display_name, email, department, job_title, office_location, photo_etag
       from users
      where active = true and scrubbed_at is null
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

    const heal = computeUserHeal(
      {
        userName: u.user_name,
        displayName: u.display_name,
        email: u.email,
        department: u.department,
        jobTitle: u.job_title,
        officeLocation: u.office_location,
      },
      gu,
    );

    if (heal.action === "deactivate") {
      // §3.1: drop the cached photo on deactivation — the user renders as a greyed initials
      // bubble thereafter, and no stale face lingers in the avatar gateway.
      await pool.query(
        `update users set active = false, deactivated_at = now(), photo = null, photo_etag = null, updated_at = now()
          where id = $1 and active = true`,
        [u.id],
      );
      await appendAudit(pool, {
        actorUserId: null,
        action: "recon.user_deactivated",
        targetType: "user",
        targetId: u.id,
        before: { active: true },
        after: { active: false, reason: gu.exists ? "accountDisabled" : "missingInTenant" },
      });
      summary.deactivated += 1;
      log("info", "reconciliation deactivated user", { userId: u.id });
      continue;
    }

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
    } catch (err) {
      await anomaly("user", u.external_id, err);
    }

    if (heal.action === "refresh" || photo !== null) {
      summary.refreshed += 1;
      await appendAudit(pool, {
        actorUserId: null,
        action: "recon.user_refreshed",
        targetType: "user",
        targetId: u.id,
        before,
        after: { ...(heal.action === "refresh" ? heal.patch : {}), ...(photo !== null ? { photo } : {}) },
      });
    }
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
