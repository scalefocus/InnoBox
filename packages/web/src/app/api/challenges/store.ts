// Data layer for challenges/solutions/likes (INNOBOX_SPEC.md §13.1 first slice). Visibility
// (§4.3, invariant 2) and anonymity masking (§9, invariant 3) are applied here, not left to
// the caller — every read path funnels through canSeeChallenge/canSeeSolution/maskAuthor so
// there is exactly one place that can get it wrong. Every write commits atomically with its
// audit row (§15). Imports stay relative (not @/) so the gated dbtest can run under the
// plain node test runner (mirrors packages/web/src/app/api/admin/store.ts).
import type { Pool, PoolClient } from "pg";
import {
  addAccessForAssignment,
  areLikesFrozen,
  blocksAcceptedInternally,
  clearAccessList,
  deliverShareNotifications,
  isChallengeVisibility,
  listAccessEntries,
  parseAccessListInput,
  replaceAccessList,
  canAssignAtStatus,
  canAuthorEditChallenge,
  canAuthorEditSolution,
  canAuthorResubmit,
  canAuthorWithdrawChallenge,
  canAuthorWithdrawSolution,
  canSeeChallenge,
  canSeeSolution,
  challengeTargetsFor,
  decideTransition,
  formatChallengeNumber,
  formatSolutionNumber,
  isChallengeEnforcedTransition,
  isChallengeStatus,
  isStatusRefusedForExternal,
  isSolutionEnforcedTransition,
  isSolutionStatus,
  maskAuthor,
  siblingsToAutoClose,
  solutionEnforcedTargets,
  trashPurgesOn,
  validateChallengeFields,
  validateSolutionFields,
  viaAgentOf,
  type AccessEntryView,
  type AttachmentView,
  type ChallengeStatus,
  type ChallengeVisibility,
  type ChallengeVisibilityInput,
  type MaskedAuthor,
  type RoleSet,
  type SolutionStatus,
  type TransitionMode,
  type ViaAgent,
} from "@innobox/shared";
import { appendAudit } from "../../../lib/audit";
import { inTransaction } from "../../../lib/db";
import { isScanAvailable } from "../../../lib/clamav";
import { onChallengeStatusChanged, onSolutionImplemented } from "../../../lib/webhooks";
import {
  awardChallengeCreated,
  awardLikeReceived,
  awardSolutionCreated,
  challengeStatusAwards,
  replayOnSelfReveal,
  solutionStatusAwards,
  writeLiveAwards,
} from "../../../lib/gamification";
import { getAttachmentLimits } from "../admin/settings/store";
import { bindStagedAttachments, claimStagedAttachments, listAttachmentsForParent } from "../attachments/store";
import { isEntityNumber, isUuid, type ChallengeListFilters } from "./validation";
import { featuredDetailFields, type FeaturedDetailFields } from "./featured-rules";
import { unpinOnStatusChange } from "./featured-unpin";
import { onExternalChallengeClosed } from "./external";

export interface Viewer {
  userId: string;
  roles: RoleSet;
  /** §25.5: set for an AI agent's call while restricted content is not shared over MCP — every
   *  namespace-restricted challenge then behaves as if it did not exist (canSeeChallenge and
   *  pushChallengeVisibilityConditions both honour it). Never set for a browser request. */
  orgVisibleOnly?: boolean;
  /** §25: the call comes from an AI agent over MCP. An agent never sees an item in the §10.4
   *  trash — not even a platform admin's: the read-only trashed view is for the person in the
   *  browser, and trash, restore and delete are never done through an agent. */
  viaAgent?: boolean;
}

/** §25.8/§25.13: a write made through MCP — the client's registered name at that moment. Stored
 *  on what it creates (`mcp_client_name`) and added to the audit payload of every write. */
export interface AgentSource {
  clientName: string;
}

/** The audit-payload fields a write made through MCP adds (§25.13); nothing for the browser. */
export function agentAuditFields(via: AgentSource | undefined): { source?: "mcp"; client?: string } {
  return via ? { source: "mcp", client: via.clientName } : {};
}

/** §10.4: where a trashed item stands — sent to platform admins only (the trashed detail view). */
export interface TrashInfo {
  at: string;
  /** The display name of the platform admin who trashed it. */
  by: string;
  reason: string;
  /** `at + 30 days`: when the worker purges it unless it is restored first. */
  purgesOn: string;
}

export interface ChallengeListItem {
  id: string;
  number: string;
  title: string;
  author: MaskedAuthor;
  namespaceSlug: string;
  impactAreaName: string;
  status: ChallengeStatus;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  solutionCount: number;
  /** §13.1: created after the viewer last left the Challenges surface (and visible to them). */
  isNew: boolean;
}

export interface SolutionListItem {
  id: string;
  number: string;
  description: string;
  costVsBenefits: string | null;
  author: MaskedAuthor;
  isMine: boolean;
  status: SolutionStatus;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  canOverrideStatus: boolean;
  /** §9 audited admin reveal — namespace admin of the parent's namespace / platform admin. */
  canReveal: boolean;
  /** §9 one-way self-reveal — the solution's own anonymous author. */
  canSelfReveal: boolean;
  /** §7.2/§8.2 enforced transitions this viewer (committee/assignee, non-admin) may take from
   *  the current status. Empty for admins (they use the free-set override) and everyone else. */
  allowedTransitions: SolutionStatus[];
  /** §10.1 author actions available to this viewer on their own solution. */
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  /** §10.3 permanent delete — platform admins only, on any status, in the trash or not. */
  canDelete: boolean;
  /** §10.4 Move to trash — platform admins only, while neither it nor its challenge is trashed. */
  canTrash: boolean;
  /** §10.4 Restore — platform admins only, on a trashed solution (refused while its challenge is
   *  trashed too: `restoreBlocked`). */
  canRestore: boolean;
  /** §10.4: its challenge is in the trash, so Restore must wait for the challenge's. */
  restoreBlocked: boolean;
  /** §10.4: present for platform admins only — null unless this solution itself is trashed. */
  trashed?: TrashInfo | null;
  /** §11 attachments visible to this viewer (anonymity-safe; never carries uploaded_by). */
  attachments: AttachmentView[];
  /** §25.8 "via agent": null for the browser; the client name is masked on an anonymous item. */
  viaAgent: ViaAgent;
}

/** `FeaturedDetailFields`: the §13.2 `featured` / `canFeature` (+ admin-only provenance). */
export interface ChallengeDetail extends ChallengeListItem, FeaturedDetailFields {
  description: string;
  clientName: string | null;
  impactAreaId: string;
  visibility: ChallengeVisibility;
  /** §4.3 `people`: the access list — the item's namespace admins and platform admins only, and
   *  only while the visibility is `people`; null for everyone else and every other visibility. */
  access: AccessEntryView[] | null;
  namespaceId: string;
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  /** §13.6: the assignee's `users.active` (greyed bubble when false); null when unassigned. */
  assigneeActive: boolean | null;
  /** §13.6: the assignee is GDPR-scrubbed ("Deleted User" bubble); null when unassigned. */
  assigneeScrubbed: boolean | null;
  updatedAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  isMine: boolean;
  /** §6.2/§13.1: the Propose button is shown to every viewer but enabled only while `valid`
   *  and the namespace is not archived (§4.1). */
  canPropose: boolean;
  /** §4.1: the challenge's namespace is archived — picks the Propose button's hint (§13.1). */
  namespaceArchived: boolean;
  /** §8.3: a `solved` challenge freezes likes on itself and on its solutions (counts stay shown). */
  likesFrozen: boolean;
  /** §9 audited admin reveal — namespace admin of this namespace / platform admin, anonymous item. */
  canReveal: boolean;
  /** §9 one-way self-reveal — the author of an anonymous item. */
  canSelfReveal: boolean;
  /** §7.3 assign/unassign — namespace/platform admin, non-terminal status only. */
  canAssign: boolean;
  canOverrideStatus: boolean;
  /** §7.2 enforced transitions this viewer (committee/assignee, non-admin) may take. */
  allowedTransitions: ChallengeStatus[];
  /** §10.1 author actions available to this viewer on their own challenge. */
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  /** §10.3 permanent delete — platform admins only, on any status, in the trash or not. */
  canDelete: boolean;
  /** §10.4 Move to trash — platform admins only, while it is not already trashed. */
  canTrash: boolean;
  /** §10.4 Restore — platform admins only, on a trashed challenge. */
  canRestore: boolean;
  /** §10.4: present for platform admins only — null unless the challenge is in the trash, in
   *  which case every other control above is off (the read-only trashed view). */
  trashed?: TrashInfo | null;
  /** §24.6: set on a challenge accepted from the public form (for every viewer); null otherwise. */
  external: { company: string | null } | null;
  /** §24.6: the outside submitter's contact details — the item's namespace admins and platform
   *  admins only; null for everyone else and on every other challenge. */
  externalContact: ExternalContact | null;
  solutions: SolutionListItem[];
  /** §11 attachments on the challenge itself, visible to this viewer (anonymity-safe). */
  attachments: AttachmentView[];
  /** §25.8 "via agent": null for the browser; the client name is masked on an anonymous item. */
  viaAgent: ViaAgent;
}

/** §24.6 "Submitted from outside": name and e-mail are null once erased (§24.8). */
export interface ExternalContact {
  /** For the platform admin's "Erase contact details" action (§24.8). */
  submissionId: string;
  name: string | null;
  email: string | null;
  confirmedAt: string | null;
  erasedAt: string | null;
}

export interface ChallengeRow {
  id: string;
  number: string;
  title: string;
  description: string;
  status: string;
  visibility: ChallengeVisibility;
  namespace_id: string;
  namespace_slug: string;
  namespace_archived: boolean;
  impact_area_id: string;
  impact_area_name: string;
  client_name: string | null;
  /** Null for a challenge accepted from the public form (§24.6); the author columns are then null. */
  author_id: string | null;
  author_display_name: string | null;
  author_active: boolean | null;
  author_scrubbed: boolean | null;
  is_anonymous: boolean;
  /** §24.6: the submission behind an external challenge — company always, contact for admins only. */
  public_submission_id: string | null;
  external_company: string | null;
  external_name: string | null;
  external_email: string | null;
  external_confirmed_at: Date | null;
  external_erased_at: Date | null;
  assignee_id: string | null;
  assignee_display_name: string | null;
  assignee_active: boolean | null;
  assignee_scrubbed: boolean | null;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
  resolved_at: Date | null;
  like_count: string;
  liked_by_viewer: boolean;
  followed_by_viewer: boolean;
  solution_count: string;
  is_new: boolean;
  /** §13.2 Home pin (curation; never bumps updated_at). */
  featured_at: Date | null;
  featured_by_name: string | null;
  /** §10.4 trash (curation; never bumps updated_at). */
  trashed_at: Date | null;
  trashed_by_name: string | null;
  trash_reason: string | null;
  /** §25.8: the MCP client name at creation, null for the browser. */
  mcp_client_name: string | null;
}

interface SolutionRow {
  id: string;
  number: string;
  challenge_id: string;
  description: string;
  cost_vs_benefits: string | null;
  status: string;
  author_id: string;
  author_display_name: string;
  author_active: boolean;
  author_scrubbed: boolean;
  is_anonymous: boolean;
  created_at: Date;
  updated_at: Date;
  edited_at: Date | null;
  like_count: string;
  liked_by_viewer: boolean;
  followed_by_viewer: boolean;
  trashed_at: Date | null;
  trashed_by_name: string | null;
  trash_reason: string | null;
  mcp_client_name: string | null;
}

export const CHALLENGE_SELECT = `
  select c.id, c.number::text, c.title, c.description, c.status, c.visibility,
         c.namespace_id, ns.slug as namespace_slug, ns.archived_at is not null as namespace_archived,
         c.impact_area_id, ia.name as impact_area_name,
         c.client_name, c.author_id, u.display_name as author_display_name, u.active as author_active, u.scrubbed_at is not null as author_scrubbed, c.is_anonymous,
         c.public_submission_id, ps.company as external_company, ps.submitter_name as external_name, ps.submitter_email as external_email,
         ps.confirmed_at as external_confirmed_at, ps.contact_erased_at as external_erased_at,
         c.assignee_id, au.display_name as assignee_display_name, au.active as assignee_active, au.scrubbed_at is not null as assignee_scrubbed,
         c.created_at, c.updated_at, c.edited_at, c.resolved_at,
         (select count(*) from likes l where l.parent_type = 'challenge' and l.parent_id = c.id) as like_count,
         exists(select 1 from likes lv where lv.parent_type = 'challenge' and lv.parent_id = c.id and lv.user_id = $viewer) as liked_by_viewer,
         exists(select 1 from follows fv where fv.parent_type = 'challenge' and fv.parent_id = c.id and fv.user_id = $viewer) as followed_by_viewer,
         (select count(*) from solutions s where s.challenge_id = c.id and s.trashed_at is null
            and s.status not in ('rejected','not_selected','withdrawn','proposed')) as solution_count,
         (c.created_at > coalesce((select su.challenges_seen_at from users su where su.id = $viewer), '-infinity'::timestamptz)) as is_new,
         c.featured_at, (select fu.display_name from users fu where fu.id = c.featured_by) as featured_by_name,
         c.mcp_client_name,
         c.trashed_at, c.trash_reason, (select tu.display_name from users tu where tu.id = c.trashed_by) as trashed_by_name
    from challenges c
    left join users u on u.id = c.author_id
    left join public_submissions ps on ps.id = c.public_submission_id
    left join users au on au.id = c.assignee_id
    join namespaces ns on ns.id = c.namespace_id
    join impact_areas ia on ia.id = c.impact_area_id
`;

export function toListItem(row: ChallengeRow): ChallengeListItem {
  return {
    id: row.id,
    number: formatChallengeNumber(row.number),
    title: row.title,
    author: maskAuthor({
      isAnonymous: row.is_anonymous,
      authorId: row.author_id,
      authorDisplayName: row.author_display_name,
      authorActive: row.author_active,
      authorScrubbed: row.author_scrubbed,
      externalCompany: row.external_company,
    }),
    namespaceSlug: row.namespace_slug,
    impactAreaName: row.impact_area_name,
    status: row.status as ChallengeStatus,
    createdAt: row.created_at.toISOString(),
    likeCount: Number(row.like_count),
    likedByViewer: row.liked_by_viewer,
    followedByViewer: row.followed_by_viewer,
    solutionCount: Number(row.solution_count),
    isNew: row.is_new,
  };
}

/** True when the viewer may traverse the §7.2/§8.2 enforced graph for a challenge/solution in
 *  this namespace — a committee member of the namespace, or the challenge's assignee. */
function isEnforcer(viewer: Viewer, namespaceId: string, assigneeId: string | null): boolean {
  return viewer.roles.isCommittee(namespaceId) || (assigneeId !== null && assigneeId === viewer.userId);
}

/** §2.4 existence-not-disclosed: the visibility gate every by-number write path runs BEFORE any
 *  permission (403) or state (409) check, so an item the caller cannot see answers exactly like
 *  one that does not exist. Takes the raw challenge columns the write paths already select. */
function isChallengeRowVisible(viewer: Viewer, row: ChallengeVisibilityColumns): boolean {
  return canSeeChallenge(viewer, {
    id: row.id,
    namespaceId: row.namespace_id,
    visibility: row.visibility,
    status: row.status as ChallengeStatus,
    authorId: row.author_id,
    assigneeId: row.assignee_id,
    trashed: row.trashed,
  });
}

/** The raw challenge columns the by-number write paths select for the visibility gate. */
interface ChallengeVisibilityColumns {
  id: string;
  namespace_id: string;
  visibility: ChallengeVisibility;
  status: string;
  /** §4.3 `people`: the assignee may read it. */
  assignee_id: string | null;
  /** Null for a challenge accepted from the public form (§24.6). */
  author_id: string | null;
  /** §10.4: `trashed_at is not null`. */
  trashed: boolean;
}

/** The columns isSolutionRowVisible needs, as the `solutions s join challenges c` reads name them. */
interface SolutionVisibilityColumns {
  status: string;
  author_id: string;
  challenge_id: string;
  namespace_id: string;
  visibility: ChallengeVisibility;
  challenge_status: string;
  challenge_author_id: string | null;
  assignee_id: string | null;
  /** §10.4: the solution itself is trashed. */
  trashed: boolean;
  /** §10.4: its challenge is trashed. */
  challenge_trashed: boolean;
}

const SOLUTION_VISIBILITY_SELECT = `s.status, s.author_id, c.id as challenge_id, c.namespace_id, c.visibility, c.status as challenge_status,
            c.author_id as challenge_author_id, c.assignee_id,
            s.trashed_at is not null as trashed, c.trashed_at is not null as challenge_trashed`;

/** The solution counterpart: the parent challenge must be visible AND the solution itself (a
 *  `proposed` solution is narrower still, §4.3). */
function isSolutionRowVisible(viewer: Viewer, row: SolutionVisibilityColumns): boolean {
  const challengeVisible = canSeeChallenge(viewer, {
    id: row.challenge_id,
    namespaceId: row.namespace_id,
    visibility: row.visibility,
    status: row.challenge_status as ChallengeStatus,
    authorId: row.challenge_author_id,
    assigneeId: row.assignee_id,
    trashed: row.challenge_trashed,
  });
  if (!challengeVisible) return false;
  return canSeeSolution(
    viewer,
    { namespaceId: row.namespace_id, assigneeId: row.assignee_id },
    { status: row.status as SolutionStatus, authorId: row.author_id, trashed: row.trashed },
  );
}

/** §10.4: true when a by-number write must be refused because the item (or, for a solution, its
 *  challenge) is in the trash. Runs AFTER the visibility gate, so only a platform admin ever gets
 *  this answer (409); everyone else was already told "not found". */
function isRowTrashed(row: { trashed: boolean; challenge_trashed?: boolean }): boolean {
  return row.trashed || row.challenge_trashed === true;
}

/** §10.4: the trash state a platform admin sees on the detail payload. */
function toTrashInfo(row: { trashed_at: Date | null; trashed_by_name: string | null; trash_reason: string | null }): TrashInfo | null {
  if (row.trashed_at === null) return null;
  return {
    at: row.trashed_at.toISOString(),
    by: row.trashed_by_name ?? "",
    reason: row.trash_reason ?? "",
    purgesOn: trashPurgesOn(row.trashed_at).toISOString(),
  };
}

/** §24.6: the contact panel's data — for the item's namespace admins and platform admins only. */
function externalContactFor(row: ChallengeRow, isAdmin: boolean): ExternalContact | null {
  if (!isAdmin || row.public_submission_id === null) return null;
  return {
    submissionId: row.public_submission_id,
    name: row.external_name,
    email: row.external_email,
    confirmedAt: row.external_confirmed_at ? row.external_confirmed_at.toISOString() : null,
    erasedAt: row.external_erased_at ? row.external_erased_at.toISOString() : null,
  };
}

function toDetail(
  row: ChallengeRow,
  viewer: Viewer,
  solutions: SolutionListItem[],
  attachments: AttachmentView[] = [],
  access: AccessEntryView[] | null = null,
): ChallengeDetail {
  // §10.4: a trashed challenge (seen by platform admins only) is read-only — every control is off
  // except Restore and Delete permanently.
  const live = row.trashed_at === null;
  const isAdmin = live && viewer.roles.isNamespaceAdmin(row.namespace_id);
  const isMine = row.author_id !== null && viewer.userId === row.author_id;
  const isLiveMine = live && isMine;
  const isPlatformAdmin = viewer.roles.isPlatformAdmin;
  const status = row.status as ChallengeStatus;
  const external = row.public_submission_id !== null;
  return {
    ...toListItem(row),
    description: row.description,
    clientName: row.client_name,
    impactAreaId: row.impact_area_id,
    visibility: row.visibility,
    access: row.visibility === "people" && viewer.roles.isNamespaceAdmin(row.namespace_id) ? access : null,
    namespaceId: row.namespace_id,
    assigneeId: row.assignee_id,
    assigneeDisplayName: row.assignee_display_name,
    assigneeActive: row.assignee_id === null ? null : row.assignee_active,
    assigneeScrubbed: row.assignee_id === null ? null : row.assignee_scrubbed,
    updatedAt: row.updated_at.toISOString(),
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    isMine,
    canPropose: live && row.status === "valid" && !row.namespace_archived,
    namespaceArchived: row.namespace_archived,
    likesFrozen: areLikesFrozen(status),
    canReveal: isAdmin && row.is_anonymous,
    canSelfReveal: isLiveMine && row.is_anonymous,
    canAssign: isAdmin && canAssignAtStatus(status),
    canOverrideStatus: isAdmin,
    allowedTransitions:
      live && !isAdmin && isEnforcer(viewer, row.namespace_id, row.assignee_id)
        ? challengeTargetsFor(status, external)
        : [],
    canEdit: isLiveMine && canAuthorEditChallenge(status),
    canWithdraw: isLiveMine && canAuthorWithdrawChallenge(status),
    canResubmit: isLiveMine && canAuthorResubmit(status),
    canDelete: isPlatformAdmin,
    canTrash: isPlatformAdmin && live,
    canRestore: isPlatformAdmin && !live,
    ...(isPlatformAdmin ? { trashed: toTrashInfo(row) } : {}),
    external: external ? { company: row.external_company } : null,
    // Read-only on a trashed challenge too: the contact panel shows, its Erase does not.
    externalContact: externalContactFor(row, viewer.roles.isNamespaceAdmin(row.namespace_id)),
    solutions,
    attachments,
    viaAgent: viaAgentOf(row.mcp_client_name, row.is_anonymous),
    ...featuredDetailFields({
      isPlatformAdmin: isPlatformAdmin && live,
      status: row.status,
      featuredAt: row.featured_at,
      featuredByName: row.featured_by_name,
    }),
  };
}

/** The parent challenge as toSolutionItem needs it. `trashed` is the challenge's own trash flag. */
interface SolutionParentContext {
  namespaceId: string;
  assigneeId: string | null;
  trashed: boolean;
}

function solutionParentContext(row: { namespace_id: string; assignee_id: string | null; trashed_at: Date | null }): SolutionParentContext {
  return { namespaceId: row.namespace_id, assigneeId: row.assignee_id, trashed: row.trashed_at !== null };
}

function toSolutionItem(
  row: SolutionRow,
  viewer: Viewer,
  challenge: SolutionParentContext,
  attachments: AttachmentView[] = [],
): SolutionListItem {
  // §10.4: a solution in the trash, or under a trashed challenge, is read-only (platform admins
  // are the only ones who see either).
  const selfTrashed = row.trashed_at !== null;
  const live = !selfTrashed && !challenge.trashed;
  const isPlatformAdmin = viewer.roles.isPlatformAdmin;
  const isAdmin = live && viewer.roles.isNamespaceAdmin(challenge.namespaceId);
  const isMine = viewer.userId === row.author_id;
  const isLiveMine = live && isMine;
  const status = row.status as SolutionStatus;
  return {
    id: row.id,
    number: formatSolutionNumber(row.number),
    description: row.description,
    costVsBenefits: row.cost_vs_benefits,
    author: maskAuthor({
      isAnonymous: row.is_anonymous,
      authorId: row.author_id,
      authorDisplayName: row.author_display_name,
      authorActive: row.author_active,
      authorScrubbed: row.author_scrubbed,
    }),
    isMine,
    status,
    createdAt: row.created_at.toISOString(),
    likeCount: Number(row.like_count),
    likedByViewer: row.liked_by_viewer,
    followedByViewer: row.followed_by_viewer,
    canOverrideStatus: isAdmin,
    canReveal: isAdmin && row.is_anonymous,
    canSelfReveal: isLiveMine && row.is_anonymous,
    allowedTransitions:
      live && !isAdmin && isEnforcer(viewer, challenge.namespaceId, challenge.assigneeId)
        ? solutionEnforcedTargets(status)
        : [],
    canEdit: isLiveMine && canAuthorEditSolution(status),
    canWithdraw: isLiveMine && canAuthorWithdrawSolution(status),
    canResubmit: isLiveMine && canAuthorResubmit(status),
    canDelete: isPlatformAdmin,
    canTrash: isPlatformAdmin && live,
    canRestore: isPlatformAdmin && selfTrashed,
    restoreBlocked: selfTrashed && challenge.trashed,
    ...(isPlatformAdmin ? { trashed: toTrashInfo(row) } : {}),
    attachments,
    viaAgent: viaAgentOf(row.mcp_client_name, row.is_anonymous),
  };
}

/** Build the full challenge detail for a viewer, including §11 attachments on the challenge
 *  and on each visible solution (anonymity-safe projection). Used by the two full read paths
 *  (`getChallengeByNumber`, `reloadChallengeDetail`); the leaner write paths return the detail
 *  without attachments (the client re-fetches immediately after a mutation). */
async function buildDetailWithAttachments(db: Pool | PoolClient, viewer: Viewer, row: ChallengeRow): Promise<ChallengeDetail> {
  const solutionRows = await fetchSolutionRows(db, row.id, viewer.userId);
  const challengeCtx = solutionParentContext(row);
  const solutions: SolutionListItem[] = [];
  for (const s of solutionRows) {
    if (!isSolutionListed(viewer, challengeCtx, s)) continue;
    const solutionAttachments = await listAttachmentsForParent(db, viewer, "solution", s.id);
    solutions.push(toSolutionItem(s, viewer, challengeCtx, solutionAttachments));
  }
  const challengeAttachments = await listAttachmentsForParent(db, viewer, "challenge", row.id);
  // §4.3: who is on a `people` list is the item's admins' business only.
  const access = row.visibility === "people" && viewer.roles.isNamespaceAdmin(row.namespace_id) ? await listAccessEntries(db, row.id) : null;
  return toDetail(row, viewer, solutions, challengeAttachments, access);
}

/** The §4.3 solution gate as the detail builders apply it — a trashed solution (§10.4) is listed
 *  for platform admins only, read-only. */
function isSolutionListed(viewer: Viewer, challenge: SolutionParentContext, s: SolutionRow): boolean {
  return canSeeSolution(viewer, challenge, { status: s.status as SolutionStatus, authorId: s.author_id, trashed: s.trashed_at !== null });
}

async function fetchSolutionRows(db: Pool | PoolClient, challengeId: string, viewerId: string): Promise<SolutionRow[]> {
  const { rows } = await db.query<SolutionRow>(
    `select s.id, s.number::text, s.challenge_id, s.description, s.cost_vs_benefits, s.status,
            s.author_id, u.display_name as author_display_name, u.active as author_active, u.scrubbed_at is not null as author_scrubbed, s.is_anonymous,
            s.created_at, s.updated_at, s.edited_at, s.mcp_client_name,
            s.trashed_at, s.trash_reason, (select tu.display_name from users tu where tu.id = s.trashed_by) as trashed_by_name,
            (select count(*) from likes l where l.parent_type = 'solution' and l.parent_id = s.id) as like_count,
            exists(select 1 from likes lv where lv.parent_type = 'solution' and lv.parent_id = s.id and lv.user_id = $2) as liked_by_viewer,
            exists(select 1 from follows fv where fv.parent_type = 'solution' and fv.parent_id = s.id and fv.user_id = $2) as followed_by_viewer
       from solutions s
       join users u on u.id = s.author_id
      where s.challenge_id = $1
      order by s.created_at asc`,
    [challengeId, viewerId],
  );
  return rows;
}

// ── Impact areas ─────────────────────────────────────────────────────────────────────────

export interface ImpactAreaRecord {
  id: string;
  name: string;
  active: boolean;
}

export async function listActiveImpactAreas(pool: Pool): Promise<ImpactAreaRecord[]> {
  const { rows } = await pool.query<ImpactAreaRecord>(
    `select id, name, active from impact_areas where active = true order by name`,
  );
  return rows;
}

// ── List / detail ────────────────────────────────────────────────────────────────────────

/** The namespaces where the viewer holds an explicit grant of one of `roles`. */
function namespacesWithRole(viewer: Viewer, roles: readonly string[]): string[] {
  return viewer.roles.grants.filter((g) => roles.includes(g.role) && g.namespaceId !== null).map((g) => g.namespaceId as string);
}

/** The §4.3 row-level visibility predicate over `challenges c` — the SQL twin of
 *  `canSeeChallenge`, shared by the gallery list, the §13.1 new-count, search, the dashboard and
 *  the profile's follow lists so none of them can disagree with the detail page about what the
 *  viewer may see. awaiting_triage/withdrawn are visible to the author and the namespace's admins
 *  — the state rule REPLACES the namespace rule, so an author who has lost membership of a
 *  restricted namespace still finds their own item; every other status is org-visible,
 *  member-only, or — for `people` — open to the access list, the namespace's admins and
 *  committee, and the assignee. Platform admins see everything — except the trash (§10.4): a trashed challenge
 *  is gone from every list for everyone, platform admins included (they reach it through the
 *  trash page instead). */
export function pushChallengeVisibilityConditions(viewer: Viewer, push: (v: unknown) => string, conditions: string[]): void {
  conditions.push(`c.trashed_at is null`);
  // §25.5: an agent's view while restricted content is not shared — before the platform-admin
  // shortcut, since the switch governs what leaves through MCP whoever the person is.
  if (viewer.orgVisibleOnly) conditions.push(`c.visibility = 'org'`);
  if (viewer.roles.isPlatformAdmin) return;
  const viewerParam = push(viewer.userId);
  const memberNamespaceIds = viewer.roles.memberNamespaces();
  const namespaceAdminIds = namespacesWithRole(viewer, ["namespace_admin"]);
  const reviewerNamespaceIds = namespacesWithRole(viewer, ["committee", "namespace_admin"]);
  conditions.push(
    `(CASE WHEN c.status IN ('awaiting_triage','withdrawn')
           THEN c.author_id = ${viewerParam} OR c.namespace_id = ANY(${push(namespaceAdminIds)}::uuid[])
           WHEN c.visibility = 'people'
           THEN c.namespace_id = ANY(${push(reviewerNamespaceIds)}::uuid[]) OR c.assignee_id = ${viewerParam}
                OR c.id = ANY(${push(viewer.roles.accessListChallenges())}::uuid[])
           ELSE c.visibility = 'org' OR c.namespace_id = ANY(${push(memberNamespaceIds)}::uuid[]) END)`,
  );
}

/** The SQL twin of `canSeeSolution` over `solutions s join challenges c` (§4.3): a `proposed`
 *  solution is visible only to its author, the challenge's assignee, and the namespace's
 *  committee/admins. It narrows only — pair it with pushChallengeVisibilityConditions for the
 *  parent, exactly as the JS gate is paired with canSeeChallenge. Running it inside the query
 *  keeps hidden rows from filling a `limit` ahead of visible ones. Platform admins see all but
 *  the trash (§10.4): a trashed solution is gone from every list for everyone. */
export function pushSolutionVisibilityConditions(viewer: Viewer, push: (v: unknown) => string, conditions: string[]): void {
  conditions.push(`s.trashed_at is null`);
  if (viewer.roles.isPlatformAdmin) return;
  const viewerParam = push(viewer.userId);
  const reviewerNamespaceIds = namespacesWithRole(viewer, ["committee", "namespace_admin"]);
  conditions.push(
    `(s.status <> 'proposed' OR s.author_id = ${viewerParam} OR c.assignee_id = ${viewerParam}
      OR c.namespace_id = ANY(${push(reviewerNamespaceIds)}::uuid[]))`,
  );
}

// ── §6.1 duplicate warning ───────────────────────────────────────────────────────────────

export interface SimilarChallenge {
  number: string;
  title: string;
  status: ChallengeStatus;
  author: MaskedAuthor;
}

/** At most this many matches are shown in the warning. */
export const SIMILAR_LIMIT = 5;
/** The minimum rank: a candidate must share at least this many distinct stemmed terms with the
 *  submission (title + description). One shared word ("process", "team") is noise; two is the
 *  smallest overlap that reads as "about the same thing". A one-term submission needs one. */
export const SIMILAR_MIN_SHARED_TERMS = 2;
/** Terms the query is built from: every title term, then description terms, up to this cap. */
const SIMILAR_MAX_TERMS = 48;

/**
 * Ranks the viewer's VISIBLE challenges (the gallery's own predicate, invariant 2) against what
 * they are about to submit, over the §13.4 full-text index. Excludes rejected and withdrawn —
 * keeps solved, the most useful hit. Terms are OR-ed (a phrase-AND would match almost nothing
 * once a description is involved), candidates are ordered by ts_rank with the title weighted
 * highest, and only those sharing SIMILAR_MIN_SHARED_TERMS distinct terms survive. Authors are
 * masked per §9. Advisory: nothing here can block a submission.
 */
export async function findSimilarChallenges(pool: Pool, viewer: Viewer, input: { title: string; description: string }): Promise<SimilarChallenge[]> {
  return (await findSimilarChallengeCandidates(pool, viewer, input)).map(({ visibility: _v, excerpt: _e, ...publicFields }) => publicFields);
}

/** A §6.1 match plus what the §22.12 explanation step may send for it — never returned to the
 *  browser: the visibility (restricted candidates are dropped from the AI input while the switch
 *  is off) and the first 500 characters of the description. */
export interface SimilarCandidate extends SimilarChallenge {
  visibility: ChallengeVisibility;
  excerpt: string;
}

/** findSimilarChallenges with the internal fields the explanation step needs. Same set, same order. */
export async function findSimilarChallengeCandidates(pool: Pool, viewer: Viewer, input: { title: string; description: string }): Promise<SimilarCandidate[]> {
  // Distinct stems, title first, capped — computed by Postgres's own English parser so the query
  // terms are exactly the lexemes stored in challenges.search_vector.
  const { rows: termRows } = await pool.query<{ term: string }>(
    `select term from (
       select t.term, min(t.ord) as ord
         from (
           select l as term, 0 as ord from unnest(tsvector_to_array(to_tsvector('english', $1))) l
           union all
           select l as term, 1 as ord from unnest(tsvector_to_array(to_tsvector('english', $2))) l
         ) t
        group by t.term
     ) d
     order by ord, term
     limit ${SIMILAR_MAX_TERMS}`,
    [input.title, input.description],
  );
  const terms = termRows.map((r) => r.term);
  if (terms.length === 0) return [];
  const minShared = Math.min(SIMILAR_MIN_SHARED_TERMS, terms.length);

  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const termsParam = push(terms);
  // Each stem is quoted as a tsquery literal, so punctuation inside a lexeme can never be read
  // as tsquery syntax.
  const tsquery = `to_tsquery('simple', (select string_agg(quote_literal(t), ' | ') from unnest(${termsParam}::text[]) t))`;
  const conditions: string[] = [`c.search_vector @@ ${tsquery}`, `c.status not in ('rejected', 'withdrawn')`];
  pushChallengeVisibilityConditions(viewer, push, conditions);

  const { rows } = await pool.query<{
    number: string;
    title: string;
    status: string;
    is_anonymous: boolean;
    author_id: string | null;
    author_display_name: string | null;
    author_active: boolean | null;
    author_scrubbed: boolean | null;
    external_company: string | null;
    visibility: "org" | "namespace";
    excerpt: string;
    shared: number;
  }>(
    `select * from (
       select c.number::text, c.title, c.status, c.is_anonymous, c.author_id, u.display_name as author_display_name,
              u.active as author_active, u.scrubbed_at is not null as author_scrubbed, ps.company as external_company,
              c.visibility, left(c.description, 500) as excerpt,
              ts_rank(c.search_vector, ${tsquery}) as rank,
              (select count(*)::int from unnest(tsvector_to_array(c.search_vector)) l where l = any(${termsParam}::text[])) as shared
         from challenges c
         left join users u on u.id = c.author_id
         left join public_submissions ps on ps.id = c.public_submission_id
        where ${conditions.join(" and ")}
        order by rank desc, c.created_at desc
        limit 50
     ) ranked
     where shared >= ${push(minShared)}
     order by rank desc
     limit ${SIMILAR_LIMIT}`,
    params,
  );
  return rows.map((r) => ({
    number: formatChallengeNumber(r.number),
    title: r.title,
    status: r.status as ChallengeStatus,
    author: maskAuthor({
      isAnonymous: r.is_anonymous,
      authorId: r.author_id,
      authorDisplayName: r.author_display_name,
      authorActive: r.author_active,
      authorScrubbed: r.author_scrubbed,
      externalCompany: r.external_company,
    }),
    visibility: r.visibility,
    excerpt: r.excerpt,
  }));
}

/** §13.1: challenges visible to the viewer and created since they last left the Challenges
 *  surface. A bare count for the nav bubble — nothing else leaves this function. A viewer whose
 *  marker is NULL (never visited) counts everything they can see. */
export async function countNewChallenges(pool: Pool, viewer: Viewer): Promise<number> {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, conditions);
  conditions.push(`c.created_at > coalesce((select su.challenges_seen_at from users su where su.id = ${push(viewer.userId)}), '-infinity'::timestamptz)`);
  const { rows } = await pool.query<{ count: string }>(`select count(*)::text as count from challenges c where ${conditions.join(" and ")}`, params);
  return Number(rows[0]?.count ?? 0);
}

export async function listChallenges(
  pool: Pool,
  viewer: Viewer,
  filters: ChallengeListFilters,
): Promise<ChallengeListItem[]> {
  const params: unknown[] = [];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const viewerParam = push(viewer.userId); // used by the $viewer placeholder in CHALLENGE_SELECT

  const conditions: string[] = [];
  pushChallengeVisibilityConditions(viewer, push, conditions);

  if (filters.tab === "open") {
    conditions.push(`c.status IN ('in_review','needs_improvement','meeting_scheduled','valid')`);
  } else if (filters.tab === "mine") {
    conditions.push(`c.author_id = ${push(viewer.userId)}`);
  } else {
    conditions.push(`c.status IN ('solved','rejected')`);
  }

  if (filters.status) conditions.push(`c.status = ${push(filters.status)}`);
  if (filters.impactAreaId) conditions.push(`c.impact_area_id = ${push(filters.impactAreaId)}`);
  if (filters.namespaceId) conditions.push(`c.namespace_id = ${push(filters.namespaceId)}`);
  if (filters.authorName) {
    // Anonymity-safety: a name filter must never distinguish "not a match" from "hidden
    // because anonymous" — so anonymous items are unconditionally excluded whenever this
    // filter is active, rather than matched against their (masked) true author name.
    conditions.push(`c.is_anonymous = false AND u.display_name ILIKE ${push(`%${filters.authorName}%`)}`);
  }

  const orderBy =
    filters.sort === "most_liked"
      ? "like_count DESC, c.created_at DESC"
      : filters.sort === "most_solutions"
        ? "solution_count DESC, c.created_at DESC"
        : "c.created_at DESC";

  const whereClause = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const sql = `${CHALLENGE_SELECT.replaceAll("$viewer", viewerParam)} ${whereClause} order by ${orderBy} limit 100`;

  const { rows } = await pool.query<ChallengeRow>(sql, params);
  return rows.map(toListItem);
}

/** Folds "doesn't exist" and "exists but not visible" into the same null result — an
 *  invisible item must never be distinguishable from a nonexistent one (no 404-vs-403
 *  existence oracle). */
export async function getChallengeByNumber(pool: Pool, viewer: Viewer, number: string): Promise<ChallengeDetail | null> {
  if (!isEntityNumber(number)) return null; // §2.4: a malformed number is "not found", no DB round-trip
  const { rows } = await pool.query<ChallengeRow>(
    `${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.number = $1`,
    [number, viewer.userId],
  );
  const row = rows[0];
  if (!row) return null;
  const visible = canSeeChallenge(viewer, {
    id: row.id,
    namespaceId: row.namespace_id,
    visibility: row.visibility,
    status: row.status as ChallengeStatus,
    authorId: row.author_id,
    assigneeId: row.assignee_id,
    trashed: row.trashed_at !== null,
  });
  if (!visible) return null;

  return buildDetailWithAttachments(pool, viewer, row);
}

// ── Create ───────────────────────────────────────────────────────────────────────────────

export type CreateChallengeResult =
  | { status: "ok"; challenge: ChallengeDetail }
  | { status: "unknown_namespace" }
  | { status: "namespace_archived" }
  | { status: "forbidden_namespace" }
  | { status: "unknown_impact_area" }
  | { status: "inactive_impact_area" }
  | { status: "attachments_not_clean" }
  | { status: "attachments_over_limit" }
  | { status: "invalid"; error: string };

export async function createChallenge(
  pool: Pool,
  author: Viewer,
  input: {
    impactAreaId: string;
    namespaceId: string;
    title: unknown;
    description: unknown;
    clientName: unknown;
    visibility: unknown;
    isAnonymous: unknown;
    draftKey?: unknown;
    /** §6.1: the similar challenges the submitter saw and submitted past (already parsed). */
    similarAcknowledged?: string[];
  },
  via?: AgentSource,
): Promise<CreateChallengeResult> {
  const { rows: nsRows } = await pool.query<{ id: string; archived: boolean }>(
    `select id, archived_at is not null as archived from namespaces where id = $1`,
    [input.namespaceId],
  );
  if (!nsRows[0]) return { status: "unknown_namespace" };
  // §4.1: archiving blocks new submissions — a distinct 409, not the unknown-id 400.
  if (nsRows[0].archived) return { status: "namespace_archived" };
  // Submission targeting (§4.3): a user may submit into any namespace they are a member
  // of (everyone can use global).
  if (!author.roles.isMemberOf(input.namespaceId)) return { status: "forbidden_namespace" };

  const { rows: areaRows } = await pool.query<{ id: string; name: string; active: boolean }>(
    `select id, name, active from impact_areas where id = $1`,
    [input.impactAreaId],
  );
  const area = areaRows[0];
  if (!area) return { status: "unknown_impact_area" };
  if (!area.active) return { status: "inactive_impact_area" };

  const validated = validateChallengeFields({
    title: input.title,
    description: input.description,
    clientName: input.clientName,
    visibility: input.visibility,
    isAnonymous: input.isAnonymous,
    impactAreaIsClient: area.name === "Client",
  });
  if (!validated.ok) return { status: "invalid", error: validated.error };

  // §11 staging: bind any files staged during the form to this challenge (in-transaction).
  const draftKey = typeof input.draftKey === "string" && isUuid(input.draftKey) ? input.draftKey : null;
  // §11 scan gate: when a scanner is available, refuse to submit while any staged file is still
  // scanning, infected, or unscannable — so a challenge is only ever born with clean attachments. When ClamAV
  // is unavailable the platform fails open and pending files bind as before (scanned later). The
  // probe runs here (a network call, never inside the transaction); the checks run in it.
  const requireClean = draftKey ? await isScanAvailable() : false;
  const maxPerItem = draftKey ? (await getAttachmentLimits(pool)).maxPerItem : 0;

  return inTransaction(pool, async (client): Promise<CreateChallengeResult> => {
    // Claim (lock + check) the staged rows before anything is written, so a refusal leaves no trace.
    const staged = draftKey ? await claimStagedAttachments(client, author, "challenge", draftKey, { maxPerItem, requireClean }) : null;
    if (staged && staged.status !== "ok") return staged;
    const { rows } = await client.query<{ id: string }>(
      `insert into challenges (namespace_id, visibility, title, description, impact_area_id, client_name, is_anonymous, author_id, mcp_client_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        input.namespaceId,
        validated.value.visibility,
        validated.value.title,
        validated.value.description,
        input.impactAreaId,
        validated.value.clientName,
        validated.value.isAnonymous,
        author.userId,
        via?.clientName ?? null,
      ],
    );
    const id = rows[0]!.id;
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "challenge.created",
      targetType: "challenge",
      targetId: id,
      after: {
        title: validated.value.title,
        namespaceId: input.namespaceId,
        visibility: validated.value.visibility,
        isAnonymous: validated.value.isAnonymous,
        // §6.1: present only when the author submitted past a duplicate warning.
        ...(input.similarAcknowledged && input.similarAcknowledged.length > 0 ? { similarAcknowledged: input.similarAcknowledged } : {}),
        ...agentAuditFields(via),
      },
    });
    // §23.2: challenge_submitted (none while anonymous).
    await awardChallengeCreated(client, { id, authorId: author.userId, isAnonymous: validated.value.isAnonymous });
    if (draftKey && staged) await bindStagedAttachments(client, author, "challenge", id, draftKey, staged.ids);
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      id,
      author.userId,
    ]);
    const attachments = await listAttachmentsForParent(client, author, "challenge", id);
    return { status: "ok", challenge: toDetail(full[0]!, author, [], attachments) };
  });
}

export type CreateSolutionResult =
  | { status: "ok"; solution: SolutionListItem }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "namespace_archived" }
  | { status: "not_valid_status" }
  | { status: "attachments_not_clean" }
  | { status: "attachments_over_limit" }
  | { status: "invalid"; error: string };

export async function createSolution(
  pool: Pool,
  author: Viewer,
  challengeNumber: string,
  input: { description: unknown; costVsBenefits: unknown; isAnonymous: unknown; draftKey?: unknown },
  via?: AgentSource,
): Promise<CreateSolutionResult> {
  if (!isEntityNumber(challengeNumber)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string; assignee_id: string | null; namespace_archived: boolean }>(
    `select c.id, c.namespace_id, c.visibility, c.status, c.author_id, c.assignee_id, n.archived_at is not null as namespace_archived,
            c.trashed_at is not null as trashed
       from challenges c join namespaces n on n.id = c.namespace_id
      where c.number = $1`,
    [challengeNumber],
  );
  const challenge = rows[0];
  if (!challenge || !isChallengeRowVisible(author, challenge)) return { status: "not_found" };
  if (challenge.trashed) return { status: "trashed" }; // §10.4
  // §4.1: an archived namespace takes no new solution on any of its challenges.
  if (challenge.namespace_archived) return { status: "namespace_archived" };
  // §6.2: proposing is allowed ONLY while the challenge is `valid`.
  if (challenge.status !== "valid") return { status: "not_valid_status" };

  const validated = validateSolutionFields(input);
  if (!validated.ok) return { status: "invalid", error: validated.error };

  // §11 staging: bind any files staged during the propose form to this solution (in-transaction).
  const draftKey = typeof input.draftKey === "string" && isUuid(input.draftKey) ? input.draftKey : null;
  // §11 scan gate + cap re-check (see createChallenge): block submit on unclean staged files when
  // a scanner is up, and on more staged files than the cap allows.
  const requireClean = draftKey ? await isScanAvailable() : false;
  const maxPerItem = draftKey ? (await getAttachmentLimits(pool)).maxPerItem : 0;

  return inTransaction(pool, async (client): Promise<CreateSolutionResult> => {
    const staged = draftKey ? await claimStagedAttachments(client, author, "solution", draftKey, { maxPerItem, requireClean }) : null;
    if (staged && staged.status !== "ok") return staged;
    const { rows: inserted } = await client.query<{ id: string }>(
      `insert into solutions (challenge_id, description, cost_vs_benefits, is_anonymous, author_id, mcp_client_name)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [challenge.id, validated.value.description, validated.value.costVsBenefits, validated.value.isAnonymous, author.userId, via?.clientName ?? null],
    );
    const id = inserted[0]!.id;
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "solution.created",
      targetType: "solution",
      targetId: id,
      after: { challengeId: challenge.id, isAnonymous: validated.value.isAnonymous, ...agentAuditFields(via) },
    });
    await awardSolutionCreated(client, { id, authorId: author.userId, isAnonymous: validated.value.isAnonymous }); // §23.2
    if (draftKey && staged) await bindStagedAttachments(client, author, "solution", id, draftKey, staged.ids);
    const solutionRows = await fetchSolutionRows(client, challenge.id, author.userId);
    const row = solutionRows.find((s) => s.id === id)!;
    return { status: "ok", solution: toSolutionItem(row, author, { namespaceId: challenge.namespace_id, assigneeId: challenge.assignee_id, trashed: false }) };
  });
}

// ── Status transitions: admin override + committee/assignee enforced (§7.2/§8.2, invariant 6) ─

export type SetChallengeStatusResult =
  | { status: "ok"; challenge: ChallengeDetail; changed: boolean; previousStatus: string }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "illegal_transition" }
  | { status: "invalid_status" }
  | { status: "external_no_author" };

/** The actual mutation + audit, shared by the full (`setChallengeStatus`) and lean
 *  (`setChallengeStatusLean`, used by bulk actions) variants — a no-op when the status is
 *  unchanged. `mode` records whether this was an admin free-set (`override: true`) or a
 *  committee/assignee enforced transition (`override: false`) in the audit trail (§7.2). */
async function applyChallengeStatusChange(
  client: PoolClient,
  actor: Viewer,
  current: { id: string; status: string },
  newStatus: string,
  mode: TransitionMode,
): Promise<void> {
  if (current.status === newStatus) return;
  // §13.2: a move out of valid/solved clears any Home pin first (same transaction, audited).
  await unpinOnStatusChange(client, actor.userId, current.id, newStatus);
  // §7.2: entering `solved` sets resolved_at; any transition out of `solved` clears it.
  const resolvedAtClause =
    newStatus === "solved" ? `, resolved_at = coalesce(resolved_at, now())` : current.status === "solved" ? `, resolved_at = null` : "";
  await client.query(`update challenges set status = $2, updated_at = now(), status_changed_at = now()${resolvedAtClause} where id = $1`, [
    current.id,
    newStatus,
  ]);
  // §12.4: stamp first_valid_at on the first `valid`, enqueue channel-webhook milestones.
  await onChallengeStatusChanged(client, current.id, newStatus);
  // §24.7/§24.8: an external challenge's first close queues the outcome mail and the erasure date.
  await onExternalChallengeClosed(client, current.id, newStatus);
  await appendAudit(client, {
    actorUserId: actor.userId,
    action: "challenge.status_changed",
    targetType: "challenge",
    targetId: current.id,
    before: { status: current.status },
    after: { status: newStatus, override: mode === "override" },
  });
  // §23.2: entering valid/solved awards its milestones (first entry only — the award key), whether
  // the move was enforced or an admin override.
  await writeLiveAwards(client, await challengeStatusAwards(client, current.id, newStatus));
  // §12.1 event 15: a `people` challenge leaving triage (or withdrawal) tells everyone on its list
  // who has not been told yet. A no-op for any other visibility or a status that still hides it.
  if (newStatus !== "awaiting_triage" && newStatus !== "withdrawn") await deliverShareNotifications(client, current.id, actor.userId);
}

async function loadChallengeForStatusChange(
  pool: Pool,
  actor: Viewer,
  number: string,
  newStatus: string,
): Promise<
  | { status: "ok"; current: { id: string; namespace_id: string; status: string }; mode: TransitionMode }
  | { status: "not_found" | "trashed" | "forbidden" | "illegal_transition" | "invalid_status" | "external_no_author" }
> {
  if (!isChallengeStatus(newStatus)) return { status: "invalid_status" };
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string; assignee_id: string | null; public_submission_id: string | null }>(
    `select id, namespace_id, visibility, status, author_id, assignee_id, public_submission_id, trashed_at is not null as trashed
       from challenges where number = $1`,
    [number],
  );
  const current = rows[0];
  // §2.4: a challenge the actor cannot see is "not found", never "forbidden".
  if (!current || !isChallengeRowVisible(actor, current)) return { status: "not_found" };
  if (current.trashed) return { status: "trashed" }; // §10.4: read-only until restored
  // §24.6: an outside submission has no author who could improve it — refused for every role.
  // Checked after the role gate, so it tells nobody without review rights anything.
  const permitted = actor.roles.isNamespaceAdmin(current.namespace_id) || isEnforcer(actor, current.namespace_id, current.assignee_id);
  if (permitted && current.public_submission_id !== null && current.status !== newStatus && isStatusRefusedForExternal(newStatus)) {
    return { status: "external_no_author" };
  }
  const decision = decideTransition({
    from: current.status,
    to: newStatus,
    isAdmin: actor.roles.isNamespaceAdmin(current.namespace_id),
    isEnforcer: isEnforcer(actor, current.namespace_id, current.assignee_id),
    isLegalArrow: isChallengeEnforcedTransition(current.status as ChallengeStatus, newStatus),
  });
  if (!decision.allowed) return { status: decision.reason };
  return { status: "ok", current, mode: decision.mode };
}

export async function setChallengeStatus(
  pool: Pool,
  actor: Viewer,
  number: string,
  newStatus: string,
): Promise<SetChallengeStatusResult> {
  const loaded = await loadChallengeForStatusChange(pool, actor, number, newStatus);
  if (loaded.status !== "ok") return loaded;
  const { current, mode } = loaded;

  return inTransaction(pool, async (client) => {
    await applyChallengeStatusChange(client, actor, current, newStatus, mode);
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      current.id,
      actor.userId,
    ]);
    const row = full[0]!;
    const ctx = solutionParentContext(row);
    const solutionRows = await fetchSolutionRows(client, row.id, actor.userId);
    const solutions = solutionRows.filter((s) => isSolutionListed(actor, ctx, s)).map((s) => toSolutionItem(s, actor, ctx));
    return {
      status: "ok",
      challenge: toDetail(row, actor, solutions),
      changed: current.status !== newStatus,
      previousStatus: current.status,
    };
  });
}

export type SetChallengeStatusLeanResult =
  | { status: "ok"; changed: boolean; previousStatus: string }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "illegal_transition" }
  | { status: "invalid_status" }
  | { status: "external_no_author" };

/** Same auth/audit semantics as `setChallengeStatus`, without the full challenge+solutions
 *  re-fetch — for bulk admin actions (§14.1) that only need the outcome, not the detail
 *  payload, and would otherwise pay for N unused `CHALLENGE_SELECT` joins. */
export async function setChallengeStatusLean(pool: Pool, actor: Viewer, number: string, newStatus: string): Promise<SetChallengeStatusLeanResult> {
  const loaded = await loadChallengeForStatusChange(pool, actor, number, newStatus);
  if (loaded.status !== "ok") return loaded;
  const { current, mode } = loaded;

  return inTransaction(pool, async (client) => {
    await applyChallengeStatusChange(client, actor, current, newStatus, mode);
    return { status: "ok", changed: current.status !== newStatus, previousStatus: current.status };
  });
}

export type SetSolutionStatusResult =
  | {
      status: "ok";
      solution: SolutionListItem;
      changed: boolean;
      previousStatus: string;
      /** Present only when this transition triggered the §8.3 auto-close cascade. */
      autoClose?: { challengeId: string; challengeNumber: string; challengeTitle: string; notSelectedAuthorIds: string[]; solutionIds: string[] };
    }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "illegal_transition" }
  | { status: "invalid_status" }
  | { status: "blocked_single_winner" };

/** Thrown from inside the transaction when the DB's solutions_single_winner_idx (not
 *  just the application pre-check) catches a concurrent race on the §8.3 gate. */
class SingleWinnerRaceError extends Error {}

export async function setSolutionStatus(
  pool: Pool,
  actor: Viewer,
  number: string,
  newStatus: string,
): Promise<SetSolutionStatusResult> {
  if (!isSolutionStatus(newStatus)) return { status: "invalid_status" };
  if (!isEntityNumber(number)) return { status: "not_found" };

  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_id: string; challenge_number: string; challenge_title: string }>(
    `select s.id, s.challenge_id, ${SOLUTION_VISIBILITY_SELECT}, c.number::text as challenge_number, c.title as challenge_title
       from solutions s
       join challenges c on c.id = s.challenge_id
      where s.number = $1`,
    [number],
  );
  const current = rows[0];
  if (!current || !isSolutionRowVisible(actor, current)) return { status: "not_found" };
  if (isRowTrashed(current)) return { status: "trashed" }; // §10.4
  // Enforcer of a solution = committee of the parent's namespace, or the parent challenge's
  // assignee (§8.2). Admins free-set (override); anyone else is refused.
  const decision = decideTransition({
    from: current.status,
    to: newStatus,
    isAdmin: actor.roles.isNamespaceAdmin(current.namespace_id),
    isEnforcer: isEnforcer(actor, current.namespace_id, current.assignee_id),
    isLegalArrow: isSolutionEnforcedTransition(current.status as SolutionStatus, newStatus),
  });
  if (!decision.allowed) return { status: decision.reason };
  const mode = decision.mode;

  // §10.4: trashed siblings count too — a trashed solution past `valid` still holds the §8.3
  // single-winner slot, which is what makes its restore safe.
  const { rows: siblingRows } = await pool.query<{ id: string; status: string; author_id: string; trashed: boolean }>(
    `select id, status, author_id, trashed_at is not null as trashed from solutions where challenge_id = $1 and id <> $2`,
    [current.challenge_id, current.id],
  );

  if (newStatus === "accepted_internally") {
    const blocked = blocksAcceptedInternally(siblingRows.map((s) => s.status as SolutionStatus));
    if (blocked) return { status: "blocked_single_winner" };
  }

  try {
    return await inTransaction(pool, async (client) => {
      let autoClose: { challengeId: string; challengeNumber: string; challengeTitle: string; notSelectedAuthorIds: string[]; solutionIds: string[] } | undefined;

      if (current.status !== newStatus) {
        try {
          await client.query(`update solutions set status = $2, updated_at = now(), status_changed_at = now() where id = $1`, [current.id, newStatus]);
        } catch (err) {
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === "23505" && pgErr.constraint === "solutions_single_winner_idx") {
            throw new SingleWinnerRaceError();
          }
          throw err;
        }
        await appendAudit(client, {
          actorUserId: actor.userId,
          action: "solution.status_changed",
          targetType: "solution",
          targetId: current.id,
          before: { status: current.status },
          after: { status: newStatus, override: mode === "override" },
        });
        // §23.2: the solution's own milestone; the §8.3 auto-close adds the challenge's below, and
        // all of them are written together (one event 13 row per transaction).
        const awards = await solutionStatusAwards(client, current.id, newStatus);

        if (newStatus === "implemented") {
          // §8.3 auto-close cascade: the parent challenge becomes solved, and every other
          // non-terminal sibling becomes not_selected — triggered by the cascade, not a
          // direct admin action on those rows, so audited with a distinct trigger tag.
          await client.query(
            `update challenges set status = 'solved', resolved_at = coalesce(resolved_at, now()), updated_at = now(), status_changed_at = now() where id = $1`,
            [current.challenge_id],
          );
          await onExternalChallengeClosed(client, current.challenge_id, "solved"); // §24.7
          // Invariant 6: audited `from → to` like every transition. The cascade is part of the
          // actor's one action, so it carries that action's mode: an admin override that set
          // `implemented` makes the cascade rows overrides too; an enforced move does not.
          await appendAudit(client, {
            actorUserId: actor.userId,
            action: "challenge.status_changed",
            targetType: "challenge",
            targetId: current.challenge_id,
            before: { status: current.challenge_status },
            after: { status: "solved", override: mode === "override", trigger: "auto_close", solutionId: current.id },
          });

          const toClose = siblingsToAutoClose(
            [...siblingRows.map((s) => ({ id: s.id, status: s.status as SolutionStatus })), { id: current.id, status: "implemented" }],
            current.id,
          );
          for (const siblingId of toClose) {
            const before = siblingRows.find((s) => s.id === siblingId)!.status;
            await client.query(`update solutions set status = 'not_selected', updated_at = now(), status_changed_at = now() where id = $1`, [siblingId]);
            await appendAudit(client, {
              actorUserId: actor.userId,
              action: "solution.status_changed",
              targetType: "solution",
              targetId: siblingId,
              before: { status: before },
              after: { status: "not_selected", override: mode === "override", trigger: "auto_close", implementedSolutionId: current.id },
            });
          }
          // §10.4: a trashed sibling is closed like any other (its restore then matches §8.3), but
          // nobody is told about it — a trashed item sends no notification.
          const notifiable = toClose.filter((id) => !siblingRows.find((s) => s.id === id)!.trashed);
          autoClose = {
            challengeId: current.challenge_id,
            challengeNumber: current.challenge_number,
            challengeTitle: current.challenge_title,
            notSelectedAuthorIds: notifiable.map((id) => siblingRows.find((s) => s.id === id)!.author_id),
            // §12.1 event 8: "followers of the challenge AND its solutions" — the implemented
            // solution plus every sibling just closed as not_selected.
            solutionIds: [current.id, ...notifiable],
          };
          // §12.4: solution.implemented, then challenge.solved (when the parent really transitioned).
          await onSolutionImplemented(client, current.id, current.challenge_id, current.challenge_status === "solved");
          awards.push(...(await challengeStatusAwards(client, current.challenge_id, "solved")));
        }
        await writeLiveAwards(client, awards);
      }
      const solutionRows = await fetchSolutionRows(client, current.challenge_id, actor.userId);
      const row = solutionRows.find((s) => s.id === current.id)!;
      return {
        status: "ok",
        solution: toSolutionItem(row, actor, { namespaceId: current.namespace_id, assigneeId: current.assignee_id, trashed: false }),
        changed: current.status !== newStatus,
        previousStatus: current.status,
        autoClose,
      };
    });
  } catch (err) {
    if (err instanceof SingleWinnerRaceError) return { status: "blocked_single_winner" };
    throw err;
  }
}

// ── Likes (minimal slice pulled forward from Phase 3) ───────────────────────────────────

export type ToggleLikeResult = { status: "ok"; liked: boolean; count: number } | { status: "not_found" } | { status: "trashed" } | { status: "frozen" };

/** §8.3: a solved challenge freezes likes on itself and its solutions — neither a like nor an
 *  unlike lands. Reads the parent challenge's status under FOR SHARE so a concurrent auto-close
 *  (which updates the challenge row) cannot slip in between this check and the caller's write.
 *  Shared by the POST toggle and the DELETE unlike; call inside the write transaction. */
export async function lockLikeParent(
  client: PoolClient,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<"open" | "frozen" | "not_found"> {
  const { rows } = await client.query<{ status: string }>(
    parentType === "challenge"
      ? `select c.status from challenges c where c.id = $1 for share`
      : `select c.status from solutions s join challenges c on c.id = s.challenge_id where s.id = $1 for share of c`,
    [parentId],
  );
  if (!rows[0]) return "not_found";
  return areLikesFrozen(rows[0].status as ChallengeStatus) ? "frozen" : "open";
}

export async function toggleLike(
  pool: Pool,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<ToggleLikeResult> {
  const access = await getParentAccess(pool, viewer, parentType, parentId);
  if (access !== "live") return { status: access };

  return inTransaction(pool, async (client) => {
    const gate = await lockLikeParent(client, parentType, parentId);
    if (gate !== "open") return { status: gate };

    const { rows: existing } = await client.query(
      `select 1 from likes where user_id = $1 and parent_type = $2 and parent_id = $3`,
      [viewer.userId, parentType, parentId],
    );
    let liked: boolean;
    if (existing.length > 0) {
      await client.query(`delete from likes where user_id = $1 and parent_type = $2 and parent_id = $3`, [
        viewer.userId,
        parentType,
        parentId,
      ]);
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "like.removed",
        targetType: parentType,
        targetId: parentId,
      });
      liked = false;
    } else {
      await client.query(`insert into likes (user_id, parent_type, parent_id) values ($1, $2, $3)`, [
        viewer.userId,
        parentType,
        parentId,
      ]);
      await appendAudit(client, {
        actorUserId: viewer.userId,
        action: "like.added",
        targetType: parentType,
        targetId: parentId,
      });
      await awardLikeReceived(client, parentType, parentId, viewer.userId); // §23.2
      liked = true;
    }
    const { rows: countRows } = await client.query<{ count: string }>(
      `select count(*)::text as count from likes where parent_type = $1 and parent_id = $2`,
      [parentType, parentId],
    );
    return { status: "ok", liked, count: Number(countRows[0]!.count) };
  });
}

/** What a viewer may do with a challenge/solution parent: `live` (visible, writable per the
 *  caller's own rules), `trashed` (in the trash, or under a trashed challenge — reached only by a
 *  platform admin, who may read it but not write to it, §10.4) or `not_found` (missing or
 *  invisible — the two are never told apart, invariant 2). */
export type ParentAccess = "live" | "trashed" | "not_found";

/** Exported for reuse by the comments/follows/likes/attachments stores and the notification
 *  fan-out — any parent-scoped feature needs the same §4.3 gate. Writes require `live`. */
export async function getParentAccess(
  db: Pool | PoolClient,
  viewer: Viewer,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<ParentAccess> {
  if (!isUuid(parentId)) return "not_found";
  if (parentType === "challenge") {
    const { rows } = await db.query<ChallengeVisibilityColumns>(
      `select id, namespace_id, visibility, status, author_id, assignee_id, trashed_at is not null as trashed from challenges where id = $1`,
      [parentId],
    );
    const row = rows[0];
    if (!row || !isChallengeRowVisible(viewer, row)) return "not_found";
    return isRowTrashed(row) ? "trashed" : "live";
  }
  const { rows } = await db.query<SolutionVisibilityColumns>(
    `select ${SOLUTION_VISIBILITY_SELECT}
       from solutions s
       join challenges c on c.id = s.challenge_id
      where s.id = $1`,
    [parentId],
  );
  const row = rows[0];
  if (!row || !isSolutionRowVisible(viewer, row)) return "not_found";
  return isRowTrashed(row) ? "trashed" : "live";
}

/** The read gate: true when the viewer may SEE the parent — a platform admin sees a trashed one
 *  (the read-only trashed view and its attachments, §10.4). Writes use getParentAccess. */
export async function isParentVisible(pool: Pool, viewer: Viewer, parentType: "challenge" | "solution", parentId: string): Promise<boolean> {
  return (await getParentAccess(pool, viewer, parentType, parentId)) !== "not_found";
}

/** The namespace a challenge or solution belongs to (via its parent challenge for
 *  solutions) — used by comments/follows moderation checks (isNamespaceAdmin). Null when
 *  the parent doesn't exist. */
export async function getParentNamespaceId(
  pool: Pool | PoolClient,
  parentType: "challenge" | "solution",
  parentId: string,
): Promise<string | null> {
  if (parentType === "challenge") {
    const { rows } = await pool.query<{ namespace_id: string }>(`select namespace_id from challenges where id = $1`, [
      parentId,
    ]);
    return rows[0]?.namespace_id ?? null;
  }
  const { rows } = await pool.query<{ namespace_id: string }>(
    `select c.namespace_id from solutions s join challenges c on c.id = s.challenge_id where s.id = $1`,
    [parentId],
  );
  return rows[0]?.namespace_id ?? null;
}

/** The id of the challenge or solution with this number, when the viewer can see it (§4.3 and, on
 *  an agent's viewer, §25.5) — else null, whether missing or hidden (no existence oracle). */
export async function resolveVisibleParent(pool: Pool, viewer: Viewer, parentType: "challenge" | "solution", number: string): Promise<string | null> {
  if (!isEntityNumber(number)) return null;
  const { rows } = await pool.query<{ id: string }>(
    parentType === "challenge" ? `select id from challenges where number = $1` : `select id from solutions where number = $1`,
    [number],
  );
  const id = rows[0]?.id;
  if (!id || !(await isParentVisible(pool, viewer, parentType, id))) return null;
  return id;
}

export interface OwnSolutionItem {
  number: string;
  status: SolutionStatus;
  challengeNumber: string;
  challengeTitle: string;
  createdAt: string;
  canEdit: boolean;
  canResubmit: boolean;
}

/** §25.6 list_my_items: the viewer's own solutions, newest first, whose parent challenge they can
 *  still see (the same §4.3 predicate; §25.5 on an agent's viewer). */
export async function listOwnSolutions(pool: Pool, viewer: Viewer, limit = 100): Promise<OwnSolutionItem[]> {
  const params: unknown[] = [viewer.userId];
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions = [`s.author_id = $1`];
  pushChallengeVisibilityConditions(viewer, push, conditions);
  const { rows } = await pool.query<{ number: string; status: string; challenge_number: string; challenge_title: string; created_at: Date }>(
    `select s.number::text, s.status, c.number::text as challenge_number, c.title as challenge_title, s.created_at
       from solutions s join challenges c on c.id = s.challenge_id
      where ${conditions.join(" and ")}
      order by s.created_at desc limit ${limit}`,
    params,
  );
  return rows.map((r) => {
    const status = r.status as SolutionStatus;
    return {
      number: formatSolutionNumber(r.number),
      status,
      challengeNumber: formatChallengeNumber(r.challenge_number),
      challengeTitle: r.challenge_title,
      createdAt: r.created_at.toISOString(),
      canEdit: canAuthorEditSolution(status),
      canResubmit: canAuthorResubmit(status),
    };
  });
}

// ── Assignment (§7.3) ────────────────────────────────────────────────────────────────────

export type AssignResult =
  | { status: "ok"; challenge: ChallengeDetail; assigned: boolean; previousAssigneeId: string | null }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "unknown_user" }
  | { status: "assignee_cannot_see" }
  | { status: "terminal_status" };

/** Resolves an arbitrary user's RoleSet from SCIM-synced membership (invariant 1) — injected (the
 *  routes pass `resolveRolesForUser`) so this module does not pull in the session layer. */
export type ResolveAssigneeRoles = (userId: string) => Promise<RoleSet>;

/** §7.3: the challenge whose assignee picker is searching, as the §4.3 visibility input the
 *  candidate filter needs — or null when it does not exist, the CALLER cannot see it (§2.4), or the
 *  caller is not an admin of its namespace. The filtered result reveals who holds membership and
 *  admin roles there, so only those who may assign (the assign endpoint's own gate) get it. */
export async function getAssignmentAudience(pool: Pool, viewer: Viewer, number: string): Promise<ChallengeVisibilityInput | null> {
  if (!isEntityNumber(number)) return null;
  const { rows } = await pool.query<ChallengeVisibilityColumns>(
    `select id, namespace_id, visibility, status, author_id, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const row = rows[0];
  // §10.4: a trashed challenge takes no assignee, so its picker offers nobody.
  if (!row || row.trashed || !isChallengeRowVisible(viewer, row) || !viewer.roles.isNamespaceAdmin(row.namespace_id)) return null;
  return {
    id: row.id,
    namespaceId: row.namespace_id,
    visibility: row.visibility,
    status: row.status as ChallengeStatus,
    authorId: row.author_id,
    assigneeId: row.assignee_id,
    trashed: false,
  };
}

/** Exported for the GDPR erasure hand-over (§3), whose every move is an ordinary §7.3 change. */
export async function applyChallengeAssigneeChange(
  client: PoolClient,
  admin: Pick<Viewer, "userId">,
  current: { id: string; assignee_id: string | null },
  assigneeUserId: string | null,
): Promise<void> {
  await client.query(`update challenges set assignee_id = $2, updated_at = now() where id = $1`, [current.id, assigneeUserId]);
  await appendAudit(client, {
    actorUserId: admin.userId,
    action: assigneeUserId ? "challenge.assigned" : "challenge.unassigned",
    targetType: "challenge",
    targetId: current.id,
    before: { assigneeId: current.assignee_id },
    after: { assigneeId: assigneeUserId },
  });
  if (assigneeUserId) {
    // §12.3: an assignee is auto-followed to their challenge (they may unfollow later).
    await client.query(`insert into follows (user_id, parent_type, parent_id) values ($1, 'challenge', $2) on conflict do nothing`, [assigneeUserId, current.id]);
  }
}

async function loadChallengeForAssignment(
  pool: Pool,
  admin: Viewer,
  number: string,
  assigneeUserId: string | null,
  resolveRoles: ResolveAssigneeRoles,
): Promise<
  | { status: "ok"; current: { id: string; namespace_id: string; status: string; assignee_id: string | null }; addToAccessList: boolean }
  | { status: "not_found" | "trashed" | "forbidden" | "terminal_status" | "unknown_user" | "assignee_cannot_see" }
> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string; assignee_id: string | null }>(
    `select id, namespace_id, visibility, status, author_id, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const current = rows[0];
  if (!current || !isChallengeRowVisible(admin, current)) return { status: "not_found" };
  if (current.trashed) return { status: "trashed" }; // §10.4
  if (!admin.roles.isNamespaceAdmin(current.namespace_id)) return { status: "forbidden" };
  if (!canAssignAtStatus(current.status as ChallengeStatus)) return { status: "terminal_status" };

  if (assigneeUserId !== null) {
    const { rows: userRows } = await pool.query<{ id: string }>(`select id from users where id = $1 and active = true`, [
      assigneeUserId,
    ]);
    if (!userRows[0]) return { status: "unknown_user" };
    // §7.3: the assignee must be able to see the challenge — checked at assignment time only,
    // with their roles resolved from SCIM-synced membership exactly as the §3 hand-over does.
    if (!isChallengeRowVisible({ userId: assigneeUserId, roles: await resolveRoles(assigneeUserId) }, current)) {
      // A `people` challenge past triage relaxes the gate instead: the assignment puts them on
      // its access list. In triage the ordinary gate holds (only its namespace's admins).
      if (isPeopleAutoAddable(current)) return { status: "ok", current, addToAccessList: true };
      return { status: "assignee_cannot_see" };
    }
  }
  return { status: "ok", current, addToAccessList: false };
}

/** §7.3: whether assigning someone who cannot yet see this challenge adds them to its list. */
function isPeopleAutoAddable(row: { visibility: ChallengeVisibility; status: string }): boolean {
  return row.visibility === "people" && row.status !== "awaiting_triage" && row.status !== "withdrawn";
}

/** `assigneeUserId: null` unassigns. Assignment is possible from awaiting_triage onward and
 *  blocked on terminal statuses (§7.3). Granted by a namespace/platform admin. */
export async function setChallengeAssignee(
  pool: Pool,
  admin: Viewer,
  number: string,
  assigneeUserId: string | null,
  resolveRoles: ResolveAssigneeRoles,
): Promise<AssignResult> {
  const loaded = await loadChallengeForAssignment(pool, admin, number, assigneeUserId, resolveRoles);
  if (loaded.status !== "ok") return loaded;
  const { current } = loaded;

  return inTransaction(pool, async (client) => {
    if (loaded.addToAccessList && assigneeUserId) await addAccessForAssignment(client, { challengeId: current.id, userId: assigneeUserId, actorId: admin.userId });
    await applyChallengeAssigneeChange(client, admin, current, assigneeUserId);
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      current.id,
      admin.userId,
    ]);
    const row = full[0]!;
    const ctx = solutionParentContext(row);
    const solutionRows = await fetchSolutionRows(client, row.id, admin.userId);
    const solutions = solutionRows.filter((s) => isSolutionListed(admin, ctx, s)).map((s) => toSolutionItem(s, admin, ctx));
    return { status: "ok", challenge: toDetail(row, admin, solutions), assigned: assigneeUserId !== null, previousAssigneeId: current.assignee_id };
  });
}

export type AssignLeanResult =
  | { status: "ok"; assigned: boolean }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "unknown_user" }
  | { status: "assignee_cannot_see" }
  | { status: "terminal_status" };

/** Same auth/audit semantics as `setChallengeAssignee`, without the full challenge+solutions
 *  re-fetch — for bulk admin actions (§14.1). */
export async function setChallengeAssigneeLean(
  pool: Pool,
  admin: Viewer,
  number: string,
  assigneeUserId: string | null,
  resolveRoles: ResolveAssigneeRoles,
): Promise<AssignLeanResult> {
  const loaded = await loadChallengeForAssignment(pool, admin, number, assigneeUserId, resolveRoles);
  if (loaded.status !== "ok") return loaded;
  const { current } = loaded;

  return inTransaction(pool, async (client) => {
    if (loaded.addToAccessList && assigneeUserId) await addAccessForAssignment(client, { challengeId: current.id, userId: assigneeUserId, actorId: admin.userId });
    await applyChallengeAssigneeChange(client, admin, current, assigneeUserId);
    return { status: "ok", assigned: assigneeUserId !== null };
  });
}

// ── Visibility change (§4.3, §14.2 moderation) ────────────────────────────────────────────

export type SetVisibilityResult =
  | { status: "ok"; challenge: ChallengeDetail }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "invalid" }
  /** §4.3 `people`: the access list is missing, empty, too long or malformed (→ 422). */
  | { status: "invalid_access"; error: string };

/** §4.3: a challenge's visibility (org | namespace | people) is changeable after submission only by
 *  a namespace/platform admin, and every change is audited (§15 "visibility changes"). `people`
 *  takes the whole access list (`access`), which the same call also uses to edit the list of a
 *  challenge that stays `people`. Switching away from `people` clears the list, and the
 *  `visibility_changed` row records what was removed — user ids and a count of pending e-mails,
 *  never an address. */
export async function setChallengeVisibility(
  pool: Pool,
  admin: Viewer,
  number: string,
  visibility: string,
  accessRaw?: unknown,
): Promise<SetVisibilityResult> {
  if (!isChallengeVisibility(visibility)) return { status: "invalid" };
  const access = visibility === "people" ? parseAccessListInput(accessRaw) : null;
  if (access && !access.ok) return { status: "invalid_access", error: access.error };
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string }>(
    `select id, namespace_id, visibility, status, author_id, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(admin, cur)) return { status: "not_found" };
  if (cur.trashed) return { status: "trashed" }; // §10.4
  if (!admin.roles.isNamespaceAdmin(cur.namespace_id)) return { status: "forbidden" };
  if (cur.visibility === visibility && visibility !== "people") return { status: "ok", challenge: await reloadChallengeDetail(pool, admin, cur.id) };

  return inTransaction(pool, async (client): Promise<SetVisibilityResult> => {
    if (access?.ok) {
      const replaced = await replaceAccessList(client, { challengeId: cur.id, input: access.value, actorId: admin.userId, via: "editor" });
      if (replaced.status === "unknown_user") return { status: "invalid_access", error: "One of the people chosen is no longer an active user." };
    }
    if (cur.visibility !== visibility) {
      const removed = visibility === "people" ? null : await clearAccessList(client, cur.id);
      await client.query(`update challenges set visibility = $2, updated_at = now() where id = $1`, [cur.id, visibility]);
      await appendAudit(client, {
        actorUserId: admin.userId,
        action: "challenge.visibility_changed",
        targetType: "challenge",
        targetId: cur.id,
        before: { visibility: cur.visibility },
        after: removed && cur.visibility === "people" ? { visibility, removedAccess: removed } : { visibility },
      });
    }
    // §12.1 event 15 for whoever is newly on the list, if the challenge is past triage.
    if (visibility === "people") await deliverShareNotifications(client, cur.id, admin.userId);
    return { status: "ok", challenge: await reloadChallengeDetail(client, admin, cur.id) };
  });
}

// ── Author edit / withdraw / resubmit (§10.1) ─────────────────────────────────────────────

/** Re-load the full detail payload for a viewer (the CHALLENGE_SELECT + visible-solutions
 *  build several write paths need after they mutate). */
async function reloadChallengeDetail(db: Pool | PoolClient, viewer: Viewer, challengeId: string): Promise<ChallengeDetail> {
  const { rows } = await db.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [challengeId, viewer.userId]);
  const row = rows[0]!;
  return buildDetailWithAttachments(db, viewer, row);
}

/** Build the {before, after} field-level diff (§10.1) — only the columns that actually changed. */
function diffFields(pairs: { key: string; before: unknown; after: unknown }[]): { before: Record<string, unknown>; after: Record<string, unknown>; changed: boolean } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const p of pairs) {
    if (p.before !== p.after) {
      before[p.key] = p.before;
      after[p.key] = p.after;
    }
  }
  return { before, after, changed: Object.keys(after).length > 0 };
}

export type EditChallengeResult =
  | { status: "ok"; challenge: ChallengeDetail }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "unknown_impact_area" }
  | { status: "inactive_impact_area" }
  | { status: "invalid"; error: string };

/** Author content edit of a challenge (§10.1): allowed only by the author within the edit
 *  window (awaiting_triage / needs_improvement). Visibility, anonymity, and namespace are NOT
 *  editable here (§4.3/§9). Stamps `edited_at` and audits a field-level diff. */
export async function editChallenge(
  pool: Pool,
  author: Viewer,
  number: string,
  input: { title: unknown; description: unknown; clientName: unknown; impactAreaId: string },
  via?: AgentSource,
): Promise<EditChallengeResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<{
    id: string;
    namespace_id: string;
    status: string;
    author_id: string | null;
    impact_area_id: string;
    title: string;
    description: string;
    client_name: string | null;
    visibility: ChallengeVisibility;
    assignee_id: string | null;
    is_anonymous: boolean;
    trashed: boolean;
  }>(
    `select id, namespace_id, status, author_id, assignee_id, impact_area_id, title, description, client_name, visibility, is_anonymous,
            trashed_at is not null as trashed
       from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(author, cur)) return { status: "not_found" };
  if (cur.trashed) return { status: "trashed" }; // §10.4
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorEditChallenge(cur.status as ChallengeStatus)) return { status: "not_editable" };

  const { rows: areaRows } = await pool.query<{ id: string; name: string; active: boolean }>(`select id, name, active from impact_areas where id = $1`, [input.impactAreaId]);
  const area = areaRows[0];
  if (!area) return { status: "unknown_impact_area" };
  if (!area.active) return { status: "inactive_impact_area" };

  const validated = validateChallengeFields({
    title: input.title,
    description: input.description,
    clientName: input.clientName,
    visibility: cur.visibility, // unchanged — §4.3 keeps visibility a namespace/platform-admin edit
    isAnonymous: cur.is_anonymous, // unchanged — anonymity is removed only via self-reveal (§9)
    impactAreaIsClient: area.name === "Client",
  });
  if (!validated.ok) return { status: "invalid", error: validated.error };

  const diff = diffFields([
    { key: "title", before: cur.title, after: validated.value.title },
    { key: "description", before: cur.description, after: validated.value.description },
    { key: "clientName", before: cur.client_name, after: validated.value.clientName },
    { key: "impactAreaId", before: cur.impact_area_id, after: input.impactAreaId },
  ]);

  return inTransaction(pool, async (client) => {
    if (diff.changed) {
      await client.query(
        `update challenges set title = $2, description = $3, client_name = $4, impact_area_id = $5, edited_at = now(), updated_at = now() where id = $1`,
        [cur.id, validated.value.title, validated.value.description, validated.value.clientName, input.impactAreaId],
      );
      await appendAudit(client, {
        actorUserId: author.userId,
        action: "challenge.edited",
        targetType: "challenge",
        targetId: cur.id,
        before: diff.before,
        after: { ...diff.after, ...agentAuditFields(via) },
      });
    }
    return { status: "ok", challenge: await reloadChallengeDetail(client, author, cur.id) };
  });
}

export type EditSolutionResult =
  | { status: "ok"; solution: SolutionListItem }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_editable" }
  | { status: "invalid"; error: string };

export async function editSolution(
  pool: Pool,
  author: Viewer,
  number: string,
  input: { description: unknown; costVsBenefits: unknown },
  via?: AgentSource,
): Promise<EditSolutionResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_id: string; description: string; cost_vs_benefits: string | null }>(
    `select s.id, s.challenge_id, ${SOLUTION_VISIBILITY_SELECT}, s.description, s.cost_vs_benefits
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isSolutionRowVisible(author, cur)) return { status: "not_found" };
  if (isRowTrashed(cur)) return { status: "trashed" }; // §10.4
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorEditSolution(cur.status as SolutionStatus)) return { status: "not_editable" };

  // isAnonymous is not editable here; pass the field through validation with a fixed value it
  // won't apply (self-reveal owns anonymity, §9).
  const validated = validateSolutionFields({ description: input.description, costVsBenefits: input.costVsBenefits, isAnonymous: false });
  if (!validated.ok) return { status: "invalid", error: validated.error };

  const diff = diffFields([
    { key: "description", before: cur.description, after: validated.value.description },
    { key: "costVsBenefits", before: cur.cost_vs_benefits, after: validated.value.costVsBenefits },
  ]);

  return inTransaction(pool, async (client) => {
    if (diff.changed) {
      await client.query(`update solutions set description = $2, cost_vs_benefits = $3, edited_at = now(), updated_at = now() where id = $1`, [
        cur.id,
        validated.value.description,
        validated.value.costVsBenefits,
      ]);
      await appendAudit(client, {
        actorUserId: author.userId,
        action: "solution.edited",
        targetType: "solution",
        targetId: cur.id,
        before: diff.before,
        after: { ...diff.after, ...agentAuditFields(via) },
      });
    }
    const solutionRows = await fetchSolutionRows(client, cur.challenge_id, author.userId);
    const row = solutionRows.find((s) => s.id === cur.id)!;
    return { status: "ok", solution: toSolutionItem(row, author, { namespaceId: cur.namespace_id, assigneeId: cur.assignee_id, trashed: false }) };
  });
}

export type WithdrawChallengeResult =
  | { status: "ok"; challengeId: string; namespaceId: string; title: string; previousStatus: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_withdrawable" };

/** Author withdraws their own challenge from any non-terminal status → withdrawn (§10.1). */
export async function withdrawChallenge(pool: Pool, author: Viewer, number: string): Promise<WithdrawChallengeResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string; title: string; assignee_id: string | null }>(
    `select id, status, author_id, namespace_id, visibility, title, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(author, cur)) return { status: "not_found" };
  if (cur.trashed) return { status: "trashed" }; // §10.4
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorWithdrawChallenge(cur.status as ChallengeStatus)) return { status: "not_withdrawable" };

  return inTransaction(pool, async (client) => {
    await unpinOnStatusChange(client, author.userId, cur.id, "withdrawn"); // §13.2 auto-unpin
    await client.query(`update challenges set status = 'withdrawn', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    // §22.7/§22.11: a withdrawn item keeps no AI output — its own, or its solutions'.
    await client.query(
      `delete from ai_results
        where (parent_type = 'challenge' and parent_id = $1)
           or (parent_type = 'solution' and parent_id in (select id from solutions where challenge_id = $1))`,
      [cur.id],
    );
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "challenge.status_changed",
      targetType: "challenge",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "withdrawn", trigger: "author_withdrawn" },
    });
    return { status: "ok", challengeId: cur.id, namespaceId: cur.namespace_id, title: cur.title, previousStatus: cur.status, assigneeId: cur.assignee_id };
  });
}

export type WithdrawSolutionResult =
  | { status: "ok"; solutionId: string; challengeId: string; namespaceId: string; challengeNumber: string; challengeTitle: string; previousStatus: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_withdrawable" };

export async function withdrawSolution(pool: Pool, author: Viewer, number: string): Promise<WithdrawSolutionResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_id: string; challenge_number: string; challenge_title: string }>(
    `select s.id, s.challenge_id, ${SOLUTION_VISIBILITY_SELECT}, c.number::text as challenge_number, c.title as challenge_title
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isSolutionRowVisible(author, cur)) return { status: "not_found" };
  if (isRowTrashed(cur)) return { status: "trashed" }; // §10.4
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorWithdrawSolution(cur.status as SolutionStatus)) return { status: "not_withdrawable" };

  return inTransaction(pool, async (client) => {
    await client.query(`update solutions set status = 'withdrawn', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    await client.query(`delete from ai_results where parent_type = 'solution' and parent_id = $1`, [cur.id]); // §22.7
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "solution.status_changed",
      targetType: "solution",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "withdrawn", trigger: "author_withdrawn" },
    });
    return { status: "ok", solutionId: cur.id, challengeId: cur.challenge_id, namespaceId: cur.namespace_id, challengeNumber: cur.challenge_number, challengeTitle: cur.challenge_title, previousStatus: cur.status, assigneeId: cur.assignee_id };
  });
}

export type ResubmitChallengeResult =
  | { status: "ok"; challengeId: string; namespaceId: string; title: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_resubmittable" };

/** Author resubmits their own needs_improvement challenge → in_review (§10.1); notifies
 *  reviewers (route). Audited as an enforced status change (`override:false`). */
export async function resubmitChallenge(pool: Pool, author: Viewer, number: string, via?: AgentSource): Promise<ResubmitChallengeResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string; title: string; assignee_id: string | null }>(
    `select id, status, author_id, namespace_id, visibility, title, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isChallengeRowVisible(author, cur)) return { status: "not_found" };
  if (cur.trashed) return { status: "trashed" }; // §10.4
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorResubmit(cur.status as ChallengeStatus)) return { status: "not_resubmittable" };

  return inTransaction(pool, async (client) => {
    await client.query(`update challenges set status = 'in_review', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "challenge.status_changed",
      targetType: "challenge",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "in_review", override: false, trigger: "author_resubmit", ...agentAuditFields(via) },
    });
    return { status: "ok", challengeId: cur.id, namespaceId: cur.namespace_id, title: cur.title, assigneeId: cur.assignee_id };
  });
}

export type ResubmitSolutionResult =
  | { status: "ok"; solutionId: string; namespaceId: string; challengeNumber: string; challengeTitle: string; assigneeId: string | null }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_resubmittable" };

export async function resubmitSolution(pool: Pool, author: Viewer, number: string, via?: AgentSource): Promise<ResubmitSolutionResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; challenge_number: string; challenge_title: string }>(
    `select s.id, ${SOLUTION_VISIBILITY_SELECT}, c.number::text as challenge_number, c.title as challenge_title
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const cur = rows[0];
  if (!cur || !isSolutionRowVisible(author, cur)) return { status: "not_found" };
  if (isRowTrashed(cur)) return { status: "trashed" }; // §10.4
  if (cur.author_id !== author.userId) return { status: "forbidden" };
  if (!canAuthorResubmit(cur.status as SolutionStatus)) return { status: "not_resubmittable" };

  return inTransaction(pool, async (client) => {
    await client.query(`update solutions set status = 'in_review', updated_at = now(), status_changed_at = now() where id = $1`, [cur.id]);
    await appendAudit(client, {
      actorUserId: author.userId,
      action: "solution.status_changed",
      targetType: "solution",
      targetId: cur.id,
      before: { status: cur.status },
      after: { status: "in_review", override: false, trigger: "author_resubmit", ...agentAuditFields(via) },
    });
    return { status: "ok", solutionId: cur.id, namespaceId: cur.namespace_id, challengeNumber: cur.challenge_number, challengeTitle: cur.challenge_title, assigneeId: cur.assignee_id };
  });
}

// ── Anonymity reveal (§9) ────────────────────────────────────────────────────────────────

export type RevealResult =
  | {
      status: "ok";
      realDisplayName: string;
      realEmail: string | null;
      realUserId: string;
      /** §13.6: the revealed author's account state, so the dialog's bubble is greyed or neutral. */
      realActive: boolean;
      realScrubbed: boolean;
    }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_anonymous" };

interface RevealUserRow {
  display_name: string;
  email: string | null;
  active: boolean;
  scrubbed: boolean;
}

const REVEAL_USER_SELECT = `select display_name, email, active, scrubbed_at is not null as scrubbed from users where id = $1`;

function toRevealResult(user: RevealUserRow | undefined, authorId: string): RevealResult {
  return {
    status: "ok",
    realDisplayName: user?.display_name ?? "",
    realEmail: user?.email ?? null,
    realUserId: authorId,
    realActive: user?.active ?? true,
    realScrubbed: user?.scrubbed ?? false,
  };
}

/** Admin reveal: transient (never persisted, is_anonymous stays true) — every execution is
 *  audited (§9). Namespace admins (own namespace) and platform admins only; committee and
 *  assignees cannot reveal. */
export async function revealChallengeAuthor(pool: Pool, admin: Viewer, number: string): Promise<RevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string; is_anonymous: boolean }>(
    `select id, namespace_id, visibility, status, is_anonymous, author_id, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const row = rows[0];
  // §2.4: visibility first — a non-admin probing a hidden challenge gets 404, never 403.
  if (!row || !isChallengeRowVisible(admin, row)) return { status: "not_found" };
  if (row.trashed) return { status: "trashed" }; // §10.4: the trash is not a reveal path
  if (!admin.roles.isNamespaceAdmin(row.namespace_id)) return { status: "forbidden" };
  // An external challenge (§24.6) is never anonymous, so it has no author to reveal.
  if (!row.is_anonymous || row.author_id === null) return { status: "not_anonymous" };

  const { rows: userRows } = await pool.query<RevealUserRow>(REVEAL_USER_SELECT, [row.author_id]);
  await appendAudit(pool, {
    actorUserId: admin.userId,
    action: "anonymity.revealed",
    targetType: "challenge",
    targetId: row.id,
    after: { revealedAuthorId: row.author_id },
  });
  return toRevealResult(userRows[0], row.author_id);
}

export async function revealSolutionAuthor(pool: Pool, admin: Viewer, number: string): Promise<RevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; is_anonymous: boolean }>(
    `select s.id, ${SOLUTION_VISIBILITY_SELECT}, s.is_anonymous
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const row = rows[0];
  if (!row || !isSolutionRowVisible(admin, row)) return { status: "not_found" };
  if (isRowTrashed(row)) return { status: "trashed" }; // §10.4
  if (!admin.roles.isNamespaceAdmin(row.namespace_id)) return { status: "forbidden" };
  if (!row.is_anonymous) return { status: "not_anonymous" };

  const { rows: userRows } = await pool.query<RevealUserRow>(REVEAL_USER_SELECT, [row.author_id]);
  await appendAudit(pool, {
    actorUserId: admin.userId,
    action: "anonymity.revealed",
    targetType: "solution",
    targetId: row.id,
    after: { revealedAuthorId: row.author_id },
  });
  return toRevealResult(userRows[0], row.author_id);
}

export type SelfRevealResult =
  | { status: "ok"; challenge?: ChallengeDetail }
  | { status: "not_found" }
  | { status: "trashed" }
  | { status: "forbidden" }
  | { status: "not_anonymous" };

/** Self-reveal: the author permanently removes their own anonymity (one-way, §9). */
export async function selfRevealChallenge(pool: Pool, viewer: Viewer, number: string): Promise<SelfRevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<ChallengeVisibilityColumns & { id: string; is_anonymous: boolean }>(
    `select id, namespace_id, visibility, status, is_anonymous, author_id, assignee_id, trashed_at is not null as trashed from challenges where number = $1`,
    [number],
  );
  const row = rows[0];
  if (!row || !isChallengeRowVisible(viewer, row)) return { status: "not_found" };
  if (row.trashed) return { status: "trashed" }; // §10.4
  if (row.author_id !== viewer.userId) return { status: "forbidden" };
  if (!row.is_anonymous) return { status: "not_anonymous" };

  return inTransaction(pool, async (client) => {
    await client.query(`update challenges set is_anonymous = false, updated_at = now() where id = $1`, [row.id]);
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "anonymity.self_revealed",
      targetType: "challenge",
      targetId: row.id,
    });
    // §23.2: the item's awards are replayed now, backdated to their original event times.
    await replayOnSelfReveal(client, "challenge", row.id);
    const { rows: full } = await client.query<ChallengeRow>(`${CHALLENGE_SELECT.replaceAll("$viewer", "$2")} where c.id = $1`, [
      row.id,
      viewer.userId,
    ]);
    const ctx = solutionParentContext(full[0]!);
    const solutionRows = await fetchSolutionRows(client, row.id, viewer.userId);
    const solutions = solutionRows.filter((s) => isSolutionListed(viewer, ctx, s)).map((s) => toSolutionItem(s, viewer, ctx));
    return { status: "ok", challenge: toDetail(full[0]!, viewer, solutions) };
  });
}

export async function selfRevealSolution(pool: Pool, viewer: Viewer, number: string): Promise<SelfRevealResult> {
  if (!isEntityNumber(number)) return { status: "not_found" };
  const { rows } = await pool.query<SolutionVisibilityColumns & { id: string; is_anonymous: boolean }>(
    `select s.id, ${SOLUTION_VISIBILITY_SELECT}, s.is_anonymous
       from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const row = rows[0];
  if (!row || !isSolutionRowVisible(viewer, row)) return { status: "not_found" };
  if (isRowTrashed(row)) return { status: "trashed" }; // §10.4
  if (row.author_id !== viewer.userId) return { status: "forbidden" };
  if (!row.is_anonymous) return { status: "not_anonymous" };

  // §9: the self-reveal and its audit row commit in one transaction.
  return inTransaction(pool, async (client) => {
    await client.query(`update solutions set is_anonymous = false, updated_at = now() where id = $1`, [row.id]);
    await appendAudit(client, {
      actorUserId: viewer.userId,
      action: "anonymity.self_revealed",
      targetType: "solution",
      targetId: row.id,
    });
    await replayOnSelfReveal(client, "solution", row.id); // §23.2
    return { status: "ok" as const };
  });
}
