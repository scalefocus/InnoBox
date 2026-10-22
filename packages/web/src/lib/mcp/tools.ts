// The 15 MCP tools (INNOBOX_SPEC.md §25.6) — 8 read, 7 contribute, and nothing else: no likes, no
// status change other than the author's resubmit, no assignment, triage, reveal, visibility,
// featuring, delete, attachment bytes, admin, AI tasks, profiles or gamification. 15 is the
// ceiling: a sixteenth tool is a spec change.
//
// Every tool calls the same store function as the matching /api route (§25.4) — the same §4.3
// visibility predicate, §9 masking, validation, state-machine checks, audit, §23 awards and §12.1
// notifications. What a tool adds is only: the §25.5 restricted filter (the viewer's
// `orgVisibleOnly`, honoured by canSeeChallenge and the SQL predicate), the client name on writes
// (§25.8), and the response shaping below — people by display name only, an anonymous author as
// "Anonymous", a `url` back to the browser on every challenge and solution. Item text is returned
// in plain fields, never merged into a description (§25.4 "content is data").
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { Pool } from "pg";
import {
  CHALLENGE_STATUSES,
  CLIENT_NAME_MAX,
  COMMENT_BODY_MAX,
  COST_VS_BENEFITS_MAX,
  DESCRIPTION_MAX,
  SOLUTION_STATUSES,
  TITLE_MAX,
  TOPIC_SET_ERROR,
  TOPICS_PER_CHALLENGE_MAX,
  canAuthorEditChallenge,
  canAuthorResubmit,
  isChallengeStatus,
  parseTopicIds,
  type AttachmentView,
  type McpSettings,
  type MaskedAuthor,
  type RoleSet,
} from "@innobox/shared";
import {
  createChallenge,
  createSolution,
  editChallenge,
  editSolution,
  findSimilarChallenges,
  getChallengeByNumber,
  listActiveImpactAreas,
  listChallenges,
  listOwnSolutions,
  resolveVisibleParent,
  resubmitChallenge,
  resubmitSolution,
  type AgentSource,
  type Viewer,
} from "../../app/api/challenges/store";
import { getSolutionByNumber } from "../../app/api/solutions/store";
import { createComment, listComments } from "../../app/api/comments/store";
import { autoFollow, follow, unfollow } from "../../app/api/follows/store";
import { searchChallengePage } from "../../app/api/search/store";
import { listInboxPage } from "../../app/api/notifications/store";
import { listNamespaces } from "../../app/api/admin/store";
import { listActiveTopics } from "../../app/api/topics/store";
import { parseSimilarAcknowledged } from "../../app/api/challenges/validation";
import type { RateLimitBucket } from "../rate-limit";
import type { NotifyContext } from "../notify";
import {
  logNotifyFailure,
  notifyChallengeResubmitted,
  notifyChallengeSubmitted,
  notifyCommentPosted,
  notifySolutionProposed,
  notifySolutionResubmitted,
} from "../notify-events";
import type { McpPrincipal } from "./store";

/** The prefix every tool carries on the wire (§25.6). */
export const TOOL_PREFIX = "innobox_";

export interface ToolContext {
  pool: Pool;
  /** The person, roles re-resolved for this call, `orgVisibleOnly` per §25.5. */
  viewer: Viewer;
  principal: McpPrincipal;
  settings: McpSettings;
  /** PUBLIC_BASE_URL — every `url` is built on it. */
  baseUrl: string;
  resolveRoles: (userId: string) => Promise<RoleSet>;
}

/** A tool's answer: data, or the same plain message (and HTTP-like status) the API gives. */
export type ToolResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: 400 | 403 | 404 | 409 | 422; message: string };

export interface ToolDef {
  /** Without the `innobox_` prefix. */
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  /** §25.11: reads take the search bucket; writes the bucket of the matching /api route. */
  bucket: RateLimitBucket;
  inputSchema: Record<string, unknown>;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

// ── Argument helpers ─────────────────────────────────────────────────────────────────────

class ArgError extends Error {}

function str(args: Record<string, unknown>, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (opts.required) throw new ArgError(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new ArgError(`${key} must be a string`);
  if (opts.max !== undefined && value.length > opts.max) throw new ArgError(`${key} must be at most ${opts.max} characters`);
  return value;
}

function bool(args: Record<string, unknown>, key: string, required = false): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new ArgError(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "boolean") throw new ArgError(`${key} must be true or false`);
  return value;
}

function int(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ArgError(`${key} must be a whole number from ${min} to ${max}`);
  return value;
}

/** "CH-12", "12" or 12 → "12" (likewise SOL-). */
function itemNumber(args: Record<string, unknown>, key: string, prefix: "CH" | "SOL"): string {
  const value = args[key];
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = new RegExp(`^(?:${prefix}-?)?(\\d{1,9})$`, "i").exec(raw);
  if (!m) throw new ArgError(`${key} must be a ${prefix === "CH" ? "challenge" : "solution"} number such as ${prefix}-12`);
  return String(Number(m[1]));
}

function parentType(args: Record<string, unknown>): "challenge" | "solution" {
  const value = args.parentType;
  if (value !== "challenge" && value !== "solution") throw new ArgError(`parentType must be "challenge" or "solution"`);
  return value;
}

/** §34.3: an optional `topicIds` array of topic ids from innobox_get_reference_data. */
function topicIdsArg(args: Record<string, unknown>): string[] | undefined {
  if (args.topicIds === undefined || args.topicIds === null) return undefined;
  const parsed = parseTopicIds(args.topicIds);
  if (!parsed.ok) throw new ArgError(parsed.error);
  return parsed.value;
}

const TOPIC_IDS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  maxItems: TOPICS_PER_CHALLENGE_MAX,
  description: "Topic ids from innobox_get_reference_data, at most 3",
};

function uuidArg(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = str(args, key, { required });
  if (value === undefined) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ArgError(`${key} must be an id from innobox_get_reference_data`);
  return value;
}

const PAGE_SIZE_MAX = 25;

function page(args: Record<string, unknown>): { limit: number; offset: number; page: number } {
  const pageNo = int(args, "page", 1, 10_000, 1);
  const limit = int(args, "pageSize", 1, PAGE_SIZE_MAX, PAGE_SIZE_MAX);
  return { limit, offset: (pageNo - 1) * limit, page: pageNo };
}

// ── Response shaping (§25.4) ─────────────────────────────────────────────────────────────

const digits = (n: string): string => n.replace(/\D/g, "");
const challengeUrl = (ctx: ToolContext, number: string) => `${ctx.baseUrl}/challenges/${digits(number)}`;
const solutionUrl = (ctx: ToolContext, challengeNumber: string, number: string) => `${ctx.baseUrl}/challenges/${digits(challengeNumber)}#SOL-${digits(number)}`;
/** People by display name only — never an id, e-mail or account state. */
const person = (author: MaskedAuthor): string => author.displayName;
/** §25.7: clean attachments only, metadata only — no bytes, link or uploader. */
const attachmentMeta = (list: AttachmentView[]) =>
  list.filter((a) => a.status === "clean").map((a) => ({ fileName: a.filename, sizeBytes: a.sizeBytes, contentType: a.mime, uploadedAt: a.createdAt }));
const via = (ctx: ToolContext): AgentSource => ({ clientName: ctx.principal.clientName });
const notifyCtx = (ctx: ToolContext): NotifyContext => ({ pool: ctx.pool, actorId: ctx.viewer.userId, resolveRoles: ctx.resolveRoles });

const NOT_FOUND = (what: string): ToolResult => ({ ok: false, status: 404, message: `${what} not found` });
const fail = (status: 400 | 403 | 409 | 422, message: string): ToolResult => ({ ok: false, status, message });

/** The parent behind a (parentType, number) pair — visible, or null (§4.3, §25.5). */
async function parentId(ctx: ToolContext, args: Record<string, unknown>, key = "number"): Promise<{ type: "challenge" | "solution"; id: string | null }> {
  const type = parentType(args);
  const number = itemNumber(args, key, type === "challenge" ? "CH" : "SOL");
  return { type, id: await resolveVisibleParent(ctx.pool, ctx.viewer, type, number) };
}

// ── Schemas ──────────────────────────────────────────────────────────────────────────────

const NUMBER_SCHEMA = (what: string) => ({ type: ["string", "integer"], description: `${what} number, e.g. ${what === "Challenge" ? "CH-12" : "SOL-7"}` });
const PARENT_SCHEMA = { type: "string", enum: ["challenge", "solution"] };
const PAGING = {
  page: { type: "integer", minimum: 1, description: "1-based page number" },
  pageSize: { type: "integer", minimum: 1, maximum: PAGE_SIZE_MAX },
};

// ── The tools ────────────────────────────────────────────────────────────────────────────

export const TOOLS: readonly ToolDef[] = [
  // ── Read (8) ──
  {
    name: "search_challenges",
    title: "Search challenges",
    description:
      "Full-text search over the challenges the signed-in person can see, with optional filters. Returns one page (at most 25) of hits with number, title, status, namespace, impact area, topics, author, like and solution counts, and a url.",
    readOnly: true,
    bucket: "search",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200, description: "Words to search for, or an exact number like CH-12. Empty lists everything visible, newest first." },
        status: { type: "string", enum: [...CHALLENGE_STATUSES] },
        namespaceId: { type: "string", description: "A namespace id from innobox_get_reference_data" },
        impactAreaId: { type: "string", description: "An impact area id from innobox_get_reference_data" },
        topicId: { type: "string", description: "A topic id from innobox_get_reference_data" },
        mine: { type: "boolean", description: "Only challenges the person submitted" },
        following: { type: "boolean", description: "Only challenges the person follows" },
        ...PAGING,
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const status = str(args, "status");
      if (status !== undefined && !isChallengeStatus(status)) throw new ArgError("status must be a challenge status");
      const paging = page(args);
      const { items, hasMore } = await searchChallengePage(ctx.pool, ctx.viewer, {
        query: str(args, "query", { max: 200 }) ?? "",
        filters: { status: status as never, namespaceId: uuidArg(args, "namespaceId"), impactAreaId: uuidArg(args, "impactAreaId"), topicId: uuidArg(args, "topicId")?.toLowerCase() },
        mine: bool(args, "mine") ?? false,
        following: bool(args, "following") ?? false,
        limit: paging.limit,
        offset: paging.offset,
      });
      return {
        ok: true,
        data: {
          page: paging.page,
          hasMore,
          challenges: items.map((c) => ({
            number: c.number,
            title: c.title,
            status: c.status,
            namespace: c.namespaceSlug,
            impactArea: c.impactAreaName,
            topics: c.topics.map((t) => t.name),
            author: person(c.author),
            likeCount: c.likeCount,
            solutionCount: c.solutionCount,
            url: challengeUrl(ctx, c.number),
          })),
        },
      };
    },
  },
  {
    name: "get_challenge",
    title: "Get a challenge",
    description: "One challenge in full, with its visible solutions as summaries, its attachments' metadata, and what the person may do next (canPropose, canEdit, canResubmit).",
    readOnly: true,
    bucket: "search",
    inputSchema: { type: "object", properties: { number: NUMBER_SCHEMA("Challenge") }, required: ["number"], additionalProperties: false },
    async run(ctx, args) {
      const c = await getChallengeByNumber(ctx.pool, ctx.viewer, itemNumber(args, "number", "CH"));
      if (!c) return NOT_FOUND("challenge");
      return {
        ok: true,
        data: {
          number: c.number,
          title: c.title,
          description: c.description,
          status: c.status,
          namespace: c.namespaceSlug,
          visibility: c.visibility,
          impactArea: c.impactAreaName,
          topics: c.topics.map((t) => t.name),
          clientName: c.clientName,
          author: person(c.author),
          isMine: c.isMine,
          assignee: c.assigneeDisplayName,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          editedAt: c.editedAt,
          resolvedAt: c.resolvedAt,
          likeCount: c.likeCount,
          following: c.followedByViewer,
          attachments: attachmentMeta(c.attachments),
          solutions: c.solutions.map((s) => ({
            number: s.number,
            status: s.status,
            author: person(s.author),
            isMine: s.isMine,
            summary: s.description.slice(0, 280),
            url: solutionUrl(ctx, c.number, s.number),
          })),
          canPropose: c.canPropose,
          canEdit: c.canEdit,
          canResubmit: c.canResubmit,
          url: challengeUrl(ctx, c.number),
        },
      };
    },
  },
  {
    name: "get_solution",
    title: "Get a solution",
    description: "One solution in full: description, cost vs benefits, status, author, dates, attachments' metadata, canEdit, canResubmit and its parent challenge.",
    readOnly: true,
    bucket: "search",
    inputSchema: { type: "object", properties: { number: NUMBER_SCHEMA("Solution") }, required: ["number"], additionalProperties: false },
    async run(ctx, args) {
      const detail = await getSolutionByNumber(ctx.pool, ctx.viewer, itemNumber(args, "number", "SOL"));
      if (!detail) return NOT_FOUND("solution");
      const s = detail.solution;
      return {
        ok: true,
        data: {
          number: s.number,
          description: s.description,
          costVsBenefits: s.costVsBenefits,
          status: s.status,
          author: person(s.author),
          isMine: s.isMine,
          createdAt: s.createdAt,
          likeCount: s.likeCount,
          following: s.followedByViewer,
          attachments: attachmentMeta(s.attachments),
          canEdit: s.canEdit,
          canResubmit: s.canResubmit,
          challenge: { number: detail.challenge.number, title: detail.challenge.title, status: detail.challenge.status, url: challengeUrl(ctx, detail.challenge.number) },
          url: solutionUrl(ctx, detail.challenge.number, s.number),
        },
      };
    },
  },
  {
    name: "list_comments",
    title: "List comments",
    description:
      "The comments on a challenge or a solution, oldest first, a page at a time. A reply carries threadRootId (its top-level comment) and replyToId (the comment it answers). Removed comments show as the web shows them.",
    readOnly: true,
    bucket: "search",
    inputSchema: {
      type: "object",
      properties: { parentType: PARENT_SCHEMA, number: { type: ["string", "integer"], description: "The challenge or solution number" }, ...PAGING },
      required: ["parentType", "number"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const parent = await parentId(ctx, args);
      const paging = page(args);
      const comments = parent.id ? await listComments(ctx.pool, ctx.viewer, parent.type, parent.id) : null;
      if (!comments) return NOT_FOUND(parent.type);
      return {
        ok: true,
        data: {
          page: paging.page,
          hasMore: comments.length > paging.offset + paging.limit,
          comments: comments.slice(paging.offset, paging.offset + paging.limit).map((c) => ({
            id: c.id,
            author: c.authorDisplayName,
            authorIsCommittee: c.authorIsCommittee,
            isMine: c.isMine,
            body: c.body,
            threadRootId: c.threadRootId,
            replyToId: c.replyToId,
            deleted: c.deleted,
            createdAt: c.createdAt,
            editedAt: c.editedAt,
          })),
        },
      };
    },
  },
  {
    name: "find_similar_challenges",
    title: "Find similar challenges",
    description: "The duplicate check: up to 5 visible challenges similar to a title and description. Call it before innobox_submit_challenge.",
    readOnly: true,
    bucket: "search",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", maxLength: TITLE_MAX }, description: { type: "string", maxLength: DESCRIPTION_MAX } },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const title = (str(args, "title", { max: DESCRIPTION_MAX }) ?? "").trim().slice(0, 120);
      const description = (str(args, "description", { max: DESCRIPTION_MAX }) ?? "").trim().slice(0, 2_000);
      if (!title && !description) return fail(400, "title or description is required");
      const similar = await findSimilarChallenges(ctx.pool, ctx.viewer, { title, description });
      return {
        ok: true,
        data: { similar: similar.map((s) => ({ number: s.number, title: s.title, status: s.status, author: person(s.author), url: challengeUrl(ctx, s.number) })) },
      };
    },
  },
  {
    name: "list_my_items",
    title: "List my items",
    description: "The person's own challenges and solutions with their status and whether each can be edited or resubmitted now — including challenges still awaiting triage.",
    readOnly: true,
    bucket: "search",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(ctx) {
      const [challenges, solutions] = await Promise.all([
        listChallenges(ctx.pool, ctx.viewer, { tab: "mine", sort: "newest" }),
        listOwnSolutions(ctx.pool, ctx.viewer),
      ]);
      return {
        ok: true,
        data: {
          challenges: challenges.map((c) => ({
            number: c.number,
            title: c.title,
            status: c.status,
            createdAt: c.createdAt,
            anonymous: c.author.anonymous,
            canEdit: canAuthorEditChallenge(c.status),
            canResubmit: canAuthorResubmit(c.status),
            url: challengeUrl(ctx, c.number),
          })),
          solutions: solutions.map((s) => ({ ...s, url: solutionUrl(ctx, s.challengeNumber, s.number) })),
        },
      };
    },
  },
  {
    name: "list_my_notifications",
    title: "List my notifications",
    description: "The person's in-app notifications, newest first, a page at a time, with read state. Reading them here marks nothing read.",
    readOnly: true,
    bucket: "search",
    inputSchema: { type: "object", properties: { unreadOnly: { type: "boolean" }, ...PAGING }, additionalProperties: false },
    async run(ctx, args) {
      const paging = page(args);
      const inbox = await listInboxPage(ctx.pool, ctx.viewer.userId, {
        limit: paging.limit,
        offset: paging.offset,
        unreadOnly: bool(args, "unreadOnly") ?? false,
        orgVisibleOnly: ctx.viewer.orgVisibleOnly,
      });
      return {
        ok: true,
        data: {
          page: paging.page,
          hasMore: inbox.hasMore,
          notifications: inbox.notifications.map((n) => ({
            type: n.type,
            message: n.message,
            read: n.read,
            createdAt: n.createdAt,
            url: n.link.startsWith("/") ? `${ctx.baseUrl}${n.link}` : null,
          })),
        },
      };
    },
  },
  {
    name: "get_reference_data",
    title: "Get reference data",
    description: "What a submission needs: the namespaces the person can submit to, active impact areas, active topics, the statuses, field length limits, whether anonymous submission is available, and whether namespace-restricted content is shared with agents.",
    readOnly: true,
    bucket: "search",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(ctx) {
      const [namespaces, impactAreas, topics] = await Promise.all([listNamespaces(ctx.pool), listActiveImpactAreas(ctx.pool), listActiveTopics(ctx.pool)]);
      return {
        ok: true,
        data: {
          namespaces: namespaces
            .filter((ns) => !ns.archivedAt && ctx.viewer.roles.isMemberOf(ns.id))
            .map((ns) => ({ id: ns.id, slug: ns.slug, name: ns.displayName })),
          impactAreas: impactAreas.map((a) => ({ id: a.id, name: a.name, requiresClientName: a.name === "Client" })),
          topics: topics.map((t) => ({ id: t.id, name: t.name, description: t.description })),
          challengeStatuses: [...CHALLENGE_STATUSES],
          solutionStatuses: [...SOLUTION_STATUSES],
          limits: {
            titleMax: TITLE_MAX,
            descriptionMax: DESCRIPTION_MAX,
            costVsBenefitsMax: COST_VS_BENEFITS_MAX,
            clientNameMax: CLIENT_NAME_MAX,
            commentMax: COMMENT_BODY_MAX,
          },
          anonymousSubmissionAvailable: true,
          restrictedContentShared: ctx.settings.restrictedContentEnabled,
        },
      };
    },
  },

  // ── Contribute (7) ──
  {
    name: "submit_challenge",
    title: "Submit a challenge",
    description:
      "Submits a new challenge as the signed-in person, shown as \"via agent\". It starts awaiting triage. Call innobox_find_similar_challenges first; pass the numbers you showed the person in similarAcknowledged. No attachments — the person adds files in the browser.",
    readOnly: false,
    bucket: "create",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: TITLE_MAX },
        description: { type: "string", maxLength: DESCRIPTION_MAX },
        impactAreaId: { type: "string" },
        namespaceId: { type: "string" },
        clientName: { type: "string", maxLength: CLIENT_NAME_MAX, description: "Only for the Client impact area" },
        visibility: { type: "string", enum: ["org", "namespace"], default: "org" },
        anonymous: { type: "boolean", default: false },
        topicIds: TOPIC_IDS_SCHEMA,
        similarAcknowledged: { type: "array", items: { type: "string" }, maxItems: 5 },
      },
      required: ["title", "description", "impactAreaId", "namespaceId"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const visibility = str(args, "visibility") ?? "org";
      if (visibility === "namespace" && ctx.viewer.orgVisibleOnly) {
        return fail(403, "Namespace-restricted challenges can't be created through an agent here — use the browser.");
      }
      const namespaceId = uuidArg(args, "namespaceId", true)!;
      const result = await createChallenge(
        ctx.pool,
        ctx.viewer,
        {
          impactAreaId: uuidArg(args, "impactAreaId", true)!,
          namespaceId,
          title: str(args, "title", { required: true }),
          description: str(args, "description", { required: true }),
          clientName: str(args, "clientName") ?? null,
          visibility,
          isAnonymous: bool(args, "anonymous") ?? false,
          similarAcknowledged: parseSimilarAcknowledged(args.similarAcknowledged),
          topicIds: topicIdsArg(args) ?? [],
        },
        via(ctx),
      );
      switch (result.status) {
        case "ok": {
          const c = result.challenge;
          await autoFollow(ctx.pool, ctx.viewer.userId, "challenge", c.id);
          await notifyChallengeSubmitted(notifyCtx(ctx), { id: c.id, number: c.number, title: c.title, namespaceId }).catch(
            logNotifyFailure("challenge.submitted notification failed"),
          );
          return { ok: true, data: { number: c.number, title: c.title, status: c.status, anonymous: c.author.anonymous, url: challengeUrl(ctx, c.number) } };
        }
        case "unknown_namespace":
          return fail(400, "namespace not found");
        case "namespace_archived":
          return fail(409, "this namespace is archived and accepts no new challenges");
        case "forbidden_namespace":
          return fail(403, "you are not a member of that namespace");
        case "unknown_impact_area":
          return fail(400, "impact area not found");
        case "inactive_impact_area":
          return fail(400, "impact area is retired");
        case "invalid_topics":
          return fail(422, TOPIC_SET_ERROR[result.problem]);
        case "attachments_not_clean":
        case "attachments_over_limit":
          return fail(409, "attachments can only be added in the browser");
        case "invalid":
          return fail(400, result.error);
      }
    },
  },
  {
    name: "propose_solution",
    title: "Propose a solution",
    description: "Proposes a solution to a challenge as the signed-in person, shown as \"via agent\". Only possible while the challenge is valid (canPropose on innobox_get_challenge).",
    readOnly: false,
    bucket: "create",
    inputSchema: {
      type: "object",
      properties: {
        challengeNumber: NUMBER_SCHEMA("Challenge"),
        description: { type: "string", maxLength: DESCRIPTION_MAX },
        costVsBenefits: { type: "string", maxLength: COST_VS_BENEFITS_MAX },
        anonymous: { type: "boolean", default: false },
      },
      required: ["challengeNumber", "description"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const number = itemNumber(args, "challengeNumber", "CH");
      const result = await createSolution(
        ctx.pool,
        ctx.viewer,
        number,
        { description: str(args, "description", { required: true }), costVsBenefits: str(args, "costVsBenefits") ?? null, isAnonymous: bool(args, "anonymous") ?? false },
        via(ctx),
      );
      switch (result.status) {
        case "ok": {
          const s = result.solution;
          await autoFollow(ctx.pool, ctx.viewer.userId, "solution", s.id);
          await notifySolutionProposed(notifyCtx(ctx), number, s).catch(logNotifyFailure("solution.proposed notification failed"));
          return { ok: true, data: { number: s.number, status: s.status, anonymous: s.author.anonymous, url: solutionUrl(ctx, number, s.number) } };
        }
        case "trashed": // §10.4: an agent never sees the trash, so it reads as missing
        case "not_found":
          return NOT_FOUND("challenge");
        case "namespace_archived":
          return fail(409, "this challenge's namespace is archived and accepts no new solutions");
        case "not_valid_status":
          return fail(409, "solutions can only be proposed while the challenge is valid");
        case "attachments_not_clean":
        case "attachments_over_limit":
          return fail(409, "attachments can only be added in the browser");
        case "invalid":
          return fail(400, result.error);
      }
    },
  },
  {
    name: "edit_challenge",
    title: "Edit my challenge",
    description: "Edits the title, description, impact area, client name or topics of the person's own challenge, inside its edit window (awaiting triage or needs improvement). Fields left out keep their value; topicIds replaces the topics.",
    readOnly: false,
    bucket: "mutation",
    inputSchema: {
      type: "object",
      properties: {
        number: NUMBER_SCHEMA("Challenge"),
        title: { type: "string", maxLength: TITLE_MAX },
        description: { type: "string", maxLength: DESCRIPTION_MAX },
        impactAreaId: { type: "string" },
        clientName: { type: "string", maxLength: CLIENT_NAME_MAX },
        topicIds: TOPIC_IDS_SCHEMA,
      },
      required: ["number"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const number = itemNumber(args, "number", "CH");
      const current = await getChallengeByNumber(ctx.pool, ctx.viewer, number);
      if (!current) return NOT_FOUND("challenge");
      const result = await editChallenge(
        ctx.pool,
        ctx.viewer,
        number,
        {
          title: str(args, "title") ?? current.title,
          description: str(args, "description") ?? current.description,
          clientName: args.clientName !== undefined ? str(args, "clientName") : current.clientName,
          impactAreaId: uuidArg(args, "impactAreaId") ?? current.impactAreaId,
          ...(args.topicIds !== undefined && args.topicIds !== null ? { topicIds: topicIdsArg(args) } : {}),
        },
        via(ctx),
      );
      switch (result.status) {
        case "ok":
          return { ok: true, data: { number: result.challenge.number, title: result.challenge.title, status: result.challenge.status, url: challengeUrl(ctx, number) } };
        case "trashed": // §10.4: an agent never sees the trash, so it reads as missing
        case "not_found":
          return NOT_FOUND("challenge");
        case "forbidden":
          return fail(403, "only the author can edit this challenge");
        case "not_editable":
          return fail(409, "this challenge is not editable in its current status");
        case "unknown_impact_area":
          return fail(400, "unknown impact area");
        case "inactive_impact_area":
          return fail(400, "that impact area is retired");
        case "invalid_topics":
          return fail(422, TOPIC_SET_ERROR[result.problem]);
        case "invalid":
          return fail(400, result.error);
      }
    },
  },
  {
    name: "edit_solution",
    title: "Edit my solution",
    description: "Edits the description or cost vs benefits of the person's own solution, inside its edit window. Fields left out keep their value.",
    readOnly: false,
    bucket: "mutation",
    inputSchema: {
      type: "object",
      properties: { number: NUMBER_SCHEMA("Solution"), description: { type: "string", maxLength: DESCRIPTION_MAX }, costVsBenefits: { type: "string", maxLength: COST_VS_BENEFITS_MAX } },
      required: ["number"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const number = itemNumber(args, "number", "SOL");
      const current = await getSolutionByNumber(ctx.pool, ctx.viewer, number);
      if (!current) return NOT_FOUND("solution");
      const result = await editSolution(
        ctx.pool,
        ctx.viewer,
        number,
        {
          description: str(args, "description") ?? current.solution.description,
          costVsBenefits: args.costVsBenefits !== undefined ? str(args, "costVsBenefits") : current.solution.costVsBenefits,
        },
        via(ctx),
      );
      switch (result.status) {
        case "ok":
          return { ok: true, data: { number: result.solution.number, status: result.solution.status, url: solutionUrl(ctx, current.challenge.number, number) } };
        case "trashed": // §10.4: an agent never sees the trash, so it reads as missing
        case "not_found":
          return NOT_FOUND("solution");
        case "forbidden":
          return fail(403, "only the author can edit this solution");
        case "not_editable":
          return fail(409, "this solution is not editable in its current status");
        case "invalid":
          return fail(400, result.error);
      }
    },
  },
  {
    name: "resubmit",
    title: "Resubmit my item",
    description: "Resubmits the person's own challenge or solution from needs improvement back to in review, after it has been edited. The reviewers are notified.",
    readOnly: false,
    bucket: "mutation",
    inputSchema: {
      type: "object",
      properties: { parentType: PARENT_SCHEMA, number: { type: ["string", "integer"], description: "The challenge or solution number" } },
      required: ["parentType", "number"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const type = parentType(args);
      if (type === "challenge") {
        const number = itemNumber(args, "number", "CH");
        const result = await resubmitChallenge(ctx.pool, ctx.viewer, number, via(ctx));
        if (result.status === "ok") {
          await notifyChallengeResubmitted(notifyCtx(ctx), number, result).catch(logNotifyFailure("challenge resubmit notification failed"));
          return { ok: true, data: { number: `CH-${number}`, status: "in_review", url: challengeUrl(ctx, number) } };
        }
        if (result.status === "not_found") return NOT_FOUND("challenge");
        if (result.status === "forbidden") return fail(403, "only the author can resubmit this challenge");
        return fail(409, "only a challenge in 'needs improvement' can be resubmitted");
      }
      const number = itemNumber(args, "number", "SOL");
      const result = await resubmitSolution(ctx.pool, ctx.viewer, number, via(ctx));
      if (result.status === "ok") {
        await notifySolutionResubmitted(notifyCtx(ctx), number, result).catch(logNotifyFailure("solution resubmit notification failed"));
        return { ok: true, data: { number: `SOL-${number}`, status: "in_review", url: solutionUrl(ctx, result.challengeNumber, number) } };
      }
      if (result.status === "not_found") return NOT_FOUND("solution");
      if (result.status === "forbidden") return fail(403, "only the author can resubmit this solution");
      return fail(409, "only a solution in 'needs improvement' can be resubmitted");
    },
  },
  {
    name: "post_comment",
    title: "Post a comment",
    description:
      "Posts a comment as the signed-in person on a challenge or solution they can see, shown as \"via agent\". Pass replyTo (a comment id from innobox_list_comments) to reply to a comment. Comments are never anonymous.",
    readOnly: false,
    bucket: "comment",
    inputSchema: {
      type: "object",
      properties: {
        parentType: PARENT_SCHEMA,
        number: { type: ["string", "integer"], description: "The challenge or solution number" },
        body: { type: "string", maxLength: COMMENT_BODY_MAX },
        replyTo: { type: "string", description: "The id of the comment this one answers (optional)" },
      },
      required: ["parentType", "number", "body"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const parent = await parentId(ctx, args);
      if (!parent.id) return NOT_FOUND(parent.type);
      const replyTo = str(args, "replyTo", { max: 100 }) ?? null;
      const result = await createComment(ctx.pool, ctx.viewer, parent.type, parent.id, str(args, "body", { required: true }), undefined, replyTo, via(ctx));
      if (result.status === "not_found" || result.status === "trashed") return NOT_FOUND(parent.type);
      if (result.status === "invalid") return fail(400, result.error);
      if (result.status === "unprocessable") return fail(422, result.error);
      await notifyCommentPosted(notifyCtx(ctx), parent.type, parent.id, ctx.viewer.userId, result.replyToAuthorId).catch(logNotifyFailure("comment notification failed"));
      return { ok: true, data: { id: result.comment.id, threadRootId: result.comment.threadRootId, replyToId: result.comment.replyToId, createdAt: result.comment.createdAt } };
    },
  },
  {
    name: "set_follow",
    title: "Follow or unfollow",
    description: "Follows (true) or unfollows (false) a challenge or solution, to be notified about it. Takes the wanted state, so repeating it is harmless.",
    readOnly: false,
    bucket: "mutation",
    inputSchema: {
      type: "object",
      properties: { parentType: PARENT_SCHEMA, number: { type: ["string", "integer"], description: "The challenge or solution number" }, following: { type: "boolean" } },
      required: ["parentType", "number", "following"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const wanted = bool(args, "following", true)!;
      const parent = await parentId(ctx, args);
      if (!parent.id) return NOT_FOUND(parent.type);
      const result = wanted ? await follow(ctx.pool, ctx.viewer, parent.type, parent.id) : await unfollow(ctx.pool, ctx.viewer, parent.type, parent.id);
      if (result.status === "not_found" || result.status === "trashed") return NOT_FOUND(parent.type);
      return { ok: true, data: { following: result.following } };
    },
  },
];

export function findTool(wireName: unknown): ToolDef | null {
  if (typeof wireName !== "string" || !wireName.startsWith(TOOL_PREFIX)) return null;
  return TOOLS.find((t) => t.name === wireName.slice(TOOL_PREFIX.length)) ?? null;
}

/** Runs a tool, turning an argument error into a 400 tool error. Everything else propagates. */
export async function runTool(tool: ToolDef, ctx: ToolContext, args: unknown): Promise<ToolResult> {
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  try {
    return await tool.run(ctx, record);
  } catch (err) {
    if (err instanceof ArgError) return { ok: false, status: 400, message: err.message };
    throw err;
  }
}

/** The `tools/list` entries: names prefixed, read tools `readOnlyHint: true` (clients may run them
 *  without asking), write tools `readOnlyHint: false` (clients ask the person first). */
export function toolListing(): Record<string, unknown>[] {
  return TOOLS.map((t) => ({
    name: `${TOOL_PREFIX}${t.name}`,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.readOnly,
      destructiveHint: false,
      idempotentHint: t.readOnly || t.name === "set_follow",
      openWorldHint: false,
    },
  }));
}
