// SCIM 2.0 server (ENTRA_AUTH_SPEC.md §5 layer 2): Entra's
// provisioning service pushes users/groups here. Mounted by the orchestrator at /scim/v2.
// Every write is an idempotent upsert keyed on externalId; nothing here ever 500s on a
// malformed-but-Entra-shaped payload — tolerant success or a SCIM 400/409/404, always in
// the SCIM error envelope, so a sync cycle is never quarantined by a single odd payload.
import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import type { Pool, PoolClient } from "pg";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendAudit, bindPendingAccess, revokeUserGrants } from "@innobox/shared";
import { InvalidFilterError, parseFilter, requireAttr, type FilterAttr } from "./filter.js";
import { normalizeGroupPatch, normalizeUserPatch } from "./patch.js";
import {
  parseGroupWrite,
  parseUserWrite,
  resourceTypes,
  schemas,
  scimError,
  scimListResponse,
  serviceProviderConfig,
  toScimGroup,
  toScimUser,
  type GroupRow,
  type ParsedUserWrite,
  type UserRow,
} from "./resources.js";

export interface CreateScimRouterOptions {
  /** The Entra "Secret Token" — compared in constant time, never logged. */
  bearerToken: string;
  /** §14.10: called on every request that passed the bearer check (the throttled
   *  `scim_last_request_at` stamper in production). Must not throw or block. */
  onAccepted?: () => void;
}

// ── auth ─────────────────────────────────────────────────────────────────────────────────

/** Fixed-length digest compare avoids leaking the expected token's length via timing, on
 *  top of the constant-time comparison itself. */
export function safeTokenEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>` (scheme case-insensitive, RFC 7235). The token must
 *  start with a non-space, so `\s+` and the capture never compete for the same characters —
 *  `\s+(.+)` backtracks quadratically on a header of many spaces (polynomial ReDoS). */
export function bearerAuth(bearerToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S.*)$/i.exec(header);
    const provided = match?.[1];
    if (!provided || !safeTokenEqual(provided, bearerToken)) {
      // Never log `header`/`provided` — not even in an error path.
      res.status(401).json(scimError(401, "Missing or invalid bearer token"));
      return;
    }
    next();
  };
}

// ── pagination ───────────────────────────────────────────────────────────────────────────

function pagination(req: Request): { startIndex: number; count: number } {
  const rawStart = Number(req.query.startIndex);
  const rawCount = Number(req.query.count);
  const startIndex = Number.isFinite(rawStart) && rawStart >= 1 ? Math.floor(rawStart) : 1;
  const count = Number.isFinite(rawCount) && rawCount >= 0 ? Math.min(Math.floor(rawCount), 200) : 100;
  return { startIndex, count };
}

/** Resource ids are server-assigned uuids. Anything else names no resource and must never reach a
 *  uuid column, where Postgres would reject it and the request would fall through to a 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isScimId(id: string | undefined): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

// ── DB access — users ────────────────────────────────────────────────────────────────────

async function findUserByExternalId(pool: Pool, externalId: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`select * from users where external_id = $1`, [externalId]);
  return rows[0] ?? null;
}

async function findUserByUserNameCI(pool: Pool, userName: string): Promise<UserRow | null> {
  const { rows } = await pool.query<UserRow>(`select * from users where lower(user_name) = lower($1)`, [userName]);
  return rows[0] ?? null;
}

async function findUserById(pool: Pool, id: string | undefined): Promise<UserRow | null> {
  if (!isScimId(id)) return null;
  const { rows } = await pool.query<UserRow>(`select * from users where id = $1`, [id]);
  return rows[0] ?? null;
}

// GDPR erasure (INNOBOX_SPEC.md §3): SCIM never writes to — or returns — a scrubbed row, so erased
// personal data cannot flow back from Entra. The lookups above still return such rows (the
// userName uniqueness checks must see them); each handler refuses them explicitly instead.
function isScrubbed(user: UserRow | null): user is UserRow & { scrubbed_at: Date | string } {
  return user !== null && user.scrubbed_at !== null;
}

/** Records a refused SCIM request on an erased row as `scim.anomaly` — the user id and the
 *  request only, never payload content (the payload would carry the erased personal data). */
async function auditScrubbedRefusal(pool: Pool, userId: string, request: string): Promise<void> {
  await appendAudit(pool, {
    actorUserId: null,
    action: "scim.anomaly",
    targetType: "user",
    targetId: userId,
    after: { reason: "scrubbed_user", request },
  });
}

// NOTE (§13.8): `office_location` is deliberately absent from every users write below. SCIM carries
// no office attribute, and reconciliation overwrites the directory profile unconditionally — adding
// the column here would wipe it on every sync cycle. scim.dbtest.ts pins that contract.
async function insertUser(pool: Pool, data: ParsedUserWrite & { externalId: string }): Promise<UserRow> {
  const userName = data.userName ?? data.email ?? data.externalId;
  const { rows } = await pool.query<UserRow>(
    `insert into users (external_id, user_name, email, display_name, department, job_title, active, scim_synced, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, true, now())
     returning *`,
    [data.externalId, userName, data.email, data.displayName, data.department, data.jobTitle, data.active],
  );
  // §4.3: a pending access-list entry for this address now names a user.
  await bindPendingAccess(pool, rows[0]!.id);
  return rows[0]!;
}

async function updateUserFull(pool: Pool | PoolClient, id: string, data: ParsedUserWrite & { externalId: string }): Promise<UserRow> {
  const userName = data.userName ?? data.email ?? data.externalId;
  const { rows } = await pool.query<UserRow>(
    `update users
        set external_id = $2, user_name = $3, email = $4, display_name = $5, department = $6, job_title = $7,
            active = $8,
            deactivated_at = case when $8 then null else coalesce(deactivated_at, now()) end,
            -- §3.1: drop the cached photo when going inactive (greyed initials bubble thereafter)
            photo = case when $8 then photo else null end,
            photo_etag = case when $8 then photo_etag else null end,
            scim_synced = true, updated_at = now()
      where id = $1
      returning *`,
    [id, data.externalId, userName, data.email, data.displayName, data.department, data.jobTitle, data.active],
  );
  await bindPendingAccess(pool, id); // §4.3: the address or user name may have changed
  return rows[0]!;
}

interface UserPatchValues {
  externalId: string;
  active: boolean;
  userName: string;
  email: string | null;
  displayName: string;
  department: string | null;
  jobTitle: string | null;
}

async function updateUserPatch(pool: Pool | PoolClient, id: string, v: UserPatchValues): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `update users
        set user_name = $2, email = $3, display_name = $4, department = $5, job_title = $6, active = $7,
            deactivated_at = case when $7 then null else coalesce(deactivated_at, now()) end,
            -- §3.1: drop the cached photo when going inactive (greyed initials bubble thereafter)
            photo = case when $7 then photo else null end,
            photo_etag = case when $7 then photo_etag else null end,
            external_id = $8,
            scim_synced = true, updated_at = now()
      where id = $1
      returning *`,
    [id, v.userName, v.email, v.displayName, v.department, v.jobTitle, v.active, v.externalId],
  );
  await bindPendingAccess(pool, id); // §4.3: the address or user name may have changed
  return rows[0]!;
}

async function deactivateUser(pool: Pool | PoolClient, id: string): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `update users
        set active = false, deactivated_at = coalesce(deactivated_at, now()),
            photo = null, photo_etag = null, -- §3.1: drop the cached photo on deactivation
            scim_synced = true, updated_at = now()
      where id = $1
      returning *`,
    [id],
  );
  return rows[0]!;
}

/** A users write, its audit row and — on deactivation — the §25.3 revocation of every AI agent grant
 *  and token, committed together: a leaver never keeps a live grant past the deactivation. */
async function atomically<T>(pool: Pool, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Compares before/after and files exactly the one most-specific audit event: an active
 *  flip wins over a plain attribute update (both being true at once doesn't happen in
 *  practice, but a flip is always the more meaningful fact to record). */
async function auditUserTransition(pool: Pool | PoolClient, before: UserRow, after: UserRow): Promise<void> {
  if (before.active && !after.active) {
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.user_deactivated",
      targetType: "user",
      targetId: after.id,
      before: { active: true },
      after: { active: false, deactivatedAt: isoOrNull(after.deactivated_at) },
    });
    // §25.3 leavers: every AI agent grant and token the person holds is revoked with them — the
    // callers run this inside the deactivation's transaction.
    await revokeUserGrants(pool, after.id, "deactivated");
    return;
  }
  if (!before.active && after.active) {
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.user_reactivated",
      targetType: "user",
      targetId: after.id,
      before: { active: false },
      after: { active: true },
    });
    return;
  }
  const changed =
    before.external_id !== after.external_id ||
    before.user_name !== after.user_name ||
    before.email !== after.email ||
    before.display_name !== after.display_name ||
    before.department !== after.department ||
    before.job_title !== after.job_title;
  if (!changed) return;
  await appendAudit(pool, {
    actorUserId: null,
    action: "scim.user_updated",
    targetType: "user",
    targetId: after.id,
    before: {
      externalId: before.external_id,
      userName: before.user_name,
      email: before.email,
      displayName: before.display_name,
      department: before.department,
      jobTitle: before.job_title,
    },
    after: {
      externalId: after.external_id,
      userName: after.user_name,
      email: after.email,
      displayName: after.display_name,
      department: after.department,
      jobTitle: after.job_title,
    },
  });
}

// ── DB access — groups ───────────────────────────────────────────────────────────────────

async function findGroupByExternalId(pool: Pool, externalId: string): Promise<GroupRow | null> {
  const { rows } = await pool.query<GroupRow>(`select * from groups where external_id = $1`, [externalId]);
  return rows[0] ?? null;
}

async function findGroupByDisplayNameCI(pool: Pool, displayName: string): Promise<GroupRow | null> {
  const { rows } = await pool.query<GroupRow>(`select * from groups where lower(display_name) = lower($1)`, [displayName]);
  return rows[0] ?? null;
}

async function findGroupById(pool: Pool, id: string | undefined): Promise<GroupRow | null> {
  if (!isScimId(id)) return null;
  const { rows } = await pool.query<GroupRow>(`select * from groups where id = $1`, [id]);
  return rows[0] ?? null;
}

async function insertGroup(pool: Pool, data: { externalId: string; displayName: string }): Promise<GroupRow> {
  const { rows } = await pool.query<GroupRow>(
    `insert into groups (external_id, display_name, scim_synced, updated_at) values ($1, $2, true, now()) returning *`,
    [data.externalId, data.displayName || data.externalId],
  );
  return rows[0]!;
}

async function renameGroup(pool: Pool, id: string, displayName: string): Promise<GroupRow> {
  const { rows } = await pool.query<GroupRow>(
    `update groups set display_name = $2, scim_synced = true, updated_at = now() where id = $1 returning *`,
    [id, displayName],
  );
  return rows[0]!;
}

/** §14.10: every SCIM group write (create / replace / patch) marks the row SCIM-provisioned and
 *  stamps `updated_at` — including a write that changes nothing else (a replayed POST, a
 *  membership-only PATCH), so `meta.lastModified` moves with every SCIM write (ENTRA_AUTH_SPEC.md
 *  §5). Reconciliation's mirroring never calls this, so it cannot mask missing group provisioning. */
async function markGroupScimSynced(pool: Pool, id: string): Promise<GroupRow> {
  const { rows } = await pool.query<GroupRow>(
    `update groups set scim_synced = true, updated_at = now() where id = $1 returning *`,
    [id],
  );
  return rows[0]!;
}

async function deleteGroupCascade(pool: Pool, id: string): Promise<void> {
  // group_members has ON DELETE CASCADE on group_id; role_mappings has no FK to groups at
  // all (it keys on group_external_id) so mappings survive and are flagged dead elsewhere.
  await pool.query(`delete from groups where id = $1`, [id]);
}

async function listGroupMemberIds(pool: Pool, groupId: string): Promise<string[]> {
  const { rows } = await pool.query<{ user_id: string }>(`select user_id from group_members where group_id = $1`, [groupId]);
  return rows.map((r) => r.user_id);
}

async function addGroupMember(pool: Pool, groupId: string, userId: string): Promise<void> {
  await pool.query(`insert into group_members (group_id, user_id) values ($1, $2) on conflict do nothing`, [groupId, userId]);
}

async function removeGroupMember(pool: Pool, groupId: string, userId: string): Promise<void> {
  await pool.query(`delete from group_members where group_id = $1 and user_id = $2`, [groupId, userId]);
}

/** A user a membership add may name: known and not erased (a scrubbed row counts as unknown). */
async function userExists(pool: Pool, userId: string): Promise<boolean> {
  if (!isScimId(userId)) return false; // a malformed member id is an unknown member, not a 500
  const { rows } = await pool.query(`select 1 from users where id = $1 and scrubbed_at is null`, [userId]);
  return rows.length > 0;
}

/** Adds members, tolerating ids that don't correspond to any locally-known user — Entra can
 *  send a membership PATCH before the member's own creation POST has landed. Unknown ids are
 *  skipped (reconciliation heals them later) and logged as an anomaly, never a failure. A
 *  scrubbed user is treated exactly like an unknown one: nothing is written (§3). */
async function addMembersTolerantly(pool: Pool, groupId: string, memberIds: string[]): Promise<void> {
  const added: string[] = [];
  const unknown: string[] = [];
  for (const id of memberIds) {
    if (await userExists(pool, id)) {
      await addGroupMember(pool, groupId, id);
      added.push(id);
    } else {
      unknown.push(id);
    }
  }
  if (added.length > 0) {
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.membership_changed",
      targetType: "group",
      targetId: groupId,
      after: { added },
    });
  }
  if (unknown.length > 0) {
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.anomaly",
      targetType: "group",
      targetId: groupId,
      after: { reason: "unknown_member_id_on_add", memberIds: unknown },
    });
  }
}

/** Removing a ghost membership (already absent, or an id with no matching user at all) is a
 *  benign no-op — the desired end state is already reached, so this is never an anomaly. */
async function removeMembersTolerantly(pool: Pool, groupId: string, memberIds: string[]): Promise<void> {
  const current = new Set(await listGroupMemberIds(pool, groupId));
  const removed: string[] = [];
  for (const id of memberIds) {
    if (current.has(id)) {
      await removeGroupMember(pool, groupId, id);
      current.delete(id);
      removed.push(id);
    }
  }
  if (removed.length > 0) {
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.membership_changed",
      targetType: "group",
      targetId: groupId,
      after: { removed },
    });
  }
}

// ── filter helpers ───────────────────────────────────────────────────────────────────────

function parseFilterOr400(req: Request, res: Response, allowed: readonly FilterAttr[]) {
  try {
    const parsed = parseFilter(typeof req.query.filter === "string" ? req.query.filter : undefined);
    if (parsed) requireAttr(parsed, allowed);
    return { ok: true as const, parsed };
  } catch (err) {
    if (err instanceof InvalidFilterError) {
      res.status(400).json(scimError(400, err.message, "invalidFilter"));
      return { ok: false as const };
    }
    throw err;
  }
}

// ── router ───────────────────────────────────────────────────────────────────────────────

export function createScimRouter(pool: Pool, opts: CreateScimRouterOptions): Router {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.type("application/scim+json");
    next();
  });
  router.use(bearerAuth(opts.bearerToken));
  if (opts.onAccepted) {
    const onAccepted = opts.onAccepted;
    router.use((_req, _res, next) => {
      try {
        onAccepted();
      } catch {
        /* the stamp never touches the SCIM response */
      }
      next();
    });
  }
  router.use(express.json({ type: ["application/json", "application/scim+json"], limit: "1mb" }));

  // ── Users ──────────────────────────────────────────────────────────────────────────────

  router.get("/Users", async (req, res) => {
    const filtered = parseFilterOr400(req, res, ["username", "externalid"]);
    if (!filtered.ok) return;
    if (filtered.parsed) {
      const user =
        filtered.parsed.attr === "username"
          ? await findUserByUserNameCI(pool, filtered.parsed.value)
          : await findUserByExternalId(pool, filtered.parsed.value);
      // An erased row is excluded from filter reads (§3) — Entra sees "no such user".
      const rows = user && !isScrubbed(user) ? [user] : [];
      res.status(200).json(scimListResponse(rows.map(toScimUser), rows.length));
      return;
    }
    const { startIndex, count } = pagination(req);
    const [{ rows: page }, { rows: totalRows }] = await Promise.all([
      pool.query<UserRow>(`select * from users where scrubbed_at is null order by created_at limit $1 offset $2`, [
        count,
        startIndex - 1,
      ]),
      pool.query<{ count: string }>(`select count(*)::text as count from users where scrubbed_at is null`),
    ]);
    res.status(200).json(scimListResponse(page.map(toScimUser), Number(totalRows[0]?.count ?? page.length), startIndex));
  });

  router.post("/Users", async (req, res) => {
    const parsedBody = parseUserWrite(req.body);
    if (!parsedBody.externalId) {
      res.status(400).json(scimError(400, "externalId or id is required to key this resource"));
      return;
    }
    const externalId = parsedBody.externalId;

    const existing = await findUserByExternalId(pool, externalId);
    if (isScrubbed(existing)) {
      // §3: never re-provision an erased row — answering 409 leaves it untouched.
      await auditScrubbedRefusal(pool, existing.id, "POST /Users");
      res.status(409).json(scimError(409, "This user's information was deleted and cannot be re-provisioned", "uniqueness"));
      return;
    }
    if (existing) {
      // Idempotent upsert: a duplicate POST (retry, replayed sync cycle) must not create a
      // second row — bring the existing one in line with the latest payload instead. The new
      // userName gets the same conflict check PUT and PATCH run.
      if (parsedBody.userName) {
        const conflicting = await findUserByUserNameCI(pool, parsedBody.userName);
        if (conflicting && conflicting.id !== existing.id) {
          res.status(409).json(scimError(409, `userName already in use: ${parsedBody.userName}`, "uniqueness"));
          return;
        }
      }
      const updated = await atomically(pool, async (db) => {
        const row = await updateUserFull(db, existing.id, { ...parsedBody, externalId });
        await auditUserTransition(db, existing, row);
        return row;
      });
      res.status(200).json(toScimUser(updated));
      return;
    }

    if (parsedBody.userName) {
      const conflicting = await findUserByUserNameCI(pool, parsedBody.userName);
      if (conflicting && conflicting.external_id !== externalId) {
        res.status(409).json(scimError(409, `userName already in use: ${parsedBody.userName}`, "uniqueness"));
        return;
      }
    }

    const created = await insertUser(pool, { ...parsedBody, externalId });
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.user_created",
      targetType: "user",
      targetId: created.id,
      after: { externalId, userName: created.user_name, active: created.active },
    });
    res.status(201).json(toScimUser(created));
  });

  router.get("/Users/:id", async (req, res) => {
    const user = await findUserById(pool, req.params.id);
    if (isScrubbed(user)) {
      await auditScrubbedRefusal(pool, user.id, "GET /Users/:id");
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    if (!user) {
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    res.status(200).json(toScimUser(user));
  });

  router.put("/Users/:id", async (req, res) => {
    const existing = await findUserById(pool, req.params.id);
    if (isScrubbed(existing)) {
      await auditScrubbedRefusal(pool, existing.id, "PUT /Users/:id");
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    if (!existing) {
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    const parsedBody = parseUserWrite(req.body);
    const externalId = parsedBody.externalId ?? existing.external_id;
    if (parsedBody.userName) {
      const conflicting = await findUserByUserNameCI(pool, parsedBody.userName);
      if (conflicting && conflicting.id !== existing.id) {
        res.status(409).json(scimError(409, `userName already in use: ${parsedBody.userName}`, "uniqueness"));
        return;
      }
    }
    const updated = await atomically(pool, async (db) => {
      const row = await updateUserFull(db, existing.id, { ...parsedBody, externalId });
      await auditUserTransition(db, existing, row);
      return row;
    });
    res.status(200).json(toScimUser(updated));
  });

  router.patch("/Users/:id", async (req, res) => {
    const existing = await findUserById(pool, req.params.id);
    if (isScrubbed(existing)) {
      await auditScrubbedRefusal(pool, existing.id, "PATCH /Users/:id");
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    if (!existing) {
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    const patch = normalizeUserPatch((req.body as { Operations?: unknown })?.Operations);
    const newUserName = patch.userName ?? existing.user_name;
    if (patch.externalId && patch.externalId !== existing.external_id) {
      // A re-mapped tenant undoing a sign-in relink (INNOBOX_SPEC.md §3): the new key must not
      // already belong to another row.
      const conflicting = await findUserByExternalId(pool, patch.externalId);
      if (conflicting && conflicting.id !== existing.id) {
        res.status(409).json(scimError(409, `externalId already in use: ${patch.externalId}`, "uniqueness"));
        return;
      }
    }
    if (patch.userName && patch.userName !== existing.user_name) {
      const conflicting = await findUserByUserNameCI(pool, patch.userName);
      if (conflicting && conflicting.id !== existing.id) {
        res.status(409).json(scimError(409, `userName already in use: ${patch.userName}`, "uniqueness"));
        return;
      }
    }
    const updated = await atomically(pool, async (db) => {
      const row = await updateUserPatch(db, existing.id, {
        externalId: patch.externalId ?? existing.external_id,
        active: patch.active ?? existing.active,
        userName: newUserName,
        email: patch.email ?? existing.email,
        displayName: patch.displayName ?? existing.display_name,
        department: patch.department ?? existing.department,
        jobTitle: patch.jobTitle ?? existing.job_title,
      });
      await auditUserTransition(db, existing, row);
      return row;
    });
    res.status(200).json(toScimUser(updated));
  });

  router.delete("/Users/:id", async (req, res) => {
    if (!isScimId(req.params.id)) {
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    const existing = await findUserById(pool, req.params.id);
    if (isScrubbed(existing)) {
      // §3: an erased row is "not found", not "already gone" — and is never touched.
      await auditScrubbedRefusal(pool, existing.id, "DELETE /Users/:id");
      res.status(404).json(scimError(404, "User not found"));
      return;
    }
    if (!existing) {
      // Idempotent leaver semantics: an unknown id is already "gone" from our perspective.
      res.status(204).end();
      return;
    }
    await atomically(pool, async (db) => {
      const deactivated = await deactivateUser(db, existing.id);
      await appendAudit(db, {
        actorUserId: null,
        action: "scim.user_deleted_received",
        targetType: "user",
        targetId: existing.id,
        before: { active: existing.active },
        after: { active: deactivated.active, deactivatedAt: isoOrNull(deactivated.deactivated_at) },
      });
      await revokeUserGrants(db, existing.id, "deactivated"); // §25.3 leavers, same transaction
    });
    res.status(204).end();
  });

  // ── Groups ─────────────────────────────────────────────────────────────────────────────

  router.get("/Groups", async (req, res) => {
    const filtered = parseFilterOr400(req, res, ["displayname", "externalid"]);
    if (!filtered.ok) return;
    const toResources = (rows: GroupRow[]) =>
      Promise.all(rows.map(async (g) => toScimGroup(g, await listGroupMemberIds(pool, g.id))));
    if (filtered.parsed) {
      const group =
        filtered.parsed.attr === "displayname"
          ? await findGroupByDisplayNameCI(pool, filtered.parsed.value)
          : await findGroupByExternalId(pool, filtered.parsed.value);
      const resources = await toResources(group ? [group] : []);
      res.status(200).json(scimListResponse(resources, resources.length));
      return;
    }
    // Like /Users: totalResults is the full match count, not the page size, and startIndex
    // echoes the request.
    const { startIndex, count } = pagination(req);
    const [{ rows: page }, { rows: totalRows }] = await Promise.all([
      pool.query<GroupRow>(`select * from groups order by created_at limit $1 offset $2`, [count, startIndex - 1]),
      pool.query<{ count: string }>(`select count(*)::text as count from groups`),
    ]);
    const resources = await toResources(page);
    res.status(200).json(scimListResponse(resources, Number(totalRows[0]?.count ?? page.length), startIndex));
  });

  router.post("/Groups", async (req, res) => {
    const parsedBody = parseGroupWrite(req.body);
    if (!parsedBody.externalId) {
      res.status(400).json(scimError(400, "externalId or id is required to key this resource"));
      return;
    }
    const externalId = parsedBody.externalId;

    let group = await findGroupByExternalId(pool, externalId);
    let created = false;
    if (group) group = await markGroupScimSynced(pool, group.id);
    if (!group) {
      group = await insertGroup(pool, { externalId, displayName: parsedBody.displayName });
      created = true;
      await appendAudit(pool, {
        actorUserId: null,
        action: "scim.group_created",
        targetType: "group",
        targetId: group.id,
        after: { externalId, displayName: group.display_name },
      });
    } else if (parsedBody.displayName && parsedBody.displayName !== group.display_name) {
      const before = group.display_name;
      group = await renameGroup(pool, group.id, parsedBody.displayName);
      await appendAudit(pool, {
        actorUserId: null,
        action: "scim.group_renamed",
        targetType: "group",
        targetId: group.id,
        before: { displayName: before },
        after: { displayName: group.display_name },
      });
    }
    if (parsedBody.memberIds.length > 0) {
      await addMembersTolerantly(pool, group.id, parsedBody.memberIds);
    }
    const memberIds = await listGroupMemberIds(pool, group.id);
    res.status(created ? 201 : 200).json(toScimGroup(group, memberIds));
  });

  router.get("/Groups/:id", async (req, res) => {
    const group = await findGroupById(pool, req.params.id);
    if (!group) {
      res.status(404).json(scimError(404, "Group not found"));
      return;
    }
    const memberIds = await listGroupMemberIds(pool, group.id);
    res.status(200).json(toScimGroup(group, memberIds));
  });

  router.put("/Groups/:id", async (req, res) => {
    const existing = await findGroupById(pool, req.params.id);
    if (!existing) {
      res.status(404).json(scimError(404, "Group not found"));
      return;
    }
    const parsedBody = parseGroupWrite(req.body);
    let group = await markGroupScimSynced(pool, existing.id);
    if (parsedBody.displayName && parsedBody.displayName !== existing.display_name) {
      const before = existing.display_name;
      group = await renameGroup(pool, existing.id, parsedBody.displayName);
      await appendAudit(pool, {
        actorUserId: null,
        action: "scim.group_renamed",
        targetType: "group",
        targetId: group.id,
        before: { displayName: before },
        after: { displayName: group.display_name },
      });
    }
    const current = new Set(await listGroupMemberIds(pool, group.id));
    const desired = new Set(parsedBody.memberIds);
    const toRemove = [...current].filter((id) => !desired.has(id));
    const toAdd = [...desired].filter((id) => !current.has(id));
    if (toRemove.length > 0) await removeMembersTolerantly(pool, group.id, toRemove);
    if (toAdd.length > 0) await addMembersTolerantly(pool, group.id, toAdd);
    const memberIds = await listGroupMemberIds(pool, group.id);
    res.status(200).json(toScimGroup(group, memberIds));
  });

  router.patch("/Groups/:id", async (req, res) => {
    const existing = await findGroupById(pool, req.params.id);
    if (!existing) {
      res.status(404).json(scimError(404, "Group not found"));
      return;
    }
    const patch = normalizeGroupPatch((req.body as { Operations?: unknown })?.Operations);
    let group = await markGroupScimSynced(pool, existing.id);
    if (patch.displayName && patch.displayName !== existing.display_name) {
      const before = existing.display_name;
      group = await renameGroup(pool, existing.id, patch.displayName);
      await appendAudit(pool, {
        actorUserId: null,
        action: "scim.group_renamed",
        targetType: "group",
        targetId: group.id,
        before: { displayName: before },
        after: { displayName: group.display_name },
      });
    }
    if (patch.removeAll) {
      const current = await listGroupMemberIds(pool, group.id);
      if (current.length > 0) await removeMembersTolerantly(pool, group.id, current);
    } else if (patch.removeMemberIds.length > 0) {
      await removeMembersTolerantly(pool, group.id, patch.removeMemberIds);
    }
    if (patch.addMemberIds.length > 0) {
      await addMembersTolerantly(pool, group.id, patch.addMemberIds);
    }
    const memberIds = await listGroupMemberIds(pool, group.id);
    res.status(200).json(toScimGroup(group, memberIds));
  });

  router.delete("/Groups/:id", async (req, res) => {
    if (!isScimId(req.params.id)) {
      res.status(404).json(scimError(404, "Group not found"));
      return;
    }
    const existing = await findGroupById(pool, req.params.id);
    if (!existing) {
      // Idempotent, like the user DELETE: a well-formed id that matches no row is already gone.
      res.status(204).end();
      return;
    }
    await deleteGroupCascade(pool, existing.id);
    await appendAudit(pool, {
      actorUserId: null,
      action: "scim.group_deleted",
      targetType: "group",
      targetId: existing.id,
      before: { externalId: existing.external_id, displayName: existing.display_name },
    });
    res.status(204).end();
  });

  // ── Discovery documents ────────────────────────────────────────────────────────────────

  router.get("/ServiceProviderConfig", (_req, res) => {
    res.status(200).json(serviceProviderConfig());
  });

  router.get("/ResourceTypes", (_req, res) => {
    const all = resourceTypes();
    res.status(200).json(scimListResponse(all, all.length));
  });

  router.get("/ResourceTypes/:id", (req, res) => {
    const found = resourceTypes().find((rt) => rt.id.toLowerCase() === req.params.id!.toLowerCase());
    if (!found) {
      res.status(404).json(scimError(404, "Resource type not found"));
      return;
    }
    res.status(200).json(found);
  });

  router.get("/Schemas", (_req, res) => {
    const all = schemas();
    res.status(200).json(scimListResponse(all, all.length));
  });

  router.get("/Schemas/:id", (req, res) => {
    const found = schemas().find((s) => s.id === req.params.id);
    if (!found) {
      res.status(404).json(scimError(404, "Schema not found"));
      return;
    }
    res.status(200).json(found);
  });

  // Error tail: malformed JSON bodies get a SCIM 400 (Entra retries indefinitely on 500s),
  // anything else a SCIM-shaped 500 rather than Express's default HTML error page.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError) {
      res.status(400).json(scimError(400, "Malformed JSON body"));
      return;
    }
    // Backstop for a uniqueness race the explicit checks above did not catch (two writes landing
    // at once): a unique-index violation is the client's conflict, not a server failure.
    if ((err as { code?: unknown })?.code === "23505") {
      res.status(409).json(scimError(409, "A resource with this identifier already exists", "uniqueness"));
      return;
    }
    console.error(
      JSON.stringify({ level: "error", msg: "scim request failed", error: String((err as Error)?.message ?? err) }),
    );
    res.status(500).json(scimError(500, "Internal server error"));
  });

  return router;
}
