// Authenticated API helpers for e2e (INNOBOX_SPEC.md §17). These go through a signed-in
// BrowserContext's request jar (context.request), so they exercise the REAL API, DB, RBAC, and
// anonymity/visibility gates as the signed-in persona — genuine end-to-end, just without the
// browser. Specs use them for setup (create fixtures) and to drive the status transitions whose
// controlled <select> UI is flaky under Next dev-mode first-hit route compilation
// (documented in core-journey.spec.ts), then assert the RENDERED result in the browser.
import type { APIRequestContext } from "@playwright/test";

const JSON_HEADERS = { "content-type": "application/json", accept: "application/json" };

function base(): string {
  return process.env.E2E_BASE_URL || "http://localhost:3000";
}

/** "CH-123" / "SOL-7" (or a bare number) → the digit path segment the API routes expect. */
export function numberDigits(displayNumber: string | number): string {
  return String(displayNumber).replace(/\D/g, "");
}

async function jsonOrThrow(res: import("@playwright/test").APIResponse, expected: number, what: string): Promise<unknown> {
  if (res.status() !== expected) {
    throw new Error(`${what} expected ${expected} but got ${res.status()}: ${await res.text()}`);
  }
  return res.json();
}

interface ImpactArea {
  id: string;
  name: string;
  active: boolean;
}

/** Id of an active impact area — the named one (default "Internal", which the seed provides),
 *  falling back to the first active area so the helper survives seed changes. */
export async function getImpactAreaId(request: APIRequestContext, name = "Internal"): Promise<string> {
  const body = (await jsonOrThrow(await request.get(`${base()}/api/impact-areas`), 200, "GET /api/impact-areas")) as {
    impactAreas: ImpactArea[];
  };
  const area = body.impactAreas.find((a) => a.name === name) ?? body.impactAreas[0];
  if (!area) throw new Error("no active impact areas exist — is the seed migration applied?");
  return area.id;
}

interface Namespace {
  id: string;
  slug: string;
  displayName: string;
}

/** Id of one of the caller's non-archived namespaces (default the built-in "global", of which
 *  every user is an implicit member). */
export async function getNamespaceId(request: APIRequestContext, slug = "global"): Promise<string> {
  const body = (await jsonOrThrow(await request.get(`${base()}/api/namespaces`), 200, "GET /api/namespaces")) as {
    namespaces: Namespace[];
  };
  const ns = body.namespaces.find((n) => n.slug === slug);
  if (!ns) throw new Error(`namespace "${slug}" not found among the caller's namespaces`);
  return ns.id;
}

/** Create a namespace (platform-admin only). Returns { id, slug, displayName }. */
export async function createNamespaceViaApi(
  request: APIRequestContext,
  input: { slug: string; displayName: string },
): Promise<Namespace> {
  const body = (await jsonOrThrow(
    await request.post(`${base()}/api/admin/namespaces`, { data: input, headers: JSON_HEADERS }),
    201,
    `POST /api/admin/namespaces (${input.slug})`,
  )) as { namespace: Namespace };
  return body.namespace;
}

/** Archive or unarchive a namespace (platform-admin only). */
export async function setNamespaceArchivedViaApi(request: APIRequestContext, namespaceId: string, archived: boolean): Promise<void> {
  await jsonOrThrow(
    await request.patch(`${base()}/api/admin/namespaces/${namespaceId}`, { data: { archived }, headers: JSON_HEADERS }),
    200,
    `PATCH /api/admin/namespaces/${namespaceId} → archived=${archived}`,
  );
}

export interface CreatedChallenge {
  id: string;
  /** Display form, e.g. "CH-123". */
  number: string;
  /** Digit path segment for API/URL, e.g. "123". */
  digits: string;
  title: string;
}

/** Submit a challenge as the signed-in persona. `impactAreaId`/`namespaceId` default to the
 *  seed "Internal" area and the "global" namespace, resolved via the API. */
export async function createChallengeViaApi(
  request: APIRequestContext,
  input: {
    title: string;
    description: string;
    impactAreaId?: string;
    namespaceId?: string;
    visibility?: "org" | "namespace";
    isAnonymous?: boolean;
    clientName?: string;
    /** §34.3: up to three topic ids. */
    topicIds?: string[];
  },
): Promise<CreatedChallenge> {
  const impactAreaId = input.impactAreaId ?? (await getImpactAreaId(request));
  const namespaceId = input.namespaceId ?? (await getNamespaceId(request));
  const body = (await jsonOrThrow(
    await request.post(`${base()}/api/challenges`, {
      data: {
        title: input.title,
        description: input.description,
        impactAreaId,
        namespaceId,
        visibility: input.visibility ?? "org",
        isAnonymous: input.isAnonymous ?? false,
        clientName: input.clientName,
        ...(input.topicIds ? { topicIds: input.topicIds } : {}),
      },
      headers: JSON_HEADERS,
    }),
    201,
    `POST /api/challenges ("${input.title}")`,
  )) as { challenge: { id: string; number: string; title: string } };
  return { ...body.challenge, digits: numberDigits(body.challenge.number) };
}

/** Set a challenge's status. As a platform admin this is a free override (any valid status). */
export async function setChallengeStatusViaApi(
  request: APIRequestContext,
  digits: string,
  status: string,
): Promise<void> {
  await jsonOrThrow(
    await request.patch(`${base()}/api/challenges/${digits}`, { data: { status }, headers: JSON_HEADERS }),
    200,
    `PATCH /api/challenges/${digits} → ${status}`,
  );
}

export interface CreatedSolution {
  id: string;
  number: string;
  digits: string;
}

/** Propose a solution on a `valid` challenge as the signed-in persona. */
export async function proposeSolutionViaApi(
  request: APIRequestContext,
  challengeDigits: string,
  input: { description: string; costVsBenefits?: string; isAnonymous?: boolean },
): Promise<CreatedSolution> {
  const body = (await jsonOrThrow(
    await request.post(`${base()}/api/challenges/${challengeDigits}/solutions`, {
      data: {
        description: input.description,
        costVsBenefits: input.costVsBenefits,
        isAnonymous: input.isAnonymous ?? false,
      },
      headers: JSON_HEADERS,
    }),
    201,
    `POST /api/challenges/${challengeDigits}/solutions`,
  )) as { solution: { id: string; number: string } };
  return { ...body.solution, digits: numberDigits(body.solution.number) };
}

/** Set a solution's status. As a platform admin this is a free override (subject only to the
 *  §8.3 single-winner gate + the `implemented` auto-close cascade, both enforced server-side). */
export async function setSolutionStatusViaApi(
  request: APIRequestContext,
  digits: string,
  status: string,
): Promise<void> {
  await jsonOrThrow(
    await request.patch(`${base()}/api/solutions/${digits}`, { data: { status }, headers: JSON_HEADERS }),
    200,
    `PATCH /api/solutions/${digits} → ${status}`,
  );
}

/** A planned Coming soon entry, as a platform admin plants one (INNOBOX_SPEC.md §38.4–§38.5): proposed
 *  (no pending cap for platform admins) and approved with `title` and `audience` at once. Coming soon
 *  lives only in the database, so specs plant their own entries instead of relying on the ones a
 *  migration seeded — an admin may have edited or deleted those. Returns the entry id. */
export async function plantComingSoonEntryViaApi(
  adminRequest: APIRequestContext,
  opts: { title: string; teaser?: string; audience?: "everyone" | "admins" | "platform_admin" },
): Promise<string> {
  const proposed = (await jsonOrThrow(
    await adminRequest.post(`${base()}/api/feature-ideas`, { headers: JSON_HEADERS, data: { description: `${opts.title}: planted by an e2e spec.` } }),
    201,
    "POST /api/feature-ideas",
  )) as { id: string };
  await jsonOrThrow(
    await adminRequest.post(`${base()}/api/admin/feature-ideas/${proposed.id}/approve`, {
      headers: JSON_HEADERS,
      data: { title: opts.title, teaser: opts.teaser ?? `${opts.title}, planted by an e2e spec.`, audience: opts.audience ?? "everyone" },
    }),
    200,
    "POST /api/admin/feature-ideas/:id/approve",
  );
  return proposed.id;
}

/** Deletes a planned Coming soon entry silently (no "now available" notification). Best effort, for
 *  a spec's cleanup. */
export async function removeComingSoonEntryViaApi(adminRequest: APIRequestContext, id: string): Promise<void> {
  await adminRequest.delete(`${base()}/api/admin/feature-ideas/${id}`, { headers: JSON_HEADERS, data: { notifyShipped: false } }).catch(() => undefined);
}
