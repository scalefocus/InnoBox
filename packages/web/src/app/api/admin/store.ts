// Data layer for the /api/admin routes (ENTRA_AUTH_SPEC.md §5 layer 3): namespaces CRUD-lite
// and Entra group → role mappings. Every mutation commits atomically with its audit row
// (INNOBOX_SPEC.md §15) by passing the checked-out client to appendAudit. Authorization is
// the routes' job (requirePlatformAdmin); this layer trusts its actorUserId. Imports stay
// relative (not @/) so the gated dbtest can run under the plain node test runner.
import type { Pool } from "pg";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import type { Role } from "./validation";

export interface NamespaceRecord {
  id: string;
  slug: string;
  displayName: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface RoleMappingRecord {
  id: string;
  groupExternalId: string;
  /** Display name from the SCIM-synced groups mirror; null when unknown locally. */
  groupDisplayName: string | null;
  /** True when no synced group carries this external id (deleted in Entra or never provisioned). */
  dead: boolean;
  role: Role;
  namespaceId: string | null;
  namespaceSlug: string | null;
  createdAt: string;
}

interface NamespaceRow {
  id: string;
  slug: string;
  display_name: string;
  archived_at: Date | null;
  created_at: Date;
}

interface MappingRow {
  id: string;
  group_external_id: string;
  role: Role;
  namespace_id: string | null;
  created_at: Date;
  group_display_name: string | null;
  namespace_slug: string | null;
}

function toNamespace(row: NamespaceRow): NamespaceRecord {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

function toMapping(row: MappingRow): RoleMappingRecord {
  return {
    id: row.id,
    groupExternalId: row.group_external_id,
    groupDisplayName: row.group_display_name,
    dead: row.group_display_name === null,
    role: row.role,
    namespaceId: row.namespace_id,
    namespaceSlug: row.namespace_slug,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listNamespaces(db: Pool): Promise<NamespaceRecord[]> {
  const { rows } = await db.query<NamespaceRow>(
    `select id, slug, display_name, archived_at, created_at
       from namespaces
      order by (slug <> 'global'), slug`,
  );
  return rows.map(toNamespace);
}

/** Returns null when the slug is already taken (including the seeded 'global'). */
export async function createNamespace(
  pool: Pool,
  input: { slug: string; displayName: string },
  actorUserId: string,
): Promise<NamespaceRecord | null> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<NamespaceRow>(
      `insert into namespaces (slug, display_name)
       values ($1, $2)
       on conflict (slug) do nothing
       returning id, slug, display_name, archived_at, created_at`,
      [input.slug, input.displayName],
    );
    const row = rows[0];
    if (!row) return null;
    await appendAudit(client, {
      actorUserId,
      action: "namespace.created",
      targetType: "namespace",
      targetId: row.id,
      after: { slug: row.slug, displayName: row.display_name },
    });
    return toNamespace(row);
  });
}

export type PatchNamespaceResult =
  | { status: "ok"; namespace: NamespaceRecord }
  | { status: "not_found" }
  | { status: "global_archive" };

export async function patchNamespace(
  pool: Pool,
  id: string,
  patch: { displayName?: string; archived?: boolean },
  actorUserId: string,
): Promise<PatchNamespaceResult> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<NamespaceRow>(
      `select id, slug, display_name, archived_at, created_at
         from namespaces where id = $1 for update`,
      [id],
    );
    const current = rows[0];
    if (!current) return { status: "not_found" };
    // The built-in global namespace (§4.1) can be renamed but never archived.
    if (patch.archived === true && current.slug === "global") return { status: "global_archive" };

    let displayName = current.display_name;
    let archivedAt = current.archived_at;

    if (patch.displayName !== undefined && patch.displayName !== current.display_name) {
      await client.query(`update namespaces set display_name = $2 where id = $1`, [id, patch.displayName]);
      await appendAudit(client, {
        actorUserId,
        action: "namespace.renamed",
        targetType: "namespace",
        targetId: id,
        before: { displayName: current.display_name },
        after: { displayName: patch.displayName },
      });
      displayName = patch.displayName;
    }

    if (patch.archived === true && current.archived_at === null) {
      const { rows: updated } = await client.query<{ archived_at: Date }>(
        `update namespaces set archived_at = now() where id = $1 returning archived_at`,
        [id],
      );
      archivedAt = updated[0]!.archived_at;
      await appendAudit(client, {
        actorUserId,
        action: "namespace.archived",
        targetType: "namespace",
        targetId: id,
        before: { archived: false },
        after: { archived: true },
      });
    } else if (patch.archived === false && current.archived_at !== null) {
      await client.query(`update namespaces set archived_at = null where id = $1`, [id]);
      archivedAt = null;
      await appendAudit(client, {
        actorUserId,
        action: "namespace.unarchived",
        targetType: "namespace",
        targetId: id,
        before: { archived: true },
        after: { archived: false },
      });
    }

    return {
      status: "ok",
      namespace: toNamespace({ ...current, display_name: displayName, archived_at: archivedAt }),
    };
  });
}

export async function listRoleMappings(db: Pool): Promise<RoleMappingRecord[]> {
  const { rows } = await db.query<MappingRow>(
    `select rm.id, rm.group_external_id, rm.role, rm.namespace_id, rm.created_at,
            g.display_name as group_display_name, ns.slug as namespace_slug
       from role_mappings rm
       left join groups g on g.external_id = rm.group_external_id
       left join namespaces ns on ns.id = rm.namespace_id
      order by rm.created_at, rm.id`,
  );
  return rows.map(toMapping);
}

export type CreateRoleMappingResult =
  | { status: "ok"; mapping: RoleMappingRecord }
  | { status: "duplicate" }
  | { status: "unknown_namespace" };

export async function createRoleMapping(
  pool: Pool,
  input: { groupExternalId: string; role: Role; namespaceId: string | null },
  actorUserId: string,
): Promise<CreateRoleMappingResult> {
  return inTransaction(pool, async (client) => {
    let namespaceSlug: string | null = null;
    if (input.namespaceId !== null) {
      const { rows } = await client.query<{ slug: string }>(`select slug from namespaces where id = $1`, [
        input.namespaceId,
      ]);
      if (!rows[0]) return { status: "unknown_namespace" };
      namespaceSlug = rows[0].slug;
    }
    // UNIQUE (group_external_id, role, namespace_id) treats NULL namespace_id rows as
    // distinct, so platform-scope duplicates must be caught here, not by the constraint.
    const { rows: dup } = await client.query(
      `select 1 from role_mappings
        where group_external_id = $1 and role = $2 and namespace_id is not distinct from $3`,
      [input.groupExternalId, input.role, input.namespaceId],
    );
    if (dup.length > 0) return { status: "duplicate" };

    let inserted: { id: string; created_at: Date };
    try {
      const { rows } = await client.query<{ id: string; created_at: Date }>(
        `insert into role_mappings (group_external_id, role, namespace_id, created_by)
         values ($1, $2, $3, $4)
         returning id, created_at`,
        [input.groupExternalId, input.role, input.namespaceId, actorUserId],
      );
      inserted = rows[0]!;
    } catch (err) {
      // Concurrent identical insert lost the race on the unique constraint.
      if ((err as { code?: string }).code === "23505") return { status: "duplicate" };
      throw err;
    }
    const { rows: grp } = await client.query<{ display_name: string }>(
      `select display_name from groups where external_id = $1`,
      [input.groupExternalId],
    );
    await appendAudit(client, {
      actorUserId,
      action: "role_mapping.created",
      targetType: "role_mapping",
      targetId: inserted.id,
      after: { groupExternalId: input.groupExternalId, role: input.role, namespaceId: input.namespaceId },
    });
    return {
      status: "ok",
      mapping: {
        id: inserted.id,
        groupExternalId: input.groupExternalId,
        groupDisplayName: grp[0]?.display_name ?? null,
        dead: !grp[0],
        role: input.role,
        namespaceId: input.namespaceId,
        namespaceSlug,
        createdAt: inserted.created_at.toISOString(),
      },
    };
  });
}

/** Returns false when no mapping with this id exists (already deleted). */
export async function deleteRoleMapping(pool: Pool, id: string, actorUserId: string): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      group_external_id: string;
      role: Role;
      namespace_id: string | null;
    }>(
      `delete from role_mappings where id = $1
       returning group_external_id, role, namespace_id`,
      [id],
    );
    const row = rows[0];
    if (!row) return false;
    await appendAudit(client, {
      actorUserId,
      action: "role_mapping.deleted",
      targetType: "role_mapping",
      targetId: id,
      before: { groupExternalId: row.group_external_id, role: row.role, namespaceId: row.namespace_id },
    });
    return true;
  });
}
