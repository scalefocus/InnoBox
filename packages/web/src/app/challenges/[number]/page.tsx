"use client";
// Challenge detail page (INNOBOX_SPEC.md §13.1 + Phase 3): full fields, inline solutions
// list, propose-a-solution (§6.2), like/follow toggles, comments (§10.2), the admin
// status-override control (§7.2/§8.2), assignment (§7.3), anonymity reveal (§9,
// admin transient + author self-reveal), and the platform-admin danger zone (§10.3).
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { readJson } from "@/lib/api-client";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL, statusPillClass } from "../status";
import { CommentThread } from "@/components/CommentThread";
import { AvatarBubble } from "@/components/AvatarBubble";
import { UserResultButton } from "@/components/UserResultButton";
import { StagedAttachments } from "@/components/StagedAttachments";
import { uploadFileInChunks } from "@/lib/chunked-upload";
import { FormLockOverlay, PrimaryButtonLabel, useFormLock } from "@/components/FormLock";
import { primaryButtonState } from "@/lib/form-lock";
import { FeatureOnHomeControl } from "@/components/FeatureOnHomeControl";

interface MaskedAuthor {
  userId: string | null;
  displayName: string;
  anonymous: boolean;
  active?: boolean;
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

interface SolutionItem {
  id: string;
  number: string;
  description: string;
  costVsBenefits: string | null;
  author: MaskedAuthor;
  isMine: boolean;
  status: string;
  createdAt: string;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  canOverrideStatus: boolean;
  allowedTransitions: string[];
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  canDelete: boolean;
  attachments: AttachmentItem[];
}

interface ChallengeDetail {
  id: string;
  number: string;
  title: string;
  description: string;
  author: MaskedAuthor;
  namespaceSlug: string;
  namespaceId: string;
  impactAreaName: string;
  clientName: string | null;
  visibility: "org" | "namespace";
  status: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  resolvedAt: string | null;
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  assigneeActive?: boolean | null;
  likeCount: number;
  likedByViewer: boolean;
  followedByViewer: boolean;
  solutionCount: number;
  isMine: boolean;
  canPropose: boolean;
  canOverrideStatus: boolean;
  allowedTransitions: string[];
  canEdit: boolean;
  canWithdraw: boolean;
  canResubmit: boolean;
  canDelete: boolean;
  /** §13.2 Home pin: `featured` for everyone; the control + provenance only via `canFeature`. */
  featured: boolean;
  canFeature: boolean;
  featuredBy?: string;
  featuredAt?: string;
  impactAreaId: string;
  solutions: SolutionItem[];
  attachments: AttachmentItem[];
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
  const [revealed, setRevealed] = useState<{ displayName: string; email: string | null; userId: string | null } | null>(null);
  const [assigneeQuery, setAssigneeQuery] = useState("");
  const [assigneeResults, setAssigneeResults] = useState<{ id: string; displayName: string; email: string | null }[]>([]);

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
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not update like");
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
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not update follow");
    } finally {
      setBusy(false);
    }
  };

  // Serves both modes: an admin free-set (override) and a committee/assignee enforced
  // transition (§7.2) — the endpoint decides which from the caller's role.
  const changeChallengeStatus = async (status: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not change status");
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change status");
    } finally {
      setBusy(false);
    }
  };

  const changeVisibility = async (visibility: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}/visibility`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not change visibility");
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change visibility");
    } finally {
      setBusy(false);
    }
  };

  const changeSolutionStatus = async (solutionNumber: string, status: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/solutions/${solutionNumber.replace("SOL-", "")}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not change status");
      onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not change status");
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}/reveal`, { method: "POST" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not reveal author");
      setRevealed({ displayName: json.displayName as string, email: (json.email as string) ?? null, userId: (json.userId as string) ?? null });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not reveal author");
    } finally {
      setBusy(false);
    }
  };

  const selfReveal = async () => {
    if (!window.confirm("This permanently removes your anonymity on this challenge. Continue?")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challenge.number.replace("CH-", "")}/self-reveal`, { method: "POST" });
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
    const res = await fetch(`/api/users?q=${encodeURIComponent(q)}`);
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
  // page entirely, while a solution delete just re-reads the challenge.
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
      if (after === "leave") router.push("/challenges");
      else onChanged();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete");
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
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const canReveal = challenge.canOverrideStatus && challenge.author.anonymous;
  const canSelfReveal = challenge.isMine && challenge.author.anonymous;

  return (
    <>
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
          <span className="chip">{challenge.visibility === "org" ? "Organization-wide" : "Namespace-only"}</span>
        </div>
      </div>

      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <div className="row" style={{ border: 0, padding: 0, marginBottom: 16 }}>
          <AvatarBubble
            size="md"
            userId={revealed ? revealed.userId : challenge.author.userId}
            displayName={revealed ? revealed.displayName : challenge.author.displayName}
            anonymous={!revealed && challenge.author.anonymous}
            deactivated={!revealed && challenge.author.active === false}
            /* noCard (§13.8): the reveal surface stays untouched — it already names the person, and
               the audited reveal (§9) is the one place anonymity is deliberately lifted. */
            noCard={Boolean(revealed)}
          />
          <div className="grow">
            <div className="ttl">
              {revealed ? (
                <>
                  {revealed.displayName} <span className="pill pill-accent">Revealed to you only</span>
                </>
              ) : challenge.author.anonymous ? (
                "Anonymous"
              ) : (
                challenge.author.displayName
              )}
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
                />{" "}
                {challenge.assigneeDisplayName}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => toggleFollow("challenge", challenge.id)}>
            {challenge.followedByViewer ? "Following" : "Follow"}
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => toggleLike("challenge", challenge.id)}>
            {challenge.likedByViewer ? "♥" : "♡"} {challenge.likeCount}
          </button>
        </div>
        <p style={{ whiteSpace: "pre-wrap", fontSize: 14.5, lineHeight: 1.65 }}>{challenge.description}</p>

        {(canReveal || canSelfReveal) && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {canReveal && !revealed && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={reveal}>
                Reveal author
              </button>
            )}
            {canSelfReveal && (
              <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={selfReveal}>
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

        <AttachmentsSection
          parentType="challenge"
          parentId={challenge.id}
          attachments={challenge.attachments}
          canUpload={challenge.canEdit}
          busy={busy}
          onChanged={onChanged}
          onError={notify}
        />

        {!challenge.canOverrideStatus && challenge.allowedTransitions.length > 0 && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
            <label style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8, display: "block" }}>
              Move status
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {challenge.allowedTransitions.map((s) => (
                <button key={s} type="button" className="btn btn-sm" disabled={busy} onClick={() => changeChallengeStatus(s)}>
                  → {CHALLENGE_STATUS_LABEL[s] ?? s}
                </button>
              ))}
            </div>
          </div>
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
              {Object.keys(CHALLENGE_STATUS_LABEL).map((s) => (
                <option key={s} value={s}>
                  {CHALLENGE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>

            <div style={{ marginTop: 14 }}>
              <label style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8, display: "block" }}>
                Visibility
              </label>
              <select className="field" value={challenge.visibility} disabled={busy} onChange={(e) => changeVisibility(e.target.value)}>
                <option value="org">Organization-wide</option>
                <option value="namespace">Namespace-only</option>
              </select>
            </div>

            <div style={{ marginTop: 14, position: "relative" }}>
              <label style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8, display: "block" }}>
                Assignee
              </label>
              <input
                className="field"
                placeholder="Search users by name or email…"
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

        {challenge.canDelete && (
          <DangerZone
            label={challenge.number}
            what={`${challenge.number}, every solution on it, and all comments, likes, follows, and files attached to any of them`}
            busy={busy}
            onDelete={(reason) => deletePermanently(`/api/challenges/${chNum}`, reason, "leave")}
          />
        )}
      </div>

      {challenge.canPropose && <ProposeSolutionForm challengeNumber={challenge.number} onProposed={onChanged} />}

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 21, margin: "26px 0 14px" }}>
        Solutions {challenge.solutions.length > 0 && `(${challenge.solutions.length})`}
      </h2>

      {challenge.solutions.length === 0 && <p className="muted">No solutions yet.</p>}

      {challenge.solutions.length > 0 && (
        <div className="rows" style={{ marginBottom: 26 }}>
          {challenge.solutions.map((s) => (
            <div className="row" key={s.id} id={s.number} style={{ flexDirection: "column", alignItems: "stretch", gap: 10, scrollMarginTop: 80 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span className="chip mono">{s.number}</span>
                <span className={statusPillClass(s.status)}>{SOLUTION_STATUS_LABEL[s.status] ?? s.status}</span>
                <AvatarBubble size="sm" userId={s.author.userId} displayName={s.author.displayName} anonymous={s.author.anonymous} deactivated={s.author.active === false} />
                <span className="sub" style={{ flex: 1 }}>
                  {s.author.anonymous ? "Anonymous" : s.author.displayName} · {fmt.date(s.createdAt)}
                </span>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => toggleFollow("solution", s.id)}>
                  {s.followedByViewer ? "Following" : "Follow"}
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => toggleLike("solution", s.id)}>
                  {s.likedByViewer ? "♥" : "♡"} {s.likeCount}
                </button>
              </div>
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
                    <button key={st} type="button" className="btn btn-sm" disabled={busy} onClick={() => changeSolutionStatus(s.number, st)}>
                      → {SOLUTION_STATUS_LABEL[st] ?? st}
                    </button>
                  ))}
                </div>
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
              {s.canDelete && (
                <DangerZone
                  label={s.number}
                  what={`${s.number} and all comments, likes, follows, and files attached to it`}
                  note={
                    s.status === "implemented" && challenge.status === "solved"
                      ? "This challenge was solved by this solution, so it returns to “Valid — open for solutions”. Other solutions stay closed."
                      : undefined
                  }
                  busy={busy}
                  onDelete={(reason) => deletePermanently(`/api/solutions/${s.number.replace("SOL-", "")}`, reason, "refresh")}
                />
              )}
              <AttachmentsSection
                parentType="solution"
                parentId={s.id}
                attachments={s.attachments}
                canUpload={s.canEdit}
                busy={busy}
                onChanged={onChanged}
                onError={notify}
              />
              <CommentThread parentType="solution" parentId={s.id} authoredAnonymously={s.isMine && s.author.anonymous} />
            </div>
          ))}
        </div>
      )}

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 21, margin: "26px 0 14px" }}>Discussion</h2>
      <CommentThread parentType="challenge" parentId={challenge.id} authoredAnonymously={challenge.isMine && challenge.author.anonymous} />

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

/**
 * §10.3 danger zone — the platform-admin permanent delete, on the challenge and on each
 * solution. Deliberate friction: the admin must type the item's own number back AND give a
 * reason before the button arms, because there is no undo, no trash, and no notification —
 * once this returns, the item and everything under it are gone.
 */
function DangerZone({
  label,
  what,
  note,
  busy,
  onDelete,
}: {
  label: string;
  what: string;
  note?: string;
  busy: boolean;
  onDelete: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const armed = typed.trim().toUpperCase() === label.toUpperCase() && reason.trim() !== "";

  const close = () => {
    setOpen(false);
    setTyped("");
    setReason("");
  };

  if (!open) {
    return (
      <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setOpen(true)}>
          Delete {label} permanently
        </button>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-label={`Delete ${label} permanently`}
      style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}
    >
      <p style={{ fontSize: 14, margin: "0 0 6px", fontWeight: 600 }}>Delete {label} permanently?</p>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
        This removes {what}. It cannot be undone — there is no restore, and nobody is notified.
      </p>
      {note && (
        <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
          {note}
        </p>
      )}
      <label htmlFor={`del-confirm-${label}`} className="sub" style={{ display: "block", marginTop: 10, marginBottom: 4 }}>
        Type {label} to confirm
      </label>
      <input
        id={`del-confirm-${label}`}
        className="field"
        style={{ maxWidth: 220 }}
        autoComplete="off"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <label htmlFor={`del-reason-${label}`} className="sub" style={{ display: "block", marginTop: 10, marginBottom: 4 }}>
        Reason (required — kept in the audit trail)
      </label>
      <textarea
        id={`del-reason-${label}`}
        className="field"
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={busy || !armed}
          onClick={async () => {
            await onDelete(reason.trim());
            close();
          }}
        >
          Delete permanently
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
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
// re-read AND re-rendered, and only then closes.
function ProposeSolutionForm({ challengeNumber, onProposed }: { challengeNumber: string; onProposed: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [costVsBenefits, setCostVsBenefits] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [draftKey] = useState(() => crypto.randomUUID());
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const lock = useFormLock();
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn btn-primary" style={{ marginBottom: 18 }} onClick={() => setOpen(true)}>
        Propose a solution
      </button>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A second submit (double click, Enter) while locked is a no-op.
    if (!lock.lock()) return;
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${challengeNumber.replace("CH-", "")}/solutions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description, costVsBenefits: costVsBenefits || null, isAnonymous, draftKey }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not propose solution");
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
    setOpen(false);
    lock.reset();
  };

  const button = primaryButtonState({ locked: lock.locked, attachmentsBusy, idleLabel: "Submit solution" });

  return (
    <form
      onSubmit={onSubmit}
      className="card card-pad reveal form-lock"
      aria-busy={lock.locked}
      style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 18 }}
    >
      <div className="form-lock-body" inert={lock.locked}>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: 0 }}>Propose a solution</h3>
        <textarea
          className="field"
          style={{ minHeight: 100, resize: "vertical" }}
          placeholder="Describe your solution"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={10000}
          required
        />
        <textarea
          className="field"
          style={{ minHeight: 60, resize: "vertical" }}
          placeholder="Cost vs. benefits (optional)"
          value={costVsBenefits}
          onChange={(e) => setCostVsBenefits(e.target.value)}
          maxLength={5000}
        />
        <StagedAttachments parentType="solution" draftKey={draftKey} disabled={lock.locked} onBusyChange={setAttachmentsBusy} />
        <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14 }}>
          <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} />
          Submit anonymously
        </label>
        {error && (
          <p className="muted" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn-primary form-lock-raised" disabled={button.disabled}>
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

// The client-side mirror of the §11 allowlist, for the file-input `accept` hint (the server is
// authoritative). Kept as a literal so this client component doesn't import the shared barrel.
const ATTACHMENT_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.rtf,.txt,.csv,.md,.png,.jpg,.jpeg,.gif,.webp,.zip";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// §11 Attachments section for a challenge or a solution: a list with per-status affordances
// (download link for clean; "Scanning…" / "Removed — failed scan" / "Removed — couldn't be
// scanned" for the uploader's pending/infected/unscannable), an upload control shown only within
// the author-edit window (canUpload), and a Remove button on the uploader's own attachments while
// still editable (a failed one included, so its slot can be freed for another file).
function AttachmentsSection({
  parentType,
  parentId,
  attachments,
  canUpload,
  busy,
  onChanged,
  onError,
}: {
  parentType: "challenge" | "solution";
  parentId: string;
  attachments: AttachmentItem[];
  canUpload: boolean;
  busy: boolean;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [active, setActive] = useState<{ mode: "chunked" | "single"; progress: number } | null>(null);
  const [config, setConfig] = useState<{ chunkSizeBytes: number; maxUploadSizeMb: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/attachments/config", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (j) setConfig({ chunkSizeBytes: j.chunkSizeMb * 1024 * 1024, maxUploadSizeMb: j.maxUploadSizeMb });
      })
      .catch(() => {});
  }, []);

  const upload = async (file: File) => {
    const chunkSizeBytes = config?.chunkSizeBytes ?? 5 * 1024 * 1024;
    if (config && file.size > config.maxUploadSizeMb * 1024 * 1024) {
      onError(`That file exceeds the ${config.maxUploadSizeMb} MB limit.`);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const chunked = file.size > chunkSizeBytes;
    setUploading(true);
    setActive({ mode: chunked ? "chunked" : "single", progress: 0 });
    try {
      // §11: files larger than the chunk size upload chunk-by-chunk (progress bar); smaller
      // files go in one request (spinner). Both then scan on-demand before becoming downloadable.
      if (chunked) {
        await uploadFileInChunks(file, { parentType, parentId }, (up, total) =>
          setActive((a) => (a ? { ...a, progress: total ? up / total : 0 } : a)),
        );
      } else {
        const form = new FormData();
        form.append("parentType", parentType);
        form.append("parentId", parentId);
        form.append("file", file);
        const res = await fetch("/api/attachments", { method: "POST", body: form });
        const json = await readJson(res);
        if (!res.ok) throw new Error(json.error ?? "Could not upload attachment");
      }
      if (fileRef.current) fileRef.current.value = "";
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not upload attachment");
    } finally {
      setUploading(false);
      setActive(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Remove this attachment? This is permanent.")) return;
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not remove attachment");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove attachment");
    }
  };

  if (attachments.length === 0 && !canUpload) return null;

  return (
    <div style={{ marginTop: 14 }}>
      <label style={{ ...EDIT_LABEL, display: "block", marginBottom: 8 }}>Attachments</label>
      {attachments.length === 0 ? (
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 13 }}>No attachments yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {attachments.map((a) => (
            <li key={a.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {a.status === "clean" ? (
                <a href={`/api/attachments/${a.id}`} style={{ color: "var(--accent)", textDecoration: "underline", fontSize: 14 }}>
                  {a.filename}
                </a>
              ) : (
                <span style={{ fontSize: 14 }}>{a.filename}</span>
              )}
              <span className="mono muted" style={{ fontSize: 12 }}>
                {formatBytes(a.sizeBytes)}
              </span>
              {a.status === "pending" && <span className="chip">Scanning…</span>}
              {a.status === "infected" && <span className="pill pill-danger">Removed — failed scan</span>}
              {a.status === "unscannable" && <span className="pill pill-danger">Removed — couldn&apos;t be scanned</span>}
              {canUpload && a.isUploader && (
                <button type="button" className="btn btn-sm btn-danger" disabled={busy || uploading} onClick={() => remove(a.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            ref={fileRef}
            type="file"
            className="field"
            style={{ maxWidth: 340 }}
            disabled={uploading || busy}
            accept={ATTACHMENT_ACCEPT}
            aria-label="Upload an attachment"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          {active?.mode === "chunked" ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span style={{ display: "inline-block", width: 120, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${Math.round(active.progress * 100)}%`, background: "var(--accent)", transition: "width 120ms linear" }} />
              </span>
              <span className="mono muted" style={{ fontSize: 12 }}>
                Uploading… {Math.round(active.progress * 100)}%
              </span>
            </span>
          ) : (
            uploading && (
              <span className="muted" style={{ fontSize: 13 }}>
                Uploading…
              </span>
            )
          )}
        </div>
      )}
    </div>
  );
}

// §10.1 author edit of a challenge's content (title/description/impact area/client name). Loads
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
  const [submitting, setSubmitting] = useState(false);

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
        body: JSON.stringify({ title, description, impactAreaId, clientName: isClient ? clientName : null }),
      });
      const json = await readJson(res);
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
      {isClient && (
        <>
          <label style={EDIT_LABEL}>Client name</label>
          <input className="field" value={clientName} onChange={(e) => setClientName(e.target.value)} maxLength={200} required />
        </>
      )}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
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

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch(`/api/solutions/${solution.number.replace("SOL-", "")}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description, costVsBenefits: costVsBenefits || null }),
      });
      const json = await readJson(res);
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
      <div style={{ display: "flex", gap: 10 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
