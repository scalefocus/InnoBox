"use client";
// /admin/feature-ideas — the §38.5 review page (INNOBOX_SPEC.md §38.5). Platform admins only (gated
// in-page against /api/me; every API call is gated server-side too). Three tabs:
//   Pending  — oldest first. Selecting a row opens the review panel with the full text and the four
//              decisions: Approve (a dialog for the published title, teaser and audience, pre-filled
//              from the text), Decline (an optional note to the proposer), Merge as duplicate (a live
//              Coming soon entry; one the proposer cannot see is disabled) and Delete as spam.
//   Planned  — the approved ideas by votes, with Edit (the same dialog) and Delete (with "Notify that
//              it shipped", ticked by default).
//   Decided  — declined and merged proposals of the last 90 days, newest first.
// The proposer is always named here, whatever their name switch says. While feature ideas are off
// the page stays readable under a note and every action is disabled (the API answers 409).
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AUDIENCE_LABEL,
  FEATURE_IDEA_MESSAGES,
  FEATURE_IDEA_NOTE_MAX,
  FEATURE_IDEA_TEASER_MAX,
  FEATURE_IDEA_TITLE_MAX,
  teaserPrefill,
  titlePrefill,
} from "@innobox/shared/feature-ideas";
import { UPCOMING_AUDIENCES, type UpcomingAudience } from "@innobox/shared/upcoming";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";
import { useDateFmt } from "@/components/DateFormat";
import { AvatarBubble } from "@/components/AvatarBubble";
import { cachedGet } from "@/lib/ui";
import { readJson } from "@/lib/api-client";

type Tab = "pending" | "planned" | "decided";

const TAB_LABEL: Record<Tab, string> = { pending: "Pending", planned: "Planned", decided: "Decided" };

interface Person {
  id: string;
  displayName: string;
  deactivated: boolean;
  scrubbed: boolean;
  named: boolean;
}

interface IdeaRow {
  id: string;
  status: "pending" | "planned" | "declined" | "merged";
  createdAt: string;
  description: string | null;
  excerpt: string;
  proposer: Person;
  proposerScope: UpcomingAudience | null;
  title: string | null;
  teaser: string | null;
  audience: UpcomingAudience | null;
  votes: number;
  decisionNote: string | null;
  mergedInto: string | null;
  mergedTitle: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

interface MergeTarget {
  id: string;
  kind: "spec" | "idea";
  title: string;
  audience: UpcomingAudience;
}

interface Copy {
  title: string;
  teaser: string;
  audience: UpcomingAudience;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 6,
};

/** True when an entry with `audience` reaches a person whose widest audience is `scope` (§38.5). */
function reaches(audience: UpcomingAudience, scope: UpcomingAudience | null): boolean {
  if (audience === "everyone") return true;
  if (audience === "admins") return scope === "admins" || scope === "platform_admin";
  return scope === "platform_admin";
}

export default function FeatureIdeasAdminPage() {
  const [gate, setGate] = useState<"loading" | "forbidden" | "ok">("loading");

  useEffect(() => {
    let live = true;
    cachedGet<{ roles: { platformAdmin: boolean } }>("/api/me")
      .then((me) => {
        if (live) setGate(me.roles.platformAdmin ? "ok" : "forbidden");
      })
      .catch(() => {
        if (live) setGate("forbidden");
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <div className="page-head reveal">
        {gate === "ok" && <Breadcrumb items={adminCrumbs("Feature ideas")} />}
        <h1 className="page-title">Feature ideas</h1>
        <p className="page-sub">
          Features people propose for InnoBox. An approved idea is planned: it joins Coming soon on <Link href="/whats-new">What&apos;s new</Link>, where
          everyone in its audience can upvote it.
        </p>
      </div>
      {gate === "loading" && <p className="muted">Loading…</p>}
      {gate === "forbidden" && (
        <div className="card card-pad empty reveal">
          <div className="ico">🔒</div>
          <p className="muted" style={{ margin: 0 }}>
            You need the platform admin role to view this page.
          </p>
        </div>
      )}
      {gate === "ok" && <Review />}
    </>
  );
}

function Review() {
  const fmt = useDateFmt();
  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState<IdeaRow[] | null>(null);
  const [targets, setTargets] = useState<MergeTarget[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3600);
  }, []);

  const load = useCallback(() => {
    fetch(`/api/admin/feature-ideas?tab=${tab}`, { headers: { accept: "application/json" } })
      .then(readJson)
      .then((json) => {
        setRows((json.ideas as IdeaRow[]) ?? []);
        setTargets((json.targets as MergeTarget[]) ?? []);
        setEnabled(json.enabled !== false);
      })
      .catch(() => notify("Could not load the ideas"));
  }, [tab, notify]);

  useEffect(() => load(), [load]);

  const switchTab = (t: Tab) => {
    if (t === tab) return;
    setRows(null);
    setSelected(null);
    setTab(t);
  };

  const onDone = (message: string) => {
    notify(message);
    setSelected(null);
    load();
  };

  return (
    <>
      {!enabled && (
        <div className="card card-pad" style={{ marginBottom: 14 }} role="status" data-testid="feature-ideas-off">
          <p className="muted" style={{ margin: 0 }}>
            {FEATURE_IDEA_MESSAGES.off}
          </p>
        </div>
      )}
      <div className="srctabs" style={{ marginBottom: 14 }} role="tablist" aria-label="Feature ideas">
        {(["pending", "planned", "decided"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "srctab active" : "srctab"} onClick={() => switchTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {rows === null && <p className="muted">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <div className="card card-pad empty">
          <p className="muted" style={{ margin: 0 }}>
            {tab === "pending" ? "Nothing is waiting for review." : tab === "planned" ? "No idea is planned yet." : "Nothing was decided in the last 90 days."}
          </p>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <div className="rows" data-testid="feature-idea-rows">
          {rows.map((r) => (
            <div key={r.id}>
              <button
                type="button"
                className="row"
                style={{ width: "100%", textAlign: "left", background: selected === r.id ? "var(--surface-2)" : "transparent", border: 0, borderBottom: "1px solid var(--line)", cursor: "pointer", font: "inherit", color: "inherit" }}
                aria-expanded={selected === r.id}
                onClick={() => setSelected((cur) => (cur === r.id ? null : r.id))}
              >
                <AvatarBubble size="sm" userId={r.proposer.scrubbed ? null : r.proposer.id} displayName={r.proposer.displayName} deactivated={r.proposer.deactivated} scrubbed={r.proposer.scrubbed} noCard />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ttl" style={{ overflowWrap: "anywhere" }}>
                    {tab === "pending" ? r.excerpt : r.title ?? r.excerpt}
                  </div>
                  <div className="sub" style={{ overflowWrap: "anywhere" }}>
                    {r.proposer.displayName}
                    {tab === "planned" && !r.proposer.named && " · name hidden on What's new"}
                    {tab === "planned" && r.audience && ` · ${AUDIENCE_LABEL[r.audience]}`}
                    {tab === "decided" && (r.status === "declined" ? " · declined" : ` · merged${r.mergedTitle ? ` into ${r.mergedTitle}` : ""}`)}
                    {tab === "decided" && r.decidedBy && ` by ${r.decidedBy}`}
                  </div>
                </div>
                {tab === "planned" && (
                  <span className="chip" aria-label={`${r.votes} upvotes`}>
                    ▲ {r.votes}
                  </span>
                )}
                <div className="sub mono" style={{ textAlign: "right", flexShrink: 0 }}>
                  {tab === "pending" ? fmt.dateTime(r.createdAt) : r.decidedAt ? fmt.date(r.decidedAt) : ""}
                </div>
              </button>
              {selected === r.id && (
                <IdeaPanel idea={r} tab={tab} targets={targets} enabled={enabled} onDone={onDone} onError={notify} />
              )}
            </div>
          ))}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function IdeaPanel({
  idea,
  tab,
  targets,
  enabled,
  onDone,
  onError,
}: {
  idea: IdeaRow;
  tab: Tab;
  targets: MergeTarget[];
  enabled: boolean;
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "approve" | "edit" | "decline" | "merge" | "delete">("none");
  const [note, setNote] = useState("");
  const [target, setTarget] = useState("");

  const call = async (method: "POST" | "PATCH" | "DELETE", path: string, body: Record<string, unknown> | null, success: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/feature-ideas/${idea.id}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "The action failed");
      onDone(success);
    } catch (err) {
      onError(err instanceof Error ? err.message : "The action failed");
    } finally {
      setBusy(false);
    }
  };

  const text = idea.description ?? "";
  const prefill: Copy =
    tab === "planned" && idea.title && idea.teaser && idea.audience
      ? { title: idea.title, teaser: idea.teaser, audience: idea.audience }
      : { title: titlePrefill(text), teaser: teaserPrefill(text), audience: "everyone" };
  const disabled = busy || !enabled;

  return (
    <div className="card-pad" data-testid="feature-idea-review" style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
      {tab === "planned" && idea.title && (
        <>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: "0 0 4px", overflowWrap: "anywhere" }}>{idea.title}</h3>
          <p style={{ margin: "0 0 12px", fontSize: 14.5, lineHeight: 1.6 }}>{idea.teaser}</p>
          <div style={labelStyle}>The original idea</div>
        </>
      )}
      {text ? (
        <p style={{ whiteSpace: "pre-wrap", fontSize: 14.5, lineHeight: 1.65, overflowWrap: "anywhere" }}>{text}</p>
      ) : (
        <p className="muted">The original text was removed with its author&apos;s account.</p>
      )}
      <p className="sub" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <AvatarBubble size="sm" userId={idea.proposer.scrubbed ? null : idea.proposer.id} displayName={idea.proposer.displayName} deactivated={idea.proposer.deactivated} scrubbed={idea.proposer.scrubbed} />
        {idea.proposer.displayName} · sent {fmt.dateTime(idea.createdAt)}
        {idea.status === "declined" && idea.decisionNote && <> · Note sent: {idea.decisionNote}</>}
      </p>

      {tab === "pending" && mode === "none" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm btn-primary" disabled={disabled} onClick={() => setMode("approve")}>
            Approve…
          </button>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setMode("decline")}>
            Decline…
          </button>
          <button type="button" className="btn btn-sm" disabled={disabled || targets.length === 0} onClick={() => setMode("merge")}>
            Merge as duplicate…
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={disabled}
            onClick={() => {
              if (!window.confirm("Delete this idea as spam? It is deleted at once and nothing is sent.")) return;
              void call("DELETE", "", null, "Idea deleted.");
            }}
          >
            Delete as spam
          </button>
        </div>
      )}

      {tab === "planned" && mode === "none" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setMode("edit")}>
            Edit…
          </button>
          <button type="button" className="btn btn-sm btn-danger" disabled={disabled} onClick={() => setMode("delete")}>
            Delete…
          </button>
        </div>
      )}

      {mode === "decline" && (
        <div>
          <label style={labelStyle} htmlFor="idea-decline-note">
            Note to the person who proposed it (optional)
          </label>
          <textarea
            id="idea-decline-note"
            className="field"
            style={{ width: "100%", minHeight: 90, resize: "vertical" }}
            value={note}
            maxLength={FEATURE_IDEA_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={disabled} onClick={() => void call("POST", "/decline", { note: note.trim() || null }, "Idea declined.")}>
              Decline and notify
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMode("none")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "merge" && (
        <div>
          <label style={labelStyle} htmlFor="idea-merge-target">
            Already planned as
          </label>
          <select id="idea-merge-target" className="field" style={{ width: "100%" }} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose an entry…</option>
            {targets.map((t) => {
              const visible = reaches(t.audience, idea.proposerScope);
              return (
                <option key={t.id} value={t.id} disabled={!visible}>
                  {t.title}
                  {visible ? "" : ` — ${FEATURE_IDEA_MESSAGES.notVisibleToProposer}`}
                </option>
              );
            })}
          </select>
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
            Their upvote moves to that entry, and they are told it is already planned.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={disabled || !target} onClick={() => void call("POST", "/merge", { entry: target }, "Idea merged.")}>
              Merge and notify
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMode("none")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {(mode === "approve" || mode === "edit") && (
        <CopyDialog
          heading={mode === "approve" ? "Approve as planned" : "Edit the planned idea"}
          submitLabel={mode === "approve" ? "Approve" : "Save"}
          initial={prefill}
          busy={busy}
          onCancel={() => setMode("none")}
          onSubmit={(copy) =>
            mode === "approve" ? call("POST", "/approve", { ...copy }, "Idea approved — it is now in Coming soon.") : call("PATCH", "", { ...copy }, "Idea saved.")
          }
        />
      )}

      {mode === "delete" && <DeletePlannedDialog votes={idea.votes} busy={busy} onCancel={() => setMode("none")} onDelete={(notifyShipped) => call("DELETE", "", { notifyShipped }, "Idea deleted.")} />}
    </div>
  );
}

/** §38.5: the published title, teaser and audience — for Approve (pre-filled from the text) and Edit. */
function CopyDialog({
  heading,
  submitLabel,
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  heading: string;
  submitLabel: string;
  initial: Copy;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (copy: Copy) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copy, setCopy] = useState<Copy>(initial);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const ready = copy.title.trim() !== "" && copy.teaser.trim() !== "";
  return (
    <dialog ref={ref} className="author-reveal-dialog" style={{ width: "min(560px, calc(100vw - 32px))" }} aria-labelledby="idea-copy-title" onClose={onCancel}>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 14, padding: "22px 22px 20px" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) void onSubmit(copy);
        }}
      >
        <h2 id="idea-copy-title" style={{ fontFamily: "var(--font-display)", fontSize: 20, margin: 0 }}>
          {heading}
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          This is shown to everyone in the audience. Don&apos;t name people, challenges or teams, and don&apos;t promise a date.
        </p>
        <div>
          <label style={labelStyle} htmlFor="idea-copy-title-field">
            Title
          </label>
          <input
            id="idea-copy-title-field"
            className="field"
            style={{ width: "100%" }}
            value={copy.title}
            maxLength={FEATURE_IDEA_TITLE_MAX}
            onChange={(e) => setCopy({ ...copy, title: e.target.value })}
            required
          />
          <div className="sub mono" style={{ textAlign: "right" }}>
            {copy.title.length} / {FEATURE_IDEA_TITLE_MAX}
          </div>
        </div>
        <div>
          <label style={labelStyle} htmlFor="idea-copy-teaser">
            Teaser
          </label>
          <textarea
            id="idea-copy-teaser"
            className="field"
            style={{ width: "100%", minHeight: 100, resize: "vertical" }}
            value={copy.teaser}
            maxLength={FEATURE_IDEA_TEASER_MAX}
            onChange={(e) => setCopy({ ...copy, teaser: e.target.value })}
            required
          />
          <div className="sub mono" style={{ textAlign: "right" }}>
            {copy.teaser.length} / {FEATURE_IDEA_TEASER_MAX}
          </div>
        </div>
        <div>
          <label style={labelStyle} htmlFor="idea-copy-audience">
            Audience
          </label>
          <select id="idea-copy-audience" className="field" style={{ width: "100%" }} value={copy.audience} onChange={(e) => setCopy({ ...copy, audience: e.target.value as UpcomingAudience })}>
            {UPCOMING_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABEL[a]}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !ready}>
            {submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** §38.5: deleting a planned idea — "Notify that it shipped", ticked by default; unticked is silent. */
function DeletePlannedDialog({ votes, busy, onCancel, onDelete }: { votes: number; busy: boolean; onCancel: () => void; onDelete: (notifyShipped: boolean) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [notifyShipped, setNotifyShipped] = useState(true);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog ref={ref} className="author-reveal-dialog" style={{ width: "min(460px, calc(100vw - 32px))" }} aria-labelledby="idea-delete-title" onClose={onCancel}>
      <form
        style={{ display: "flex", flexDirection: "column", gap: 14, padding: "22px 22px 20px" }}
        onSubmit={(e) => {
          e.preventDefault();
          void onDelete(notifyShipped);
        }}
      >
        <h2 id="idea-delete-title" style={{ fontFamily: "var(--font-display)", fontSize: 20, margin: 0 }}>
          Delete this planned idea?
        </h2>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
          <input type="checkbox" checked={notifyShipped} onChange={(e) => setNotifyShipped(e.target.checked)} data-testid="idea-notify-shipped" />
          <span>
            <strong>Notify that it shipped</strong>
            <span className="muted" style={{ display: "block", fontSize: 13 }}>
              The person who proposed it and the {votes} {votes === 1 ? "person" : "people"} who upvoted it get a &lsquo;now available&rsquo; notification.
            </span>
          </span>
        </label>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-danger" disabled={busy}>
            Delete
          </button>
        </div>
      </form>
    </dialog>
  );
}
