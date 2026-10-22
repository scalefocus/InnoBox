"use client";
// The own profile's Feature ideas section (INNOBOX_SPEC.md §38.6, §38.7): the "Show my name on
// feature ideas" switch — optimistic flip, inline-error revert, like every profile switch — and
// "Your ideas", newest first: waiting for review (with Withdraw), planned (its votes, linked to
// What's new), declined (the admin's note) and merged. Hidden entirely while feature ideas are off,
// which GET /api/me/feature-ideas answers with a 404.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FEATURE_IDEA_STATUS_LABEL, type FeatureIdeaStatus } from "@innobox/shared/feature-ideas";
import { useDateFmt } from "@/components/DateFormat";
import { readJson } from "@/lib/api-client";

interface OwnIdea {
  id: string;
  status: FeatureIdeaStatus;
  createdAt: string;
  description: string | null;
  title: string | null;
  votes: number | null;
  decisionNote: string | null;
  mergedTitle: string | null;
}

const COMING_SOON = "/whats-new#coming-soon";

export function FeatureIdeasSection() {
  const fmt = useDateFmt();
  const [named, setNamed] = useState<boolean | null>(null);
  const [ideas, setIdeas] = useState<OwnIdea[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(() => {
    fetch("/api/me/feature-ideas", { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (res.status === 404) {
          setHidden(true);
          return;
        }
        const json = await readJson(res);
        if (!res.ok) throw new Error();
        setHidden(false);
        setNamed(json.named !== false);
        setIdeas((json.ideas as OwnIdea[]) ?? []);
      })
      .catch(() => setIdeas((cur) => cur ?? []));
  }, []);

  useEffect(() => load(), [load]);

  const toggleNamed = async () => {
    if (named === null) return;
    const previous = named;
    setNamed(!previous);
    setSwitchError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ featureIdeasNamed: !previous }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not update preference");
    } catch (err) {
      setNamed(previous);
      setSwitchError(err instanceof Error ? err.message : "Could not update preference");
    }
  };

  const withdraw = async (idea: OwnIdea) => {
    if (!window.confirm("Withdraw this idea? It is deleted and won't be reviewed.")) return;
    setRowError((e) => ({ ...e, [idea.id]: "" }));
    try {
      const res = await fetch(`/api/me/feature-ideas/${idea.id}`, { method: "DELETE" });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not withdraw the idea");
    } catch (err) {
      setRowError((e) => ({ ...e, [idea.id]: err instanceof Error ? err.message : "Could not withdraw the idea" }));
    }
    load();
  };

  if (hidden || named === null) return null;

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="profile-feature-ideas">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, marginBottom: 12 }}>Feature ideas</h3>
      <div className="row" style={{ border: 0, padding: 0 }}>
        <div className="grow">
          <div className="ttl">Show my name on feature ideas</div>
          <div className="sub">
            {named ? "Ideas you propose and upvote show your name on What's new." : "Your ideas and upvotes still count, but your name isn't shown."}
          </div>
          {switchError && (
            <div className="sub" style={{ color: "var(--danger)" }} role="status">
              {switchError}
            </div>
          )}
        </div>
        <div className="toggle-field">
          <span className={`toggle-state${named ? " is-on" : ""}`} aria-hidden="true">
            {named ? "On" : "Off"}
          </span>
          <button
            type="button"
            className="toggle toggle-pref"
            role="switch"
            aria-checked={named}
            aria-label="Show my name on feature ideas"
            data-testid="profile-feature-ideas-named"
            onClick={toggleNamed}
          >
            <span className="toggle-knob" aria-hidden="true">
              {named ? "👤" : "🙈"}
            </span>
          </button>
        </div>
      </div>

      <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 14 }}>
        <div className="ttl" style={{ marginBottom: 8 }}>
          Your ideas
        </div>
        {ideas && ideas.length === 0 && <p className="muted" style={{ margin: 0 }}>You haven&apos;t proposed any features yet.</p>}
        {ideas && ideas.length > 0 && (
          <ul className="idea-list" data-testid="profile-idea-list">
            {ideas.map((idea) => (
              <li key={idea.id} className="idea-row" data-status={idea.status}>
                <div className="idea-row-head">
                  <span className={idea.status === "planned" ? "pill pill-ok" : idea.status === "declined" ? "pill pill-muted" : "pill"}>
                    {FEATURE_IDEA_STATUS_LABEL[idea.status]}
                  </span>
                  <span className="sub mono">{fmt.date(idea.createdAt)}</span>
                  {idea.status === "pending" && (
                    <button type="button" className="btn btn-sm btn-ghost idea-withdraw" onClick={() => withdraw(idea)}>
                      Withdraw
                    </button>
                  )}
                </div>
                {idea.status === "planned" && (
                  <p className="idea-row-line">
                    <Link href={COMING_SOON}>{idea.title}</Link>{" "}
                    <span className="sub">
                      · {idea.votes ?? 0} {idea.votes === 1 ? "upvote" : "upvotes"}
                    </span>
                  </p>
                )}
                {idea.status === "merged" && (
                  <p className="idea-row-line">
                    {idea.mergedTitle ? (
                      <>
                        Already planned as <Link href={COMING_SOON}>{idea.mergedTitle}</Link>
                      </>
                    ) : (
                      "Already planned"
                    )}
                  </p>
                )}
                {idea.description && (
                  <>
                    <p className={expanded[idea.id] ? "idea-text" : "idea-text is-clamped"}>{idea.description}</p>
                    {!expanded[idea.id] && idea.description.length > 160 && (
                      <button type="button" className="link-btn" onClick={() => setExpanded((e) => ({ ...e, [idea.id]: true }))}>
                        Show all
                      </button>
                    )}
                  </>
                )}
                {idea.status === "declined" && idea.decisionNote && <p className="sub idea-note">Note from the reviewer: {idea.decisionNote}</p>}
                {rowError[idea.id] && (
                  <p className="sub" style={{ color: "var(--danger)" }} role="status">
                    {rowError[idea.id]}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
