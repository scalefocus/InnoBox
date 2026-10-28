"use client";
// Challenge detail page (INNOBOX_SPEC.md §13.1 + Phase 3): full fields, inline solutions
// list, propose-a-solution (§6.2), like/follow toggles, comments (§10.2), the admin
// status-override control (§7.2/§8.2), assignment + unassignment (§7.3), anonymity reveal (§9,
// admin transient in a dialog + author self-reveal, on the challenge and on each solution), the
// §11 attachment control, the §8.3 like freeze, the platform-admin danger zone (§10.3, §10.4:
// Move to trash / Delete permanently), and the §25.8 "via agent" tag on the author line and on
// each solution card. A platform admin who opens an item in the trash sees it read-only under a
// banner with Restore and Delete permanently; every other control is absent. Invite a solver
// (§40.2) sits beside Propose a solution, and an invitee sees the §40.3 banner under the header.
import { useParams, useRouter } from "next/navigation";
import { reportFeatureUse } from "@/lib/survey-client";
import { useEffect, useRef, useState } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { readJson } from "@/lib/api-client";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL, statusPillClass } from "../status";
import { CommentThread } from "@/components/CommentThread";
import { AvatarBubble } from "@/components/AvatarBubble";
import { UserResultButton } from "@/components/UserResultButton";
import { AttachmentControl } from "@/components/AttachmentControl";
import { AttachmentDropZone } from "@/components/AttachmentDropZone";
import { LIKES_FROZEN_HINT, proposeDisabledReason, splitSolutions } from "@/lib/challenge-detail";
import { FormLockOverlay, PrimaryButtonLabel, useFormLock } from "@/components/FormLock";
import { primaryButtonState } from "@/lib/form-lock";
import { FeatureOnHomeControl } from "@/components/FeatureOnHomeControl";
import { ImproveWithAiBar, useImproveWithAi } from "@/components/ImproveWithAi";
import { TriageNotesPanel } from "@/components/TriageNotesPanel";
import { DangerZone, TrashedBanner, type TrashInfo } from "@/components/TrashControls";
import { ViaAgentTag, type ViaAgent } from "@/components/ViaAgentTag";
import { VisibilityControl } from "@/components/VisibilityControl";
import { PEOPLE_VISIBILITY_LABEL, type AccessEntryView } from "@innobox/shared/challenge-access";
import { HypeButton, HypeCount, HypersList, type HypeFields } from "@/components/Hype";
import { invalidateApi } from "@/lib/ui";
import { TopicChips } from "@/components/TopicChips";
import { TopicPicker, useActiveTopics, type TopicTag } from "@/components/TopicPicker";
import { TeamBubbles } from "@/components/TeamByline";
import { ANONYMOUS_NO_COAUTHORS_HINT, CoAuthorPicker, TeamFullNames, TeamPanel, type TeamMember } from "@/components/TeamPanel";
import type { UserResult } from "@/components/UserResultButton";
import { InvitationBanner, InviteSolverButton, type InvitationsSent, type InvitedBy } from "@/components/InviteSolver";
import { OWN_ITEM_REVIEW_HINT } from "@innobox/shared/coauthors";

interface MaskedAuthor {
  userId: string | null;
  displayName: string;
  anonymous: boolean;
  active?: boolean;
  scrubbed?: boolean;
  /** §24.6: accepted from the public form — no author, the "External submission" label. */
  external?: boolean;
}

/** §24.6 "Submitted from outside" — present for the item's namespace admins and platform admins. */
interface ExternalContact {
  submissionId: string;
  name: string | null;
  email: string | null;
  confirmedAt: string | null;
  erasedAt: string | null;
}

interface AttachmentItem {
  id: string;
  filename: string;
  sizeBytes: number;
  mime: string;
  status: "pending" | "clean" | "infected" | "unscannable";
  isUploader: boolean;
  createdAt: string;
}

/** §26.11: present only while hype is on. */
interface SolutionItem extends Partial<HypeFields> {
  id: string;
  number: string;
  description: string;
  costVsBenefits: string | null;
  author: MaskedAuthor;
  /** §39.7: every member in order (the creator flagged) — or the single anonymous shape. */
  authors?: TeamMember[];
  isMine: boolean;
  status: string;
  createdAt: string;
  /** §39.5: sent back as `baseEditedAt` on an edit. */
  editedAt: string | null;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  canOverrideStatus: boolean;
  canReveal: boolean;
  canSelfReveal: boolean;
  allowedTransitions: string[];
  /** §39.5: a committee member who is an author of this solution. */
  reviewBarred?: boolean;
  canManageTeam?: boolean;
  canLeave?: boolean;
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  canDelete: boolean;
  canTrash: boolean;
  canRestore: boolean;
  restoreBlocked: boolean;
  /** Platform admins only: set while this solution itself is in the trash. */
  trashed?: TrashInfo | null;
  attachments: AttachmentItem[];
  /** §25.8: set when proposed through an AI agent (client name masked on anonymous items). */
  viaAgent?: ViaAgent;
}

interface ChallengeDetail extends Partial<HypeFields> {
  /** §26.11: the viewer's budget — present only while hype is on. */
  hypesLeft?: number;
  id: string;
  number: string;
  title: string;
  description: string;
  author: MaskedAuthor;
  /** §39.7: every member in order (the creator flagged) — or the single anonymous/external shape. */
  authors?: TeamMember[];
  namespaceSlug: string;
  namespaceId: string;
  impactAreaName: string;
  /** §34.6: alphabetical; a retired one is muted (`active: false`). */
  topics: TopicTag[];
  /** §34.3: the challenge's namespace admins and platform admins — curation, any status. */
  canEditTopics: boolean;
  clientName: string | null;
  visibility: "org" | "namespace" | "people";
  /** §4.3: the access list of a `people` challenge — sent to its admins only, null otherwise. */
  access: AccessEntryView[] | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  assigneeActive?: boolean | null;
  assigneeScrubbed?: boolean | null;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  solutionCount: number;
  isMine: boolean;
  canPropose: boolean;
  namespaceArchived: boolean;
  likesFrozen: boolean;
  canReveal: boolean;
  canSelfReveal: boolean;
  canAssign: boolean;
  canOverrideStatus: boolean;
  allowedTransitions: string[];
  /** §39.5: a committee member who is an author of this challenge — the line in place of the control. */
  reviewBarred?: boolean;
  /** §39.13: a member, joining open, not anonymous. */
  canManageTeam?: boolean;
  /** §39.13: a member who is not the only one. */
  canLeave?: boolean;
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  canDelete: boolean;
  canTrash: boolean;
  canRestore: boolean;
  /** Platform admins only: set while the challenge is in the trash (the read-only view). */
  trashed?: TrashInfo | null;
  /** §13.2 Home pin: `featured` for everyone; the control + provenance only via `canFeature`. */
  featured: boolean;
  canFeature: boolean;
  featuredBy?: string;
  featuredAt?: string;
  impactAreaId: string;
  /** §24.6: set on a challenge accepted from the public form. */
  external: { company: string | null } | null;
  externalContact: ExternalContact | null;
  solutions: SolutionItem[];
  attachments: AttachmentItem[];
  /** §25.8: set when submitted through an AI agent (client name masked on anonymous items). */
  viaAgent?: ViaAgent;
  /** §40.11: the challenge accepts invitations from this viewer (the challenge half of canPropose). */
  canInvite?: boolean;
  /** §40.2: the viewer's own "You invited" list and room left — null while canInvite is false. */
  invitations?: InvitationsSent | null;
  /** §40.3: the viewer's open invitations — null when they have none. */
  invited?: { inviters: InvitedBy[] } | null;
}

export default function ChallengeDetailPage() {
  const params = useParams<{ number: string }>();
  const number = params.number;

  const [challenge, setChallenge] = useState<ChallengeDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // §6.4: a locked submit (solution form, Resubmit) is held until the re-read has RENDERED, not
  // merely been fetched. refresh() therefore resolves only once the new challenge is committed —
  // its resolver waits here and the effect below fires it after that render.
  const rendered = useRef<(() => void)[]>([]);

  useEffect(() => {
    for (const resolve of rendered.current.splice(0)) resolve();
  }, [challenge]);

  const refresh = (): Promise<void> =>
    new Promise<void>((resolve) => {
      fetch(`/api/challenges/${number}`, { headers: { accept: "application/json" } })
        .then(async (res) => {
          if (res.status === 404) {
            setNotFound(true);
            resolve();
            return;
          }
          const json = await readJson(res);
          if (!res.ok) throw new Error(json.error ?? "Could not load challenge");
          rendered.current.push(resolve);
          setChallenge(json.challenge as ChallengeDetail);
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Could not load challenge");
          resolve();
        });
    });

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  if (notFound) {
    return (
      <div className="card card-pad empty reveal">
        <div className="ico">🔍</div>
        <p className="muted" style={{ margin: 0 }}>
          That challenge doesn&apos;t exist, or you don&apos;t have access to it.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card card-pad empty reveal">
        <div className="ico">⚠️</div>
        <p className="muted" style={{ margin: 0 }}>
          {error}
        </p>
      </div>
    );
  }

  if (!challenge) return <p className="muted">Loading…</p>;

  return <ChallengeDetailView challenge={challenge} onChanged={refresh} />;
}

function ChallengeDetailView({ challenge, onChanged }: { challenge: ChallengeDetail; onChanged: () => Promise<void> }) {
  const fmt = useDateFmt();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedAuthor | null>(null);
  const [assigneeQuery, setAssigneeQuery] = useState("");
  const [assigneeResults, setAssigneeResults] = useState<{ id: string; displayName: string; email: string | null }[]>([]);
  // §40.3: the banner's Propose a solution opens the page's own form — each click bumps the request.
  const [proposeRequest, setProposeRequest] = useState(0);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3200);
  };

  const toggleLike = async (parentType: "challenge" | "solution", parentId: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/likes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentType, parentId }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not update like");
      if (json.liked === true) reportFeatureUse("like"); // §13.10 first use: adding a like
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not update like");
    } finally {
      setBusy(false);
    }
  };

  // §26: spend one of this week's hypes. Home's board and the budget in `me` change with it.
  const giveHype = async (parentType: "challenge" | "solution", parentId: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/hypes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentType, parentId }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not hype this");
      invalidateApi("/api/dashboard");
      invalidateApi("/api/me");
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not hype this");
    } finally {
      setBusy(false);
    }
  };

  const toggleFollow = async (parentType: "challenge" | "solution", parentId: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/follows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentType, parentId }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not update follow");
      if (json.following === true) reportFeatureUse("follow"); // §13.10: an explicit follow only
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not update follow");
    } finally {
      setBusy(false);
    }
  };

  // Serves both modes: an admin free-set (override) and a committee/assignee enforced
  // transition (§7.2) — the endpoint decides which from the caller's role. `enforced` marks the
  // committee/assignee control, whose success is the §13.10 "review" first use.
  const changeChallengeStatus = async (status: string, enforced = false) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not change status");
      if (enforced) reportFeatureUse("review");
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change status");
    } finally {
      setBusy(false);
    }
  };

  const changeSolutionStatus = async (solutionNumber: string, status: string, enforced = false) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/solutions/${solutionNumber.replace("SOL-", "")}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not change status");
      if (enforced) reportFeatureUse("review");
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change status");
    } finally {
      setBusy(false);
    }
  };

  // §9 audited admin reveal — transient: the identity lives only in the reveal dialog's state
  // (never in the byline, never persisted), and every execution is audited server-side.
  // `itemNumber` is the CH-/SOL- number, which also picks the endpoint.
  const reveal = async (itemNumber: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${itemApiPath(itemNumber)}/reveal`, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not reveal author");
      setRevealed({
        itemNumber,
        displayName: json.displayName as string,
        email: (json.email as string) ?? null,
        userId: (json.userId as string) ?? null,
        active: json.active !== false,
        scrubbed: json.scrubbed === true,
      });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not reveal author");
    } finally {
      setBusy(false);
    }
  };

  const selfReveal = async (itemNumber: string) => {
    const what = itemNumber.startsWith("SOL-") ? "solution" : "challenge";
    if (!window.confirm(`This permanently removes your anonymity on this ${what}. Continue?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`${itemApiPath(itemNumber)}/self-reveal`, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not reveal yourself");
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not reveal yourself");
    } finally {
      setBusy(false);
    }
  };

  const searchAssignees = async (q: string) => {
    setAssigneeQuery(q);
    if (q.trim().length < 2) {
      setAssigneeResults([]);
      return;
    }
    // §7.3: only users who can see this challenge are offered.
    const res = await fetch(`/api/users?q=${encodeURIComponent(q)}&challenge=${challenge.number.replace("CH-", "")}`);
    const json = await readJson(res);
    setAssigneeResults((json.users as { id: string; displayName: string; email: string | null }[]) ?? []);
  };

  const assign = async (userId: string | null) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not assign");
      setAssigneeQuery("");
      setAssigneeResults([]);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not assign");
    } finally {
      setBusy(false);
    }
  };

  // §10.1 author actions: withdraw / resubmit are simple POSTs to the item's sub-routes; edit
  // opens an inline form (below). `editingSolution` holds the id of the solution being edited.
  const [editingChallenge, setEditingChallenge] = useState(false);
  const [editingSolution, setEditingSolution] = useState<string | null>(null);

  const authorAction = async (path: string, verb: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? `Could not ${verb}`);
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : `Could not ${verb}`);
    } finally {
      setBusy(false);
    }
  };

  // §6.4 submission lock for Resubmit: one lock for the page, owned by the item (challenge or
  // solution id) whose author action bar — and inline edit form, if open — it covers. Errors
  // release it and show through the page's notice; a success is held until the detail re-read
  // has rendered (the item is then in_review and the bar no longer offers Resubmit).
  const resubmitLock = useFormLock();
  const resubmit = async (owner: string, path: string) => {
    if (!resubmitLock.lock(owner)) return;
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not resubmit");
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not resubmit");
      resubmitLock.release();
      setBusy(false);
      return;
    }
    resubmitLock.succeed();
    await onChanged();
    resubmitLock.reset();
    setBusy(false);
  };
  const challengeLocked = resubmitLock.lockedFor(challenge.id);

  // §10.3 platform-admin permanent delete. The reason is mandatory (the server refuses a
  // blank one) and the deleted item is gone for good — so a challenge delete leaves this
  // page entirely (for the trash page when it came from the trash), while a solution delete just
  // re-reads the challenge.
  const deletePermanently = async (path: string, reason: string, after: "leave" | "refresh"): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not delete");
      if (after === "leave") router.push(challenge.trashed ? "/admin/trash" : "/challenges");
      else onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  };

  // §10.4 Move to trash / Restore: both keep this page — a trashed item re-reads into its
  // read-only view under the banner, and a restored one comes back exactly as it was.
  const trashAction = async (path: string, verb: "trash" | "restore", reason?: string): Promise<void> => {
    setBusy(true);
    try {
      const res = await fetch(`${path}/${verb}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reason === undefined ? {} : { reason }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? (verb === "trash" ? "Could not move to the trash" : "Could not restore"));
      notify(verb === "trash" ? "Moved to the trash." : "Restored.");
      await onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : verb === "trash" ? "Could not move to the trash" : "Could not restore");
    } finally {
      setBusy(false);
    }
  };

  const chNum = challenge.number.replace("CH-", "");
  const withdrawChallenge = () => authorAction(`/api/challenges/${chNum}/withdraw`, "withdraw", "Withdraw this challenge? This is permanent — it becomes read-only and hidden from others.");
  const resubmitChallenge = () => resubmit(challenge.id, `/api/challenges/${chNum}/resubmit`);
  const withdrawSolution = (solutionNumber: string) =>
    authorAction(`/api/solutions/${solutionNumber.replace("SOL-", "")}/withdraw`, "withdraw", "Withdraw this solution? This is permanent.");
  const resubmitSolution = (solutionId: string, solutionNumber: string) =>
    resubmit(solutionId, `/api/solutions/${solutionNumber.replace("SOL-", "")}/resubmit`);

  // Deep-link (§12.1/§13.1): solution-scoped links resolve to this page with a #SOL-<n> hash —
  // scroll that solution into view once the detail (and its solution rows) have rendered.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    // A closed solution sits in the collapsed "Closed solutions" section — open it first.
    const section = el.closest("details");
    if (section) section.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // §10.4: the read-only trashed view — only a platform admin is ever sent a trashed challenge.
  const readOnly = challenge.trashed != null;
  const canReveal = challenge.canReveal && challenge.author.anonymous;
  const canSelfReveal = challenge.canSelfReveal && challenge.author.anonymous;
  const likeHint = challenge.likesFrozen ? LIKES_FROZEN_HINT : undefined;
  // §4.3: closed solutions go to a collapsed section; the heading counts only the open list.
  const { open: openSolutions, closed: closedSolutions } = splitSolutions(challenge.solutions);

  const renderSolution = (s: SolutionItem) => {
    const solutionReadOnly = readOnly || s.trashed != null;
    const solutionPath = `/api/solutions/${s.number.replace("SOL-", "")}`;
    const solutionWhat = `${s.number} and all comments, likes, follows, and files attached to it`;
    return (
    <div className="row" key={s.id} id={s.number} data-attach-scope style={{ flexDirection: "column", alignItems: "stretch", gap: 10, scrollMarginTop: 80 }}>
      {s.trashed && (
        <TrashedBanner
          kind="solution"
          label={s.number}
          what={solutionWhat}
          trashed={s.trashed}
          restoreBlocked={s.restoreBlocked}
          busy={busy}
          onRestore={() => trashAction(solutionPath, "restore")}
          onDelete={(reason) => deletePermanently(solutionPath, reason, "refresh")}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className="chip mono">{s.number}</span>
        <span className={statusPillClass(s.status)}>{SOLUTION_STATUS_LABEL[s.status] ?? s.status}</span>
        {/* §39.7: the full form — every member in order, bubble and name (one bubble for a solo item). */}
        {teamOfItem(s).length === 1 && <TeamBubbles authors={teamOfItem(s)} />}
        <span className="sub" style={{ flex: 1 }}>
          <TeamFullNames authors={teamOfItem(s)} /> · {fmt.date(s.createdAt)}
          <ViaAgentTag via={s.viaAgent} />
        </span>
        {solutionReadOnly ? (
          <>
            <span className="sub mono">♡ {s.likeCount}</span>
            {s.hype !== undefined && <HypeCount value={s.hype} className="sub mono hype-count" />}
          </>
        ) : (
          <>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => toggleFollow("solution", s.id)}>
              {s.followedByViewer ? "Following" : "Follow"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || challenge.likesFrozen}
              title={likeHint}
              aria-label={likeHint ? `${s.likeCount} likes. ${likeHint}` : undefined}
              onClick={() => toggleLike("solution", s.id)}
            >
              {s.likedByViewer ? "♥" : "♡"} {s.likeCount}
            </button>
            {s.hypeReason !== undefined && (
              <HypeButton item={s as HypeFields} hypesLeft={challenge.hypesLeft ?? 0} busy={busy} onHype={() => giveHype("solution", s.id)} />
            )}
          </>
        )}
      </div>
      {s.hypers && <HypersList hypers={s.hypers} />}
      {s.author.anonymous && (s.canReveal || s.canSelfReveal) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignSelf: "flex-start" }}>
          {s.canReveal && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => reveal(s.number)}>
              Reveal author
            </button>
          )}
          {s.canSelfReveal && (
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => selfReveal(s.number)}>
              Reveal myself (permanent)
            </button>
          )}
        </div>
      )}
      <p style={{ whiteSpace: "pre-wrap", fontSize: 14, margin: 0 }}>{s.description}</p>
      {s.costVsBenefits && (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          <strong>Cost vs. benefits:</strong> {s.costVsBenefits}
        </p>
      )}
      {s.canOverrideStatus && (
        <select
          className="field"
          style={{ alignSelf: "flex-start" }}
          value={s.status}
          disabled={busy}
          onChange={(e) => changeSolutionStatus(s.number, e.target.value)}
        >
          {Object.keys(SOLUTION_STATUS_LABEL).map((st) => (
            <option key={st} value={st}>
              {SOLUTION_STATUS_LABEL[st]}
            </option>
          ))}
        </select>
      )}
      {!s.canOverrideStatus && s.allowedTransitions.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignSelf: "flex-start" }}>
          {s.allowedTransitions.map((st) => (
            <button key={st} type="button" className="btn btn-sm" disabled={busy} onClick={() => changeSolutionStatus(s.number, st, true)}>
              → {SOLUTION_STATUS_LABEL[st] ?? st}
            </button>
          ))}
        </div>
      )}
      {s.reviewBarred && (
        <p className="muted review-barred" style={{ fontSize: 13, margin: 0 }}>
          {OWN_ITEM_REVIEW_HINT}
        </p>
      )}
      {(s.canEdit || s.canResubmit || s.canWithdraw) && (
        <div className="form-lock" aria-busy={resubmitLock.lockedFor(s.id)} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignSelf: "flex-start" }}>
            {s.canEdit && (
              <button
                type="button"
                className="btn btn-sm"
                inert={resubmitLock.lockedFor(s.id)}
                disabled={busy}
                onClick={() => setEditingSolution((cur) => (cur === s.id ? null : s.id))}
              >
                {editingSolution === s.id ? "Cancel edit" : "Edit"}
              </button>
            )}
            {s.canResubmit && (
              <ResubmitButton locked={resubmitLock.lockedFor(s.id)} busy={busy} label="Resubmit" onClick={() => resubmitSolution(s.id, s.number)} />
            )}
            {s.canWithdraw && (
              <button type="button" className="btn btn-sm btn-danger" inert={resubmitLock.lockedFor(s.id)} disabled={busy} onClick={() => withdrawSolution(s.number)}>
                Withdraw
              </button>
            )}
          </div>
          {editingSolution === s.id && s.canEdit && (
            <div inert={resubmitLock.lockedFor(s.id)}>
              <SolutionEditForm solution={s} onDone={() => setEditingSolution(null)} onSaved={onChanged} onError={notify} />
            </div>
          )}
          <FormLockOverlay locked={resubmitLock.lockedFor(s.id)} />
        </div>
      )}
      {s.isMine && !solutionReadOnly && !s.author.anonymous && (
        <TeamPanel
          itemNumber={s.number}
          authors={teamOfItem(s)}
          canManageTeam={s.canManageTeam === true}
          canLeave={s.canLeave === true}
          onChanged={onChanged}
          onError={notify}
        />
      )}
      {s.canDelete && !solutionReadOnly && (
        <DangerZone
          label={s.number}
          what={solutionWhat}
          note={
            s.status === "implemented" && challenge.status === "solved"
              ? "This challenge was solved by this solution, so a permanent delete returns it to “Valid — open for solutions”. Other solutions stay closed. Moving it to the trash changes nothing until it is deleted."
              : undefined
          }
          busy={busy}
          canTrash={s.canTrash}
          onTrash={(reason) => trashAction(solutionPath, "trash", reason)}
          onDelete={(reason) => deletePermanently(solutionPath, reason, "refresh")}
        />
      )}
      <AttachmentControl
        parentType="solution"
        target={{ kind: "bound", parentId: s.id, attachments: s.attachments, canUpload: s.canEdit, onChanged }}
        disabled={resubmitLock.lockedFor(s.id)}
        dropLabel={`Your solution ${s.number}`}
      />
      <CommentThread
        parentType="solution"
        parentId={s.id}
        parentNumber={s.number}
        authoredAnonymously={s.isMine && s.author.anonymous}
        readOnly={solutionReadOnly}
      />
    </div>
    );
  };

  const challengeWhat = `${challenge.number}, every solution on it, and all comments, likes, follows, and files attached to any of them`;

  // §11 Drop and paste: the page is one drop zone; each editable upload control is a target.
  return (
    <AttachmentDropZone>
      {challenge.trashed && (
        <TrashedBanner
          kind="challenge"
          label={challenge.number}
          what={challengeWhat}
          trashed={challenge.trashed}
          busy={busy}
          onRestore={() => trashAction(`/api/challenges/${chNum}`, "restore")}
          onDelete={(reason) => deletePermanently(`/api/challenges/${chNum}`, reason, "leave")}
        />
      )}
      <div className="page-head reveal">
        <div className="eyebrow">{challenge.number}</div>
        <h1 className="page-title" style={{ fontSize: "clamp(26px, 4vw, 38px)" }}>
          {challenge.title}
        </h1>
        <div className="meta" style={{ marginTop: 14 }}>
          <span className={statusPillClass(challenge.status)}>{CHALLENGE_STATUS_LABEL[challenge.status] ?? challenge.status}</span>
          <span className="chip">{challenge.impactAreaName}</span>
          {challenge.clientName && <span className="chip">{challenge.clientName}</span>}
          <span className="chip">/{challenge.namespaceSlug}</span>
          <span className="chip">
            {challenge.visibility === "org" ? "Organization-wide" : challenge.visibility === "namespace" ? "Namespace-only" : PEOPLE_VISIBILITY_LABEL}
          </span>
        </div>
        {/* §34.6: keyed on the server's topics, so a re-read resets any local edit state. */}
        <ChallengeTopicsRow key={(challenge.topics ?? []).map((t) => t.id).join(",")} challenge={challenge} onSaved={onChanged} />
      </div>

      {!readOnly && challenge.invited && (
        <InvitationBanner
          challengeNumber={challenge.number}
          inviters={challenge.invited.inviters}
          canPropose={challenge.canPropose}
          busy={busy}
          onPropose={() => setProposeRequest((n) => n + 1)}
          onDismissed={onChanged}
          onError={notify}
        />
      )}

      <div className="card card-pad reveal" data-attach-scope style={{ marginBottom: 18 }}>
        <div className="row detail-head" style={{ border: 0, padding: 0, marginBottom: 16 }}>
          {teamOfItem(challenge).length === 1 && <TeamBubbles authors={teamOfItem(challenge)} size="md" />}
          <div className="grow">
            <div className="ttl">
              {/* §39.7: the full form — every member in order, bubble and name. */}
              <TeamFullNames authors={teamOfItem(challenge)} />
              <ViaAgentTag via={challenge.viaAgent} />
            </div>
            <div className="sub mono">
              {fmt.dateTime(challenge.createdAt)}
              {challenge.editedAt && ` · edited ${fmt.dateTime(challenge.editedAt)}`}
              {!challenge.editedAt && challenge.updatedAt !== challenge.createdAt && ` · updated ${fmt.dateTime(challenge.updatedAt)}`}
            </div>
            {challenge.assigneeDisplayName && (
              <div className="sub" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                assignee:{" "}
                <AvatarBubble
                  size="sm"
                  userId={challenge.assigneeId}
                  displayName={challenge.assigneeDisplayName}
                  deactivated={challenge.assigneeActive === false}
                  scrubbed={challenge.assigneeScrubbed === true}
                />{" "}
                {challenge.assigneeDisplayName}
              </div>
            )}
          </div>
          {readOnly ? (
            <>
              <span className="sub mono">♡ {challenge.likeCount}</span>
              {challenge.hype !== undefined && <HypeCount value={challenge.hype} className="sub mono hype-count" />}
            </>
          ) : (
            <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => toggleFollow("challenge", challenge.id)}>
                {challenge.followedByViewer ? "Following" : "Follow"}
              </button>
              {/* §8.3: frozen on a solved challenge — the count stays, the button takes no clicks. */}
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || challenge.likesFrozen}
                title={likeHint}
                aria-label={likeHint ? `${challenge.likeCount} likes. ${likeHint}` : undefined}
                onClick={() => toggleLike("challenge", challenge.id)}
              >
                {challenge.likedByViewer ? "♥" : "♡"} {challenge.likeCount}
              </button>
              {challenge.hypeReason !== undefined && (
                <HypeButton item={challenge as HypeFields} hypesLeft={challenge.hypesLeft ?? 0} busy={busy} onHype={() => giveHype("challenge", challenge.id)} />
              )}
            </>
          )}
        </div>
        {challenge.hypers && <HypersList hypers={challenge.hypers} />}
        <p style={{ whiteSpace: "pre-wrap", fontSize: 14.5, lineHeight: 1.65 }}>{challenge.description}</p>

        {challenge.externalContact && (
          <ExternalContactPanel contact={challenge.externalContact} canErase={challenge.canDelete && !readOnly} onErased={onChanged} onError={notify} />
        )}

        {(canReveal || canSelfReveal) && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {canReveal && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => reveal(challenge.number)}>
                Reveal author
              </button>
            )}
            {canSelfReveal && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => selfReveal(challenge.number)}>
                Reveal myself (permanent)
              </button>
            )}
          </div>
        )}

        {(challenge.canEdit || challenge.canResubmit || challenge.canWithdraw) && (
          <div className="form-lock" aria-busy={challengeLocked}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              {challenge.canEdit && (
                <button type="button" className="btn btn-sm" inert={challengeLocked} disabled={busy} onClick={() => setEditingChallenge((v) => !v)}>
                  {editingChallenge ? "Cancel edit" : "Edit"}
                </button>
              )}
              {challenge.canResubmit && (
                <ResubmitButton locked={challengeLocked} busy={busy} label="Resubmit for review" onClick={resubmitChallenge} />
              )}
              {challenge.canWithdraw && (
                <button type="button" className="btn btn-sm btn-danger" inert={challengeLocked} disabled={busy} onClick={withdrawChallenge}>
                  Withdraw
                </button>
              )}
            </div>

            {editingChallenge && challenge.canEdit && (
              <div inert={challengeLocked}>
                <ChallengeEditForm challenge={challenge} onDone={() => setEditingChallenge(false)} onSaved={onChanged} onError={notify} />
              </div>
            )}
            <FormLockOverlay locked={challengeLocked} />
          </div>
        )}

        {challenge.isMine && !readOnly && !challenge.author.anonymous && (
          <TeamPanel
            itemNumber={challenge.number}
            authors={teamOfItem(challenge)}
            canManageTeam={challenge.canManageTeam === true}
            canLeave={challenge.canLeave === true}
            onChanged={onChanged}
            onError={notify}
          />
        )}

        <div style={{ marginTop: 14 }}>
          <AttachmentControl
            parentType="challenge"
            target={{ kind: "bound", parentId: challenge.id, attachments: challenge.attachments, canUpload: challenge.canEdit, onChanged }}
            disabled={challengeLocked}
            dropLabel="This challenge"
          />
        </div>

        {!challenge.canOverrideStatus && challenge.allowedTransitions.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
            <label style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8, display: "block" }}>
              Move status
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {challenge.allowedTransitions.map((s) => (
                <button key={s} type="button" className="btn btn-sm" disabled={busy} onClick={() => changeChallengeStatus(s, true)}>
                  → {CHALLENGE_STATUS_LABEL[s] ?? s}
                </button>
              ))}
            </div>
          </div>
        )}

        {challenge.reviewBarred && (
          <p className="muted review-barred" style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)", fontSize: 13 }}>
            {OWN_ITEM_REVIEW_HINT}
          </p>
        )}

        {challenge.canOverrideStatus && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
            <label style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8, display: "block" }}>
              Admin override
            </label>
            <select
              className="field"
              value={challenge.status}
              disabled={busy}
              onChange={(e) => changeChallengeStatus(e.target.value)}
            >
              {/* §24.6: an outside submission has no author to improve it — needs_improvement is left out. */}
              {Object.keys(CHALLENGE_STATUS_LABEL)
                .filter((s) => !(challenge.external && s === "needs_improvement"))
                .map((s) => (
                  <option key={s} value={s}>
                    {CHALLENGE_STATUS_LABEL[s]}
                  </option>
                ))}
            </select>

            {/* §4.3: keyed on the saved state, so a reload after a save starts the editor afresh. */}
            <VisibilityControl
              key={`${challenge.visibility}|${(challenge.access ?? []).map((e) => e.user?.id ?? e.email).join(",")}`}
              challengeNumber={challenge.number}
              visibility={challenge.visibility}
              access={challenge.access}
              disabled={busy}
              onSaved={onChanged}
              onError={notify}
            />
          </div>
        )}

        {challenge.canAssign && (
          <div style={{ marginTop: 14, position: "relative" }}>
            <label
              htmlFor="assignee-search"
              style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8, display: "block" }}
            >
              Assignee
            </label>
            {/* §7.3: the current assignee with an explicit Unassign — the search below only ever
                assigns or reassigns, so nothing unassigns by accident. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              {challenge.assigneeId && challenge.assigneeDisplayName ? (
                <>
                  <AvatarBubble
                    size="sm"
                    userId={challenge.assigneeId}
                    displayName={challenge.assigneeDisplayName}
                    deactivated={challenge.assigneeActive === false}
                    scrubbed={challenge.assigneeScrubbed === true}
                  />
                  <span style={{ fontSize: 14 }}>{challenge.assigneeDisplayName}</span>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => assign(null)}>
                    Unassign
                  </button>
                </>
              ) : (
                <span className="muted" style={{ fontSize: 14 }}>
                  Unassigned
                </span>
              )}
            </div>
            <input
              id="assignee-search"
              className="field"
              placeholder={challenge.assigneeId ? "Reassign: search users by name or email…" : "Search users by name or email…"}
              value={assigneeQuery}
              onChange={(e) => searchAssignees(e.target.value)}
            />
            {assigneeResults.length > 0 && (
              <div className="menu-pop user-search-pop" style={{ position: "absolute", zIndex: 10, marginTop: 4, width: "100%", maxWidth: 320 }}>
                {assigneeResults.map((u) => (
                  <UserResultButton key={u.id} user={u} onClick={() => assign(u.id)} />
                ))}
              </div>
            )}
          </div>
        )}

        {challenge.canFeature && (
          <FeatureOnHomeControl
            challengeDigits={chNum}
            featured={challenge.featured}
            featuredBy={challenge.featuredBy}
            featuredAt={challenge.featuredAt}
            onChanged={onChanged}
          />
        )}

        {challenge.canDelete && !readOnly && (
          <DangerZone
            label={challenge.number}
            what={challengeWhat}
            busy={busy}
            canTrash={challenge.canTrash}
            onTrash={(reason) => trashAction(`/api/challenges/${chNum}`, "trash", reason)}
            onDelete={(reason) => deletePermanently(`/api/challenges/${chNum}`, reason, "leave")}
          />
        )}
      </div>

      {!readOnly && (
        <>
          {/* §22.11: shown only to those the server allows (never the author); renders nothing otherwise. */}
          <TriageNotesPanel challengeNumber={challenge.number} version={`${challenge.status}|${challenge.updatedAt}|${challenge.editedAt ?? ""}`} />

          <ProposeSolutionForm
            challengeNumber={challenge.number}
            disabledReason={challenge.canPropose ? null : proposeDisabledReason(challenge.status, challenge.namespaceArchived)}
            restricted={challenge.visibility !== "org"}
            onProposed={onChanged}
            openRequest={proposeRequest}
            beside={
              challenge.canInvite && challenge.invitations ? (
                <InviteSolverButton
                  challengeNumber={challenge.number}
                  invitations={challenge.invitations}
                  busy={busy}
                  onSent={async (toast) => {
                    notify(toast);
                    await onChanged();
                  }}
                />
              ) : null
            }
          />
        </>
      )}

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 21, margin: "26px 0 14px" }}>
        Solutions {openSolutions.length > 0 && `(${openSolutions.length})`}
      </h2>

      {openSolutions.length === 0 && <p className="muted">{closedSolutions.length === 0 ? "No solutions yet." : "No open solutions."}</p>}

      {openSolutions.length > 0 && (
        <div className="rows" style={{ marginBottom: 26 }}>
          {openSolutions.map(renderSolution)}
        </div>
      )}

      {closedSolutions.length > 0 && (
        <details data-testid="closed-solutions" style={{ marginBottom: 26 }}>
          <summary style={{ cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 600, marginBottom: 14 }}>
            Closed solutions ({closedSolutions.length})
          </summary>
          <div className="rows">{closedSolutions.map(renderSolution)}</div>
        </details>
      )}

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 21, margin: "26px 0 14px" }}>Discussion</h2>
      <CommentThread
        parentType="challenge"
        parentId={challenge.id}
        parentNumber={challenge.number}
        authoredAnonymously={challenge.isMine && challenge.author.anonymous}
        readOnly={readOnly}
      />

      {revealed && <RevealDialog revealed={revealed} onClose={() => setRevealed(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </AttachmentDropZone>
  );
}

interface RevealedAuthor {
  /** The CH-/SOL- number of the item whose author was revealed. */
  itemNumber: string;
  displayName: string;
  email: string | null;
  userId: string | null;
  /** §13.6: the revealed author's account state — greyed or neutral bubble in the dialog. */
  active: boolean;
  scrubbed: boolean;
}

/** `/api/challenges/<n>` or `/api/solutions/<n>` for a CH-/SOL- number. */
/** §39.7: the item's team — `authors` when present, else the single `author`. */
function teamOfItem(item: { author: MaskedAuthor; authors?: TeamMember[] }): TeamMember[] {
  return item.authors && item.authors.length > 0 ? item.authors : [item.author];
}

function itemApiPath(itemNumber: string): string {
  return itemNumber.startsWith("SOL-")
    ? `/api/solutions/${itemNumber.replace("SOL-", "")}`
    : `/api/challenges/${itemNumber.replace("CH-", "")}`;
}

/**
 * The §9 reveal dialog (§13.6): a modal with the revealed author's real, large avatar bubble
 * beside their name, flagged as visible to this admin only. Transient by construction — closing
 * it drops the identity from state, and nothing else on the page changes. The bubble opts out of
 * the directory hover card (§13.8): the dialog already names the person.
 */
function RevealDialog({ revealed, onClose }: { revealed: RevealedAuthor; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="author-reveal-dialog"
      aria-labelledby="author-reveal-name"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its content) closes it.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
    >
      <div className="author-reveal-body">
        <div className="eyebrow">Author of {revealed.itemNumber}</div>
        <AvatarBubble
          size="lg"
          userId={revealed.userId}
          displayName={revealed.displayName}
          deactivated={!revealed.active}
          scrubbed={revealed.scrubbed}
          noCard
        />
        <h2 id="author-reveal-name" className="author-reveal-name">
          {revealed.displayName}
        </h2>
        {revealed.email && <div className="muted mono author-reveal-email">{revealed.email}</div>}
        <span className="pill pill-accent">Revealed to you only</span>
        <p className="muted author-reveal-note">Everyone else still sees this item as anonymous. This reveal has been recorded in the audit log.</p>
        <form method="dialog">
          <button type="submit" className="btn btn-primary btn-sm" autoFocus>
            Close
          </button>
        </form>
      </div>
    </dialog>
  );
}

// §24.6 "Submitted from outside": the outside submitter's name, e-mail and confirmation date — the
// only place they appear, shown to the item's namespace admins and platform admins (the server
// sends `externalContact` to nobody else). Platform admins may erase them at once (§24.8).
function ExternalContactPanel({
  contact,
  canErase,
  onErased,
  onError,
}: {
  contact: ExternalContact;
  canErase: boolean;
  onErased: () => void;
  onError: (message: string) => void;
}) {
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const erase = async () => {
    if (!window.confirm("Erase the submitter's name and e-mail? They can't be recovered, and no further e-mail will be sent to them.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/public-submissions/${contact.submissionId}/erase-contact`, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not erase the contact details");
      onErased();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not erase the contact details");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card card-pad" data-testid="external-contact" style={{ marginBottom: 14, background: "var(--surface-2)" }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>
        Submitted from outside
      </div>
      {contact.erasedAt ? (
        <p className="muted" style={{ margin: 0 }}>
          Contact details erased on {fmt.date(contact.erasedAt)}.
        </p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ttl">{contact.name}</div>
            <div className="sub mono" style={{ overflowWrap: "anywhere" }}>
              {contact.email}
              {contact.confirmedAt && ` · confirmed ${fmt.date(contact.confirmedAt)}`}
            </div>
          </div>
          {canErase && (
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={erase}>
              Erase contact details
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// The Resubmit action's button (§6.4): raised above its bar's scrim, "Working…" while locked.
function ResubmitButton({ locked, busy, label, onClick }: { locked: boolean; busy: boolean; label: string; onClick: () => void }) {
  const state = primaryButtonState({ locked, idleLabel: label });
  return (
    <button type="button" className="btn btn-sm btn-primary form-lock-raised" disabled={busy || state.disabled} onClick={onClick}>
      <PrimaryButtonLabel state={state} />
    </button>
  );
}

// §6.2 propose form. §6.4: locked while the create is in flight; on error it releases with the
// fields and staged files intact; on success it stays locked until the parent challenge has been
// re-read AND re-rendered, and only then closes. Improve with AI (§22.10) drafts the description
// and cost vs benefits from the author's text, with the challenge as context.
function ProposeSolutionForm({
  challengeNumber,
  disabledReason,
  restricted,
  onProposed,
  openRequest = 0,
  beside = null,
}: {
  challengeNumber: string;
  /** The parent challenge is namespace-only — restricted content for the AI draft (§22.7). */
  restricted: boolean;
  /** §13.1: the button is visible to every viewer but enabled only while `valid`; a non-null
   *  reason disables it and is shown beside it. The server refuses a proposal off `valid` anyway. */
  disabledReason: string | null;
  onProposed: () => Promise<void>;
  /** §40.3: bumped by the invitation banner's Propose a solution — opens the form and scrolls to it. */
  openRequest?: number;
  /** §40.2: shown beside the closed form's button — the Invite a solver button. */
  beside?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // A new request opens the form during render (no effect round trip); the effect only scrolls to
  // it once it is on screen, once per request.
  const [handledRequest, setHandledRequest] = useState(openRequest);
  if (openRequest !== handledRequest) {
    setHandledRequest(openRequest);
    setOpen(true);
  }
  const scrolledFor = useRef(0);
  useEffect(() => {
    if (!open || openRequest === 0 || scrolledFor.current === openRequest) return;
    scrolledFor.current = openRequest;
    formRef.current?.scrollIntoView({ block: "start" });
  }, [open, openRequest]);
  const [description, setDescription] = useState("");
  const [costVsBenefits, setCostVsBenefits] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  // §6.2 / §39: up to four co-authors who can see the challenge; exclusive with anonymity (§39.3).
  const [coAuthors, setCoAuthors] = useState<UserResult[]>([]);
  const [draftKey] = useState(() => crypto.randomUUID());
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const lock = useFormLock();
  const [error, setError] = useState<string | null>(null);
  const ai = useImproveWithAi({
    kind: "solution",
    fields: { description: [description, setDescription], costVsBenefits: [costVsBenefits, setCostVsBenefits] },
    body: () => ({ kind: "solution", challengeNumber, description, costVsBenefits }),
    restricted,
  });

  if (!open || disabledReason !== null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabledReason !== null}
          aria-describedby={disabledReason !== null ? "propose-disabled-reason" : undefined}
          onClick={() => setOpen(true)}
        >
          Propose a solution
        </button>
        {disabledReason !== null && (
          <span id="propose-disabled-reason" className="muted" style={{ fontSize: 13 }}>
            {disabledReason}
          </span>
        )}
        {beside}
      </div>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A second submit (double click, Enter) while locked is a no-op.
    if (ai.busy || !lock.lock()) return;
    ai.noteSubmit();
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${challengeNumber.replace("CH-", "")}/solutions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description, costVsBenefits: costVsBenefits || null, isAnonymous, draftKey, coAuthorIds: coAuthors.map((u) => u.id) }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not propose solution");
      reportFeatureUse("propose_solution");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not propose solution");
      lock.release();
      return;
    }
    lock.succeed();
    // Close only once the new solution is on screen — never alongside the refresh.
    await onProposed();
    setDescription("");
    setCostVsBenefits("");
    setIsAnonymous(false);
    setCoAuthors([]);
    setOpen(false);
    lock.reset();
  };

  const button = primaryButtonState({ locked: lock.locked, attachmentsBusy, idleLabel: "Submit solution" });

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="card card-pad reveal form-lock"
      data-attach-scope
      aria-busy={lock.locked}
      style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 18 }}
    >
      <div className="form-lock-body" inert={lock.locked}>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0 }}>Propose a solution</h3>
        <textarea
          className="field"
          style={{ minHeight: 100, resize: "vertical" }}
          placeholder="Describe your solution"
          aria-label="Solution description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            ai.noteEdit("description");
          }}
          readOnly={ai.busy}
          maxLength={10000}
          required
        />
        <textarea
          className="field"
          style={{ minHeight: 60, resize: "vertical" }}
          placeholder="Cost vs. benefits (optional)"
          aria-label="Cost vs. benefits"
          value={costVsBenefits}
          onChange={(e) => {
            setCostVsBenefits(e.target.value);
            ai.noteEdit("costVsBenefits");
          }}
          readOnly={ai.busy}
          maxLength={5000}
        />
        <ImproveWithAiBar ai={ai} disabled={lock.locked} />
        <AttachmentControl
          parentType="solution"
          target={{ kind: "staged", draftKey }}
          disabled={lock.locked}
          onBusyChange={setAttachmentsBusy}
          dropLabel="Your new solution"
        />
        <label style={EDIT_LABEL} htmlFor="propose-coauthors">
          Co-authors (optional)
        </label>
        <CoAuthorPicker
          id="propose-coauthors"
          value={coAuthors}
          onChange={setCoAuthors}
          variant={`canSee=${encodeURIComponent(challengeNumber)}`}
          disabled={isAnonymous || lock.locked}
          disabledHint={isAnonymous ? ANONYMOUS_NO_COAUTHORS_HINT : null}
        />
        <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14 }}>
          <input type="checkbox" checked={isAnonymous} disabled={coAuthors.length > 0} onChange={(e) => setIsAnonymous(e.target.checked)} />
          Submit anonymously
          {coAuthors.length > 0 && <span className="muted" style={{ fontSize: 12.5 }}>— {ANONYMOUS_NO_COAUTHORS_HINT}</span>}
        </label>
        {error && (
          <p className="muted" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn-primary form-lock-raised" disabled={button.disabled || ai.busy}>
          <PrimaryButtonLabel state={button} />
        </button>
        <span className="form-lock-body" inert={lock.locked}>
          <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </span>
      </div>
      <FormLockOverlay locked={lock.locked} />
    </form>
  );
}

const EDIT_LABEL: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--faint)",
};

// §34.3/§34.6: the detail page's Topics row — chips that lead to the filtered gallery and, for the
// challenge's namespace admins and platform admins, Edit topics: an inline picker saved through
// PUT /api/challenges/:number/topics (curation, not a content edit). Absent when the challenge has
// no topics and the viewer may not edit them.
function ChallengeTopicsRow({ challenge, onSaved }: { challenge: ChallengeDetail; onSaved: () => Promise<void> }) {
  const [topics, setTopics] = useState<TopicTag[]>(challenge.topics ?? []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TopicTag[]>(topics);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (topics.length === 0 && !challenge.canEditTopics) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}/topics`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicIds: draft.map((t) => t.id) }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not save the topics");
      setTopics((json.topics as TopicTag[]) ?? draft);
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the topics");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ch-topics">
      <span className="ch-topics-label">Topics</span>
      {!editing && (
        <>
          {topics.length > 0 ? <TopicChips topics={topics} /> : <span className="muted ch-topics-none">No topics</span>}
          {challenge.canEditTopics && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setDraft(topics);
                setError(null);
                setEditing(true);
              }}
            >
              Edit topics
            </button>
          )}
        </>
      )}
      {editing && (
        <div className="ch-topics-edit">
          <ActiveTopicPicker id="challenge-topics-edit" value={draft} onChange={setDraft} disabled={saving} />
          {error && (
            <div className="tag-error" role="alert">
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save topics"}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The picker with the active topics loaded — mounted only while editing, so a reader who never
 *  edits never fetches the list. */
function ActiveTopicPicker(props: { id: string; value: TopicTag[]; onChange: (next: TopicTag[]) => void; disabled: boolean }) {
  const options = useActiveTopics();
  return <TopicPicker {...props} options={options} />;
}

// §10.1 author edit of a challenge's content (title/description/impact area/client name/topics). Loads
// the impact-area list to pre-select; visibility/anonymity/namespace are intentionally not
// editable here.
function ChallengeEditForm({
  challenge,
  onDone,
  onSaved,
  onError,
}: {
  challenge: ChallengeDetail;
  onDone: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [impactAreas, setImpactAreas] = useState<{ id: string; name: string }[]>([]);
  const [title, setTitle] = useState(challenge.title);
  const [description, setDescription] = useState(challenge.description);
  const [impactAreaId, setImpactAreaId] = useState(challenge.impactAreaId);
  const [clientName, setClientName] = useState(challenge.clientName ?? "");
  // §34.3: topics are an editable field like impact area; the same picker as on submit.
  const [topics, setTopics] = useState<TopicTag[]>(challenge.topics ?? []);
  const topicOptions = useActiveTopics();
  const [submitting, setSubmitting] = useState(false);
  // §39.5: a save from a stale copy is refused; the form keeps the text so it can be copied.
  const [stale, setStale] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/impact-areas", { headers: { accept: "application/json" } })
      .then(readJson)
      .then((j) => setImpactAreas((j.impactAreas as { id: string; name: string }[]) ?? []))
      .catch(() => {});
  }, []);

  const isClient = impactAreas.find((a) => a.id === impactAreaId)?.name === "Client";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          impactAreaId,
          clientName: isClient ? clientName : null,
          topicIds: topics.map((t) => t.id),
          baseEditedAt: challenge.editedAt,
        }),
      });
      const json = await readJson(res);
      if (res.status === 409 && json.code === "stale_edit") {
        setStale((json.error as string) ?? "Someone else edited this since you opened it.");
        return;
      }
      if (!res.ok) throw new Error(json.error ?? "Could not save changes");
      onDone();
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save changes");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
      <label style={EDIT_LABEL}>Title</label>
      <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
      <label style={EDIT_LABEL}>Description</label>
      <textarea className="field" style={{ minHeight: 120, resize: "vertical" }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} required />
      <label style={EDIT_LABEL}>Impact area</label>
      <select className="field" value={impactAreaId} onChange={(e) => setImpactAreaId(e.target.value)} required>
        {impactAreas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      {((topicOptions?.length ?? 0) > 0 || topics.length > 0) && (
        <>
          <label style={EDIT_LABEL} htmlFor="challenge-edit-topics">
            Topics
          </label>
          <TopicPicker id="challenge-edit-topics" value={topics} onChange={setTopics} options={topicOptions} disabled={submitting} />
        </>
      )}
      {isClient && (
        <>
          <label style={EDIT_LABEL}>Client name</label>
          <input className="field" value={clientName} onChange={(e) => setClientName(e.target.value)} maxLength={200} required />
        </>
      )}
      {stale && (
        <StaleEditNotice
          message={stale}
          onReload={() => {
            onDone();
            onSaved();
          }}
        />
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || stale !== null}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// §10.1 author edit of a solution's content (description / cost vs benefits).
function SolutionEditForm({
  solution,
  onDone,
  onSaved,
  onError,
}: {
  solution: SolutionItem;
  onDone: () => void;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [description, setDescription] = useState(solution.description);
  const [costVsBenefits, setCostVsBenefits] = useState(solution.costVsBenefits ?? "");
  const [submitting, setSubmitting] = useState(false);
  // §39.5: a save from a stale copy is refused; the form keeps the text so it can be copied.
  const [stale, setStale] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`/api/solutions/${solution.number.replace("SOL-", "")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description, costVsBenefits: costVsBenefits || null, baseEditedAt: solution.editedAt }),
      });
      const json = await readJson(res);
      if (res.status === 409 && json.code === "stale_edit") {
        setStale((json.error as string) ?? "Someone else edited this since you opened it.");
        return;
      }
      if (!res.ok) throw new Error(json.error ?? "Could not save changes");
      onDone();
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save changes");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 10, alignSelf: "stretch" }}>
      <textarea className="field" style={{ minHeight: 90, resize: "vertical" }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} required />
      <textarea
        className="field"
        style={{ minHeight: 50, resize: "vertical" }}
        placeholder="Cost vs. benefits (optional)"
        value={costVsBenefits}
        onChange={(e) => setCostVsBenefits(e.target.value)}
        maxLength={5000}
      />
      {stale && (
        <StaleEditNotice
          message={stale}
          onReload={() => {
            onDone();
            onSaved();
          }}
        />
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || stale !== null}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// §39.5: the refused save's notice — the text stays in the form above it so it can be copied, and
// Reload closes the form and re-reads the item with the other person's changes.
function StaleEditNotice({ message, onReload }: { message: string; onReload: () => void }) {
  return (
    <div className="stale-edit" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn-sm" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}
