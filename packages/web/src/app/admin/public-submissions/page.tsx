"use client";
// /admin/public-submissions — the §24.5 review queue (INNOBOX_SPEC.md §24.5–§24.8). Platform admins
// only (gated in-page against /api/me; every API call is gated server-side too). Two tabs: Pending
// review (oldest first) and Decided (the last 90 days, newest first). Selecting a row opens the
// review panel: the full text, the contact details, the §6.1 similar challenges, and the three
// decisions — Accept (a dialog choosing namespace, visibility and impact area, with the title and
// description editable before they reach every employee), Decline (an optional note mailed to the
// submitter) and Discard as spam (deletes the row, sends nothing). A row someone else decided first
// answers 409, shown as is. Erase contact details works on any row.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DECLINE_NOTE_MAX, PUBLIC_DESCRIPTION_MAX, PUBLIC_TITLE_MAX } from "@innobox/shared/public-intake";
import { Breadcrumb, adminCrumbs } from "@/components/Breadcrumb";
import { useDateFmt } from "@/components/DateFormat";
import { AvatarBubble } from "@/components/AvatarBubble";
import { cachedGet } from "@/lib/ui";
import { readJson } from "@/lib/api-client";
import { CHALLENGE_STATUS_LABEL } from "../../challenges/status";

type Tab = "pending" | "decided";

interface SubmissionRow {
  id: string;
  status: "pending_review" | "accepted" | "declined";
  title: string;
  company: string | null;
  name: string | null;
  email: string | null;
  confirmedAt: string | null;
  decidedAt: string | null;
  contactErasedAt: string | null;
  challengeNumber: string | null;
}

interface SimilarMatch {
  number: string;
  title: string;
  status: string;
  author: { userId: string | null; displayName: string; anonymous: boolean; external?: boolean };
}

interface SubmissionDetail extends SubmissionRow {
  description: string;
  declineNote: string | null;
  similar: SimilarMatch[];
}

interface NamespaceOption {
  id: string;
  slug: string;
  displayName: string;
  archivedAt: string | null;
}

interface ImpactArea {
  id: string;
  name: string;
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

export default function PublicSubmissionsPage() {
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
        {gate === "ok" && <Breadcrumb items={adminCrumbs("Public submissions")} />}
        <h1 className="page-title">Public submissions</h1>
        <p className="page-sub">Challenges sent from outside the organization through the public form. Nothing here reaches the challenge list until you accept it.</p>
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
      {gate === "ok" && <Queue />}
    </>
  );
}

function Queue() {
  const fmt = useDateFmt();
  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState<SubmissionRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3600);
  }, []);

  const load = useCallback(() => {
    fetch(`/api/admin/public-submissions?status=${tab}`, { headers: { accept: "application/json" } })
      .then(readJson)
      .then((json) => setRows((json.submissions as SubmissionRow[]) ?? []))
      .catch(() => notify("Could not load the queue"));
  }, [tab, notify]);

  useEffect(() => load(), [load]);

  const switchTab = (t: Tab) => {
    if (t === tab) return;
    setRows(null);
    setSelected(null);
    setTab(t);
  };

  const onDecided = (message: string) => {
    notify(message);
    setSelected(null);
    load();
  };

  return (
    <>
      <div className="srctabs" style={{ marginBottom: 14 }} role="tablist" aria-label="Queue">
        {(["pending", "decided"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "srctab active" : "srctab"} onClick={() => switchTab(t)}>
            {t === "pending" ? "Pending review" : "Decided"}
          </button>
        ))}
      </div>

      {rows === null && <p className="muted">Loading…</p>}
      {rows !== null && rows.length === 0 && (
        <div className="card card-pad empty">
          <p className="muted" style={{ margin: 0 }}>
            {tab === "pending" ? "Nothing is waiting for review." : "Nothing was decided in the last 90 days."}
          </p>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <div className="rows" data-testid="public-submission-rows">
          {rows.map((r) => (
            <div key={r.id}>
              <button
                type="button"
                className="row"
                style={{ width: "100%", textAlign: "left", background: selected === r.id ? "var(--surface-2)" : "transparent", border: 0, borderBottom: "1px solid var(--line)", cursor: "pointer", font: "inherit", color: "inherit" }}
                aria-expanded={selected === r.id}
                onClick={() => setSelected((cur) => (cur === r.id ? null : r.id))}
              >
                <div className="grow">
                  <div className="ttl" style={{ overflowWrap: "anywhere" }}>
                    {r.title}
                  </div>
                  <div className="sub" style={{ overflowWrap: "anywhere" }}>
                    {[r.company, r.contactErasedAt ? "contact details erased" : r.name, r.contactErasedAt ? null : r.email].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="sub mono" style={{ textAlign: "right", flexShrink: 0 }}>
                  {tab === "pending" ? (r.confirmedAt ? fmt.dateTime(r.confirmedAt) : "") : r.decidedAt ? fmt.date(r.decidedAt) : ""}
                  {tab === "decided" && (
                    <div>
                      {r.status === "accepted" ? (r.challengeNumber ? `accepted · ${r.challengeNumber}` : "accepted") : "declined"}
                    </div>
                  )}
                </div>
              </button>
              {selected === r.id && <ReviewPanel id={r.id} onDecided={onDecided} onError={notify} onChanged={load} />}
            </div>
          ))}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function ReviewPanel({ id, onDecided, onError, onChanged }: { id: string; onDecided: (m: string) => void; onError: (m: string) => void; onChanged: () => void }) {
  const fmt = useDateFmt();
  const [detail, setDetail] = useState<SubmissionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"none" | "accept" | "decline">("none");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    fetch(`/api/admin/public-submissions/${id}`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        const json = await readJson(res);
        if (!res.ok) throw new Error(json.error ?? "Could not load the submission");
        setDetail(json.submission as SubmissionDetail);
      })
      .catch((err) => onError(err instanceof Error ? err.message : "Could not load the submission"));
  }, [id, onError]);

  useEffect(() => load(), [load]);

  const post = async (path: string, body: Record<string, unknown> | null, success: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/public-submissions/${id}/${path}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "The action failed");
      return { ok: true as const, json, success };
    } catch (err) {
      onError(err instanceof Error ? err.message : "The action failed");
      return { ok: false as const };
    } finally {
      setBusy(false);
    }
  };

  if (!detail) return <div className="card-pad muted">Loading…</div>;
  const pending = detail.status === "pending_review";

  return (
    <div className="card-pad" data-testid="public-submission-review" style={{ borderBottom: "1px solid var(--line)", background: "var(--surface)" }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 18, margin: "0 0 8px", overflowWrap: "anywhere" }}>{detail.title}</h3>
      <p style={{ whiteSpace: "pre-wrap", fontSize: 14.5, lineHeight: 1.65, overflowWrap: "anywhere" }}>{detail.description}</p>

      <div className="card card-pad" style={{ background: "var(--surface-2)", marginBottom: 14 }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          Contact
        </div>
        {detail.contactErasedAt ? (
          <p className="muted" style={{ margin: 0 }}>
            Contact details erased on {fmt.date(detail.contactErasedAt)}.{detail.company ? ` Company: ${detail.company}.` : ""}
          </p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ttl">{detail.name}</div>
              <div className="sub mono" style={{ overflowWrap: "anywhere" }}>
                {detail.email}
                {detail.company && ` · ${detail.company}`}
                {detail.confirmedAt && ` · confirmed ${fmt.dateTime(detail.confirmedAt)}`}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Erase the submitter's name and e-mail? They can't be recovered, and no further e-mail will be sent to them.")) return;
                const r = await post("erase-contact", null, "Contact details erased.");
                if (r.ok) {
                  load();
                  onChanged();
                }
              }}
            >
              Erase contact details
            </button>
          </div>
        )}
      </div>

      {detail.status === "declined" && detail.declineNote && (
        <p className="sub" style={{ marginBottom: 14 }}>
          Note sent with the decline: {detail.declineNote}
        </p>
      )}
      {detail.status === "accepted" && detail.challengeNumber && (
        <p style={{ marginBottom: 14 }}>
          Accepted as <Link href={`/challenges/${detail.challengeNumber.replace("CH-", "")}`}>{detail.challengeNumber}</Link>.
        </p>
      )}

      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>Similar challenges</div>
        {detail.similar.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            No similar challenges found.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
            {detail.similar.map((m) => (
              <li key={m.number}>
                <Link href={`/challenges/${m.number.replace("CH-", "")}`} target="_blank" rel="noopener noreferrer">
                  <span className="mono">{m.number}</span> {m.title}
                </Link>{" "}
                <span className="sub" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  · {CHALLENGE_STATUS_LABEL[m.status] ?? m.status} ·{" "}
                  <AvatarBubble size="sm" userId={m.author.userId} displayName={m.author.displayName} anonymous={m.author.anonymous} external={m.author.external === true} />
                  {m.author.anonymous ? "Anonymous" : m.author.displayName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pending && mode === "none" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setMode("accept")}>
            Accept…
          </button>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setMode("decline")}>
            Decline…
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm("Discard this submission as spam? It is deleted at once and nothing is sent.")) return;
              const r = await post("discard", null, "Submission discarded.");
              if (r.ok) onDecided(r.success);
            }}
          >
            Discard as spam
          </button>
        </div>
      )}

      {pending && mode === "decline" && (
        <div>
          <label style={labelStyle} htmlFor="decline-note">
            Note to the submitter (optional)
          </label>
          <textarea
            id="decline-note"
            className="field"
            style={{ width: "100%", minHeight: 90, resize: "vertical" }}
            value={note}
            maxLength={DECLINE_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={async () => {
                const r = await post("decline", { note: note.trim() || null }, "Submission declined.");
                if (r.ok) onDecided(r.success);
              }}
            >
              Decline and notify
            </button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMode("none")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending && mode === "accept" && (
        <AcceptDialog
          detail={detail}
          busy={busy}
          onCancel={() => setMode("none")}
          onAccept={async (body) => {
            const r = await post("accept", body, "");
            if (r.ok) onDecided(`Accepted as ${String(r.json.number)} — it is now in the triage queue.`);
          }}
        />
      )}
    </div>
  );
}

function AcceptDialog({
  detail,
  busy,
  onCancel,
  onAccept,
}: {
  detail: SubmissionDetail;
  busy: boolean;
  onCancel: () => void;
  onAccept: (body: Record<string, unknown>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);
  const [areas, setAreas] = useState<ImpactArea[]>([]);
  const [namespaceId, setNamespaceId] = useState("");
  const [visibility, setVisibility] = useState<"org" | "namespace">("org");
  const [impactAreaId, setImpactAreaId] = useState("");
  const [clientName, setClientName] = useState(detail.company ?? "");
  const [title, setTitle] = useState(detail.title);
  const [description, setDescription] = useState(detail.description);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    cachedGet<{ namespaces: NamespaceOption[] }>("/api/admin/namespaces")
      .then((j) => {
        const open = j.namespaces.filter((n) => !n.archivedAt);
        setNamespaces(open);
        setNamespaceId((cur) => cur || (open.find((n) => n.slug === "global") ?? open[0])?.id || "");
      })
      .catch(() => {});
    cachedGet<{ impactAreas: ImpactArea[] }>("/api/impact-areas")
      .then((j) => {
        setAreas(j.impactAreas);
        setImpactAreaId((cur) => cur || j.impactAreas[0]?.id || "");
      })
      .catch(() => {});
  }, []);

  const isClient = areas.find((a) => a.id === impactAreaId)?.name === "Client";

  return (
    <dialog
      ref={ref}
      className="author-reveal-dialog"
      style={{ width: "min(560px, calc(100vw - 32px))" }}
      aria-labelledby="accept-title"
      onClose={onCancel}
    >
      <form
        style={{ display: "flex", flexDirection: "column", gap: 14, padding: "22px 22px 20px" }}
        onSubmit={(e) => {
          e.preventDefault();
          onAccept({ namespaceId, visibility, impactAreaId, clientName: isClient ? clientName : null, title, description });
        }}
      >
        <h2 id="accept-title" style={{ fontFamily: "var(--font-display)", fontSize: 20, margin: 0 }}>
          Accept as a challenge
        </h2>
        <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
          It becomes a challenge awaiting triage, shown as &ldquo;External submission&rdquo;. Edit the text first if it holds anything that should not reach every
          employee.
        </p>
        <div>
          <label style={labelStyle} htmlFor="accept-ns">
            Namespace
          </label>
          <select id="accept-ns" className="field" style={{ width: "100%" }} value={namespaceId} onChange={(e) => setNamespaceId(e.target.value)} required>
            {namespaces.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={labelStyle} htmlFor="accept-visibility">
            Visibility
          </label>
          <select id="accept-visibility" className="field" style={{ width: "100%" }} value={visibility} onChange={(e) => setVisibility(e.target.value as "org" | "namespace")}>
            <option value="org">Everyone in the organization</option>
            <option value="namespace">Only this namespace&apos;s members</option>
          </select>
        </div>
        <div>
          <label style={labelStyle} htmlFor="accept-area">
            Impact area
          </label>
          <select id="accept-area" className="field" style={{ width: "100%" }} value={impactAreaId} onChange={(e) => setImpactAreaId(e.target.value)} required>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {isClient && (
          <div>
            <label style={labelStyle} htmlFor="accept-client">
              Client name
            </label>
            <input id="accept-client" className="field" style={{ width: "100%" }} value={clientName} maxLength={200} onChange={(e) => setClientName(e.target.value)} required />
          </div>
        )}
        <div>
          <label style={labelStyle} htmlFor="accept-title-field">
            Title
          </label>
          <input id="accept-title-field" className="field" style={{ width: "100%" }} value={title} maxLength={PUBLIC_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div>
          <label style={labelStyle} htmlFor="accept-description">
            Description
          </label>
          <textarea
            id="accept-description"
            className="field"
            style={{ width: "100%", minHeight: 140, resize: "vertical" }}
            value={description}
            maxLength={PUBLIC_DESCRIPTION_MAX}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !namespaceId || !impactAreaId}>
            Accept
          </button>
        </div>
      </form>
    </dialog>
  );
}
