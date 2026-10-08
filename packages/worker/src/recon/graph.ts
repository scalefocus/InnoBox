// Microsoft Graph client for the reconciliation pass (ENTRA_AUTH_SPEC.md §5): app-only
// client-credentials token (User.Read.All + GroupMember.Read.All, admin-consented per
// spec §3) cached until expiry minus skew, plus the three read helpers the pass needs.
// Global fetch; access tokens and Authorization headers are NEVER logged — errors carry
// only the HTTP status and a truncated Entra error body (error codes, no credentials).
import { directoryAttr, type GraphUser } from "./diff.js";

export type { GraphUser };

export interface GraphEnv {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Override points for tests. */
  loginBase?: string;
  graphBase?: string;
  fetchImpl?: typeof fetch;
}

export class GraphRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GraphRequestError";
  }
}

export type GraphGroup = { exists: false } | { exists: true; displayName: string };

/**
 * `changed: false` — local photo is current. `changed: true` with bytes+etag — store the
 * new thumbnail. `changed: true` without bytes — the photo was removed in Entra; clear it.
 */
export type PhotoResult = { changed: false } | { changed: true; bytes?: Buffer; etag?: string };

export interface GraphClient {
  /** GET /users/{oid} — 404 means gone from the tenant (soft/hard deleted). */
  getUser(oid: string): Promise<GraphUser>;
  /** GET /groups/{id} — used to mirror mapped-but-unknown groups locally. */
  getGroup(groupExternalId: string): Promise<GraphGroup>;
  /**
   * GET /groups/{id}/members, following @odata.nextLink; returns the oids of USER-type
   * members only (nested groups are not expanded in v1 — matches Entra provisioning's
   * flattening of assigned groups). A missing group throws GraphRequestError(404) — the
   * caller's "group gone in Entra" signal.
   */
  listGroupMembers(groupExternalId: string): Promise<string[]>;
  /** 240px thumbnail with ETag-based change detection; pass the stored photo_etag (or null).
   *  240px is the single stored size (§3.1) — crisp at every §13.6 rendering size incl. 2× DPR. */
  getUserPhoto240(oid: string, currentEtag: string | null): Promise<PhotoResult>;
}

const LOGIN_BASE = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Re-acquire when the cached token has less than this validity left. */
const TOKEN_SKEW_MS = 60_000;
/** A hung Graph endpoint must not stall the (sequential) reconciliation pass. */
const REQUEST_TIMEOUT_MS = 15_000;

async function fail(res: Response, what: string): Promise<never> {
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  throw new GraphRequestError(res.status, `${what} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
}

export function createGraphClient(env: GraphEnv): GraphClient {
  const f = env.fetchImpl ?? fetch;
  const loginBase = env.loginBase ?? LOGIN_BASE;
  const graphBase = env.graphBase ?? GRAPH_BASE;
  let cached: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) return cached.token;
    const res = await f(`${loginBase}/${env.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.clientId,
        client_secret: env.clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) await fail(res, "graph token acquisition");
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  async function get(url: string): Promise<Response> {
    const t = await token();
    return f(url, {
      headers: { authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  return {
    async getUser(oid) {
      // officeLocation rides the $select this pass already issues — a default property of the
      // user resource, so no extra request and no new permission (§13.8).
      const res = await get(
        `${graphBase}/users/${encodeURIComponent(oid)}?$select=accountEnabled,displayName,userPrincipalName,mail,department,jobTitle,officeLocation`,
      );
      if (res.status === 404) return { exists: false };
      if (!res.ok) await fail(res, `GET /users/${oid}`);
      const j = (await res.json()) as {
        accountEnabled?: boolean;
        displayName?: string | null;
        userPrincipalName?: string | null;
        mail?: string | null;
        department?: string | null;
        jobTitle?: string | null;
        officeLocation?: string | null;
      };
      return {
        exists: true,
        accountEnabled: j.accountEnabled === true,
        displayName: j.displayName ?? "",
        userPrincipalName: j.userPrincipalName ?? "",
        mail: j.mail ?? null,
        // Directory profile: absent, empty or whitespace-only → NULL (§3 — clearing upstream clears it).
        department: directoryAttr(j.department),
        jobTitle: directoryAttr(j.jobTitle),
        officeLocation: directoryAttr(j.officeLocation),
      };
    },

    async getGroup(groupExternalId) {
      const res = await get(`${graphBase}/groups/${encodeURIComponent(groupExternalId)}?$select=displayName`);
      if (res.status === 404) return { exists: false };
      if (!res.ok) await fail(res, `GET /groups/${groupExternalId}`);
      const j = (await res.json()) as { displayName?: string | null };
      return { exists: true, displayName: j.displayName ?? "" };
    },

    async listGroupMembers(groupExternalId) {
      const oids: string[] = [];
      let url: string | null = `${graphBase}/groups/${encodeURIComponent(groupExternalId)}/members?$select=id&$top=999`;
      while (url) {
        const res = await get(url);
        if (!res.ok) await fail(res, `GET /groups/${groupExternalId}/members`);
        const j = (await res.json()) as {
          value?: Array<{ id?: string; "@odata.type"?: string }>;
          "@odata.nextLink"?: string;
        };
        for (const m of j.value ?? []) {
          if (m.id && (m["@odata.type"] ?? "").endsWith(".user")) oids.push(m.id);
        }
        url = j["@odata.nextLink"] ?? null;
      }
      return oids;
    },

    async getUserPhoto240(oid, currentEtag) {
      // Metadata first: the @odata.mediaEtag lets us skip the bytes when unchanged.
      const meta = await get(`${graphBase}/users/${encodeURIComponent(oid)}/photos/240x240`);
      if (meta.status === 404) {
        // No photo in Entra — drift only if we still hold one locally.
        return currentEtag !== null ? { changed: true } : { changed: false };
      }
      if (!meta.ok) await fail(meta, `GET /users/${oid}/photos/240x240`);
      const j = (await meta.json()) as { "@odata.mediaEtag"?: string | null };
      const etag = j["@odata.mediaEtag"] ?? "";
      if (currentEtag !== null && etag !== "" && etag === currentEtag) return { changed: false };

      const res = await get(`${graphBase}/users/${encodeURIComponent(oid)}/photos/240x240/$value`);
      if (res.status === 404) return currentEtag !== null ? { changed: true } : { changed: false };
      if (!res.ok) await fail(res, `GET /users/${oid}/photos/240x240/$value`);
      const bytes = Buffer.from(await res.arrayBuffer());
      return { changed: true, bytes, etag };
    },
  };
}
