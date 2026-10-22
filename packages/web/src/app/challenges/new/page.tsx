"use client";
// Challenge submission form (INNOBOX_SPEC.md §6.1). On submit, the challenge is created
// at `awaiting_triage` and the user is taken to its detail page.
//
// Duplicate warning (§6.1): the first Submit click runs the similarity check before anything is
// created. With matches, an advisory banner lists them and the button becomes "Submit anyway";
// the next click submits and records which numbers were acknowledged. Editing any field after
// the warning clears it, so a changed challenge is never posted on a stale acknowledgement.
//
// Submission lock (§6.4): the first click locks the form BEFORE the similarity check. Matches
// release it (the author must be able to read, edit or proceed); no matches or a failed check
// keep it held straight into the create. Success never releases — the form unmounts locked as
// the router moves to the new challenge. Edits (which re-arm the check) are only possible while
// unlocked, so the warning's signature logic is untouched.
//
// Improve with AI (§22.10): fills the title and description from the author's own text. A draft
// fill changes the form signature, so it re-arms the duplicate check like any edit; the button
// is unavailable while the form is locked, and Submit waits while a draft is in flight.
//
// Public form link (§6.1, §24.2): while public submissions are live, a link under the subtitle
// copies `<PUBLIC_BASE_URL>/submit` so an employee can hand it to a customer. Absent while the
// state is unknown, unavailable or off — never a placeholder above the form.
//
// Drop and paste (§11): the whole page is the drop zone for the form's attachments, and a file
// paste attaches to them too — <AttachmentDropZone> owns the window listeners.
//
// Topics (§34.3): an optional picker of up to three active topics, absent while there are none.
// A topic change is a form edit like any other — it re-arms the duplicate check.
import Link from "next/link";
import { reportFeatureUse } from "@/lib/survey-client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { copyText } from "@/lib/clipboard";
import { AttachmentControl } from "@/components/AttachmentControl";
import { AttachmentDropZone } from "@/components/AttachmentDropZone";
import { FormLockOverlay, PrimaryButtonLabel, useFormLock } from "@/components/FormLock";
import { ImproveWithAiBar, useImproveWithAi } from "@/components/ImproveWithAi";
import { afterSimilarityCheck, primaryButtonState } from "@/lib/form-lock";
import { CHALLENGE_STATUS_LABEL } from "../status";
import { TopicPicker, useActiveTopics, type TopicTag } from "@/components/TopicPicker";

interface ImpactArea {
  id: string;
  name: string;
  active: boolean;
}

interface NamespaceOption {
  id: string;
  slug: string;
  displayName: string;
}

interface SimilarChallenge {
  number: string;
  title: string;
  status: string;
  author: { displayName: string; anonymous: boolean };
  /** §22.12: a one-line AI reason, when "Explain similar challenges" is on. */
  reason?: string;
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

export default function NewChallengePage() {
  const router = useRouter();
  const [impactAreas, setImpactAreas] = useState<ImpactArea[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceOption[]>([]);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [impactAreaId, setImpactAreaId] = useState("");
  const [clientName, setClientName] = useState("");
  const [namespaceId, setNamespaceId] = useState("");
  const [visibility, setVisibility] = useState<"org" | "namespace">("org");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [topics, setTopics] = useState<TopicTag[]>([]);
  const topicOptions = useActiveTopics();
  const [draftKey] = useState(() => crypto.randomUUID());
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const lock = useFormLock();
  const [error, setError] = useState<string | null>(null);
  // §6.1: the warning is tied to the exact form contents it was computed for. Any edit changes
  // the signature, so the banner clears and the next click re-checks — derived, no effect needed.
  const formSignature = JSON.stringify([title, description, impactAreaId, topics.map((t) => t.id), clientName, namespaceId, visibility, isAnonymous]);
  const [warning, setWarning] = useState<{ signature: string; matches: SimilarChallenge[]; explainedBy: string | null } | null>(null);
  const similar = warning && warning.signature === formSignature ? warning.matches : null;
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const ai = useImproveWithAi({
    kind: "challenge",
    fields: { title: [title, setTitle], description: [description, setDescription] },
    body: () => ({ kind: "challenge", title, description, visibility }),
    restricted: visibility === "namespace",
  });

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  useEffect(() => {
    cachedGet<{ impactAreas: ImpactArea[] }>("/api/impact-areas").then((j) => setImpactAreas(j.impactAreas));
    cachedGet<{ namespaces: NamespaceOption[] }>("/api/namespaces").then((j) => {
      setNamespaces(j.namespaces);
      const global = j.namespaces.find((ns) => ns.slug === "global");
      setNamespaceId((current) => current || global?.id || j.namespaces[0]?.id || "");
    });
  }, []);

  useEffect(() => {
    // Not cachedGet: the switch can change at any time, and a stale "live" would copy a 404.
    fetch("/api/public-submissions/link", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { url: null }))
      .then((json) => setPublicUrl(typeof json.url === "string" && json.url ? json.url : null))
      .catch(() => setPublicUrl(null));
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((cur) => (cur === message ? null : cur)), 3200);
  };

  const copyPublicUrl = async () => {
    if (!publicUrl) return;
    notify((await copyText(publicUrl)) ? "Public challenge URL copied" : `Couldn't copy — the address is ${publicUrl}`);
  };

  const button = primaryButtonState({
    locked: lock.locked,
    attachmentsBusy,
    idleLabel: similar && similar.length > 0 ? "Submit anyway" : "Submit challenge",
  });

  const selectedArea = impactAreas.find((a) => a.id === impactAreaId);
  const isClient = selectedArea?.name === "Client";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A second submit (double click, Enter) while locked is a no-op — guarded here, not only by
    // the disabled button.
    if (ai.busy || !lock.lock()) return;
    ai.noteSubmit();
    setError(null);
    try {
      // First click: check for similar challenges. Advisory — a failed check never blocks.
      if (similar === null) {
        const found = await fetch("/api/challenges/similar", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, description, visibility }),
        })
          .then((res) => (res.ok ? res.json() : { similar: [] }))
          .then((json) => ({ matches: (json.similar ?? []) as SimilarChallenge[], explainedBy: typeof json.explainedBy === "string" ? json.explainedBy : null }))
          .catch(() => ({ matches: [] as SimilarChallenge[], explainedBy: null }));
        if (afterSimilarityCheck(found.matches) === "warn") {
          setWarning({ signature: formSignature, matches: found.matches, explainedBy: found.explainedBy });
          lock.release();
          return;
        }
        // No matches (or a failed check): the lock stays held into the create — no flicker.
      }
      const res = await fetch("/api/challenges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          impactAreaId,
          clientName: isClient ? clientName : null,
          namespaceId,
          visibility,
          isAnonymous,
          draftKey,
          topicIds: topics.map((t) => t.id),
          similarAcknowledged: similar?.map((m) => m.number) ?? [],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not submit challenge");
      const number = (json.challenge.number as string).replace("CH-", "");
      reportFeatureUse("submit_challenge"); // §13.10: the key only — never the (maybe anonymous) item
      lock.succeed();
      router.push(`/challenges/${number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit challenge");
      lock.release();
    }
  };

  return (
    <AttachmentDropZone>
      <div className="page-head reveal">
        <div className="eyebrow">Challenges</div>
        <h1 className="page-title">Raise a challenge</h1>
        <p className="page-sub">Describe the problem worth solving. A namespace admin will triage it before it opens for solutions.</p>
        {publicUrl && (
          <button type="button" className="link-button" data-testid="copy-public-url" onClick={copyPublicUrl}>
            or ask a customer to challenge us
          </button>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="card card-pad reveal form-lock"
        data-attach-scope
        aria-busy={lock.locked}
        style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 640 }}
      >
        <div className="form-lock-body" inert={lock.locked}>
          <div>
            <label style={labelStyle} htmlFor="title">
              Title
            </label>
            <input
              id="title"
              ref={titleInputRef}
              className="field" style={{ width: "100%" }}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                ai.noteEdit("title");
              }}
              readOnly={ai.busy}
              maxLength={120}
              required
            />
          </div>

          <div>
            <label style={labelStyle} htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              className="field"
              style={{ width: "100%", minHeight: 140, resize: "vertical" }}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                ai.noteEdit("description");
              }}
              readOnly={ai.busy}
              maxLength={10000}
              required
            />
            <ImproveWithAiBar ai={ai} disabled={lock.locked} onApplyHint={setImpactAreaId} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="impactArea">
              Impact area
            </label>
            <select id="impactArea" className="field" style={{ width: "100%" }} value={impactAreaId} onChange={(e) => setImpactAreaId(e.target.value)} required>
              <option value="" disabled>
                Select an impact area…
              </option>
              {impactAreas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {topicOptions && topicOptions.length > 0 && (
            <div>
              <label style={labelStyle} htmlFor="topics">
                Topics <span style={{ textTransform: "none", letterSpacing: 0 }}>(optional)</span>
              </label>
              <TopicPicker id="topics" value={topics} onChange={setTopics} options={topicOptions} disabled={lock.locked} />
            </div>
          )}

          {isClient && (
            <div>
              <label style={labelStyle} htmlFor="clientName">
                Client name
              </label>
              <input
                id="clientName"
                className="field" style={{ width: "100%" }}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                maxLength={200}
                required
              />
            </div>
          )}

          <div>
            <label style={labelStyle} htmlFor="namespace">
              Namespace
            </label>
            <select id="namespace" className="field" style={{ width: "100%" }} value={namespaceId} onChange={(e) => setNamespaceId(e.target.value)} required>
              {namespaces.map((ns) => (
                <option key={ns.id} value={ns.id}>
                  {ns.displayName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label style={labelStyle} htmlFor="visibility">
              Visibility
            </label>
            <select
              id="visibility"
              className="field" style={{ width: "100%" }}
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as "org" | "namespace")}
            >
              <option value="org">Everyone in the organization</option>
              <option value="namespace">Only this namespace&apos;s members</option>
            </select>
          </div>

          <AttachmentControl
            parentType="challenge"
            target={{ kind: "staged", draftKey }}
            disabled={lock.locked}
            onBusyChange={setAttachmentsBusy}
            dropLabel="Your new challenge"
          />

          <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14 }}>
            <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} />
            Submit anonymously
          </label>

          {similar && similar.length > 0 && (
            <div
              role="alert"
              data-testid="similar-warning"
              style={{ border: "1px solid color-mix(in oklab, var(--warn) 40%, var(--line))", background: "var(--warn-soft)", borderRadius: "var(--radius)", padding: "14px 16px" }}
            >
              <strong style={{ display: "block", marginBottom: 8 }}>These challenges look similar — is yours one of them?</strong>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
                {similar.map((m) => (
                  <li key={m.number}>
                    <Link href={`/challenges/${m.number.replace("CH-", "")}`} target="_blank" rel="noopener noreferrer">
                      <span className="mono">{m.number}</span> {m.title}
                    </Link>{" "}
                    <span className="sub">
                      · {CHALLENGE_STATUS_LABEL[m.status] ?? m.status} · {m.author.anonymous ? "Anonymous" : m.author.displayName}
                    </span>
                    {m.reason && (
                      <div className="sub" data-testid="similar-reason" style={{ marginTop: 2 }}>
                        {m.reason}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {warning?.explainedBy && similar.some((m) => m.reason) && (
                <p className="sub" style={{ margin: "10px 0 0" }}>
                  Reasons suggested by {warning.explainedBy} — they may be inaccurate.
                </p>
              )}
              <p className="sub" style={{ margin: "10px 0 0" }}>
                If yours is different, submit it anyway — a namespace admin will triage it like any other.
              </p>
            </div>
          )}

          {error && (
            <p className="muted" role="alert" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>

        <div>
          <button type="submit" className="btn btn-primary form-lock-raised" disabled={button.disabled || ai.busy}>
            <PrimaryButtonLabel state={button} />
          </button>
        </div>
        <FormLockOverlay locked={lock.locked} />
      </form>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </AttachmentDropZone>
  );
}
