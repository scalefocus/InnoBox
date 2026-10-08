// SCIM resource shaping (RFC 7643/7644, narrowed to what Entra sends —
// ENTRA_AUTH_SPEC.md §5): DB row <-> wire representation, plus the error/list envelopes every
// endpoint returns. Keeps router.ts free of schema/URN string literals.
/* eslint-disable @typescript-eslint/no-explicit-any */

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

export interface ScimError {
  schemas: string[];
  status: string;
  scimType?: string;
  detail: string;
}

export function scimError(status: number, detail: string, scimType?: string): ScimError {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

export function scimListResponse<T>(resources: T[], totalResults: number, startIndex = 1) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

// ── Users ────────────────────────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  external_id: string;
  user_name: string;
  email: string | null;
  display_name: string;
  department: string | null;
  job_title: string | null;
  active: boolean;
  deactivated_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toScimUser(row: UserRow) {
  return {
    schemas: [USER_SCHEMA, ENTERPRISE_USER_SCHEMA],
    id: row.id,
    externalId: row.external_id,
    userName: row.user_name,
    displayName: row.display_name,
    active: row.active,
    ...(row.job_title ? { title: row.job_title } : {}),
    emails: row.email ? [{ value: row.email, type: "work", primary: true }] : [],
    [ENTERPRISE_USER_SCHEMA]: { department: row.department ?? null },
    meta: {
      resourceType: "User",
      created: iso(row.created_at),
      lastModified: iso(row.updated_at),
    },
  };
}

export interface ParsedUserWrite {
  externalId: string | null;
  userName: string | null;
  email: string | null;
  displayName: string;
  department: string | null;
  jobTitle: string | null;
  active: boolean;
}

/** `externalId`, falling back to `id` — the one contract-mandated key fallback. Neither
 *  present means the caller must reject with 400 (there is nothing to upsert on). */
export function resolveExternalId(body: any): string | null {
  if (typeof body?.externalId === "string" && body.externalId.length > 0) return body.externalId;
  if (typeof body?.id === "string" && body.id.length > 0) return body.id;
  return null;
}

/** Primary email: the `primary: true` entry, else the first, else null (the caller falls
 *  back further to userName per the documented precedence). */
export function extractPrimaryEmail(body: any): string | null {
  const emails = Array.isArray(body?.emails) ? body.emails : [];
  const primary = emails.find((e: any) => e && e.primary === true && typeof e.value === "string");
  if (primary) return primary.value;
  const first = emails.find((e: any) => e && typeof e.value === "string");
  return first ? first.value : null;
}

export function parseUserWrite(body: any): ParsedUserWrite {
  const externalId = resolveExternalId(body);
  const userName = typeof body?.userName === "string" ? body.userName : null;
  const email = extractPrimaryEmail(body) ?? userName ?? null;
  const displayName = typeof body?.displayName === "string" ? body.displayName : (userName ?? "");
  const enterprise = body?.[ENTERPRISE_USER_SCHEMA];
  const department = typeof enterprise?.department === "string" ? enterprise.department : null;
  const jobTitle = typeof body?.title === "string" ? body.title : null;
  const active = typeof body?.active === "boolean" ? body.active : true;
  return { externalId, userName, email, displayName, department, jobTitle, active };
}

// ── Groups ───────────────────────────────────────────────────────────────────────────────

export interface GroupRow {
  id: string;
  external_id: string;
  display_name: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toScimGroup(row: GroupRow, memberIds: string[]) {
  return {
    schemas: [GROUP_SCHEMA],
    id: row.id,
    externalId: row.external_id,
    displayName: row.display_name,
    members: memberIds.map((id) => ({ value: id })),
    meta: {
      resourceType: "Group",
      created: iso(row.created_at),
      lastModified: iso(row.updated_at),
    },
  };
}

export interface ParsedGroupWrite {
  externalId: string | null;
  displayName: string;
  memberIds: string[];
}

export function parseGroupWrite(body: any): ParsedGroupWrite {
  const externalId = resolveExternalId(body);
  const displayName = typeof body?.displayName === "string" ? body.displayName : "";
  const members = Array.isArray(body?.members) ? body.members : [];
  const memberIds = members
    .map((m: any) => (typeof m === "string" ? m : typeof m?.value === "string" ? m.value : null))
    .filter((v: string | null): v is string => v !== null);
  return { externalId, displayName, memberIds };
}

// ── Static discovery documents ──────────────────────────────────────────────────────────

// `documentationUri` derives from the deployment's canonical URL — no host is pinned in the
// repository (INNOBOX_SPEC.md §2.3). It is OPTIONAL in SCIM 2.0 (RFC 7643 §5), so the field is
// omitted entirely when PUBLIC_BASE_URL is unset rather than carrying a placeholder.
export function serviceProviderConfig() {
  const documentationUri = process.env.PUBLIC_BASE_URL;
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    ...(documentationUri ? { documentationUri } : {}),
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "Static bearer token issued by InnoBox operations",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig" },
  };
}

export function resourceTypes() {
  return [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: USER_SCHEMA,
      schemaExtensions: [{ schema: ENTERPRISE_USER_SCHEMA, required: false }],
      meta: { resourceType: "ResourceType" },
    },
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      schema: GROUP_SCHEMA,
      meta: { resourceType: "ResourceType" },
    },
  ];
}

export function schemas() {
  return [
    { id: USER_SCHEMA, name: "User", description: "InnoBox SCIM User (minimal)", attributes: [] },
    {
      id: ENTERPRISE_USER_SCHEMA,
      name: "EnterpriseUser",
      description: "Enterprise extension (department only)",
      attributes: [],
    },
    { id: GROUP_SCHEMA, name: "Group", description: "InnoBox SCIM Group (minimal)", attributes: [] },
  ];
}
