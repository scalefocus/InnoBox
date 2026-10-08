"use client";
// Challenge submission form (INNOBOX_SPEC.md §6.1). On submit, the challenge is created
// at `awaiting_triage` and the user is taken to its detail page.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cachedGet } from "@/lib/ui";
import { StagedAttachments } from "@/components/StagedAttachments";

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const selectedArea = impactAreas.find((a) => a.id === impactAreaId);
  const isClient = selectedArea?.name === "Client";

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
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
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not submit challenge");
      const number = (json.challenge.number as string).replace("CH-", "");
      router.push(`/challenges/${number}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit challenge");
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Challenges</div>
        <h1 className="page-title">Raise a challenge</h1>
        <p className="page-sub">Describe the problem worth solving. A namespace admin will triage it before it opens for solutions.</p>
      </div>

      <form onSubmit={onSubmit} className="card card-pad reveal" style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 640 }}>
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

        <StagedAttachments parentType="challenge" draftKey={draftKey} disabled={submitting} onBusyChange={setAttachmentsBusy} />

        <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14 }}>
          <input type="checkbox" checked={isAnonymous} onChange={(e) => setIsAnonymous(e.target.checked)} />
          Submit anonymously
        </label>

        {error && (
          <p className="muted" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}

        <div>
          <button type="submit" className="btn btn-primary" disabled={submitting || attachmentsBusy}>
            {submitting ? "Submitting…" : attachmentsBusy ? "Waiting for attachments…" : "Submit challenge"}
          </button>
        </div>
      </form>
    </>
  );
}
