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
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { StagedAttachments } from "@/components/StagedAttachments";
import { FormLockOverlay, PrimaryButtonLabel, useFormLock } from "@/components/FormLock";
import { afterSimilarityCheck, primaryButtonState } from "@/lib/form-lock";
import { CHALLENGE_STATUS_LABEL } from "../status";

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
  const [draftKey] = useState(() => crypto.randomUUID());
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const lock = useFormLock();
  const [error, setError] = useState<string | null>(null);
  // §6.1: the warning is tied to the exact form contents it was computed for. Any edit changes
  // the signature, so the banner clears and the next click re-checks — derived, no effect needed.
  const formSignature = JSON.stringify([title, description, impactAreaId, clientName, namespaceId, visibility, isAnonymous]);
  const [warning, setWarning] = useState<{ signature: string; matches: SimilarChallenge[] } | null>(null);
  const similar = warning && warning.signature === formSignature ? warning.matches : null;
  const titleInputRef = useRef<HTMLInputElement>(null);

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
    if (!lock.lock()) return;
    setError(null);
    try {
      // First click: check for similar challenges. Advisory — a failed check never blocks.
      if (similar === null) {
        const found = await fetch("/api/challenges/similar", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, description }),
        })
          .then((res) => (res.ok ? res.json() : { similar: [] }))
          .then((json) => (json.similar ?? []) as SimilarChallenge[])
          .catch(() => [] as SimilarChallenge[]);
        if (afterSimilarityCheck(found) === "warn") {
          setWarning({ signature: formSignature, matches: found });
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
          similarAcknowledged: similar?.map((m) => m.number) ?? [],
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not submit challenge");
      const number = (json.challenge.number as string).replace("CH-", "");
      lock.succeed();
      router.push(`/challenges/${number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit challenge");
      lock.release();
    }
  };

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Challenges</div>
        <h1 className="page-title">Raise a challenge</h1>
        <p className="page-sub">Describe the problem worth solving. A namespace admin will triage it before it opens for solutions.</p>
      </div>

      <form
        onSubmit={onSubmit}
        className="card card-pad reveal form-lock"
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
              onChange={(e) => setTitle(e.target.value)}
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
              onChange={(e) => setDescription(e.target.value)}
              maxLength={10000}
              required
            />
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

          <StagedAttachments parentType="challenge" draftKey={draftKey} disabled={lock.locked} onBusyChange={setAttachmentsBusy} />

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
                  </li>
                ))}
              </ul>
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
          <button type="submit" className="btn btn-primary form-lock-raised" disabled={button.disabled}>
            <PrimaryButtonLabel state={button} />
          </button>
        </div>
        <FormLockOverlay locked={lock.locked} />
      </form>
    </>
  );
}
