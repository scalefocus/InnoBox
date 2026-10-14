"use client";
// The challenge page's admin visibility control (INNOBOX_SPEC.md §4.3, §14.2): Organization-wide,
// Namespace-only, or Specific people. Choosing one of the first two saves at once, as before.
// Choosing Specific people opens the access-list editor and saves only with at least one person;
// on a challenge that is already `people`, the editor shows its list and saves changes to it.
// Switching away from Specific people clears the list (the server says so in the audit log).
import { useState } from "react";
import type { AccessEntryView } from "@innobox/shared/challenge-access";
import { readJson } from "@/lib/api-client";
import { AccessListEditor, accessTagsFromView, accessTagsToInput, type AccessTag } from "@/components/AccessListEditor";

type Visibility = "org" | "namespace" | "people";

const labelStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--faint)",
  marginBottom: 8,
  display: "block",
};

function sameList(a: readonly AccessTag[], b: readonly AccessTag[]): boolean {
  const key = (t: AccessTag) => (t.kind === "user" ? `u:${t.id}` : `e:${t.email}`);
  const left = new Set(a.map(key));
  return a.length === b.length && b.every((t) => left.has(key(t)));
}

export function VisibilityControl({
  challengeNumber,
  visibility,
  access,
  disabled,
  onSaved,
  onError,
}: {
  challengeNumber: string;
  visibility: Visibility;
  access: AccessEntryView[] | null;
  disabled: boolean;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const saved = accessTagsFromView(access ?? []);
  const [choice, setChoice] = useState<Visibility>(visibility);
  const [tags, setTags] = useState<AccessTag[]>(saved);
  const [busy, setBusy] = useState(false);

  const post = async (next: Visibility, list?: AccessTag[]) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/challenges/${challengeNumber.replace("CH-", "")}/visibility`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(list ? { visibility: next, access: accessTagsToInput(list) } : { visibility: next }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not change visibility");
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not change visibility");
      setChoice(visibility);
    } finally {
      setBusy(false);
    }
  };

  const onSelect = (next: Visibility) => {
    setChoice(next);
    if (next === "people") {
      setTags(visibility === "people" ? saved : []);
      return;
    }
    if (next !== visibility) void post(next);
  };

  const editing = choice === "people";
  const dirty = visibility !== "people" || !sameList(tags, saved);
  const off = disabled || busy;

  return (
    <div style={{ marginTop: 14 }}>
      <label htmlFor="visibility-select" style={labelStyle}>
        Visibility
      </label>
      <select id="visibility-select" className="field" value={choice} disabled={off} onChange={(e) => onSelect(e.target.value as Visibility)}>
        <option value="org">Organization-wide</option>
        <option value="namespace">Namespace-only</option>
        <option value="people">Specific people</option>
      </select>
      {editing && (
        <div style={{ marginTop: 10 }}>
          <label htmlFor="visibility-access" style={labelStyle}>
            People with access
          </label>
          <AccessListEditor id="visibility-access" tags={tags} onChange={setTags} disabled={off} />
          <p className="muted" style={{ margin: "6px 0 0", fontSize: 12.5 }}>
            The namespace&apos;s admins and committee and the assignee can always see it. Nobody else learns who is on the list.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-sm btn-primary" disabled={off || tags.length === 0 || !dirty} onClick={() => void post("people", tags)}>
              {visibility === "people" ? "Save list" : "Share with these people"}
            </button>
            {(visibility !== "people" || dirty) && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={off}
                onClick={() => {
                  setChoice(visibility);
                  setTags(saved);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
