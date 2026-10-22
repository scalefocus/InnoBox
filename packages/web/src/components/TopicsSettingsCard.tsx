"use client";
// Platform settings → Topics (INNOBOX_SPEC.md §34.2): the curated, org-wide list people follow.
// Add (name + optional description), edit, retire / reactivate, and delete a retired topic — which
// removes it from every challenge and drops its follows. Each row shows bare counts only: how many
// challenges carry it and how many people follow it, never who. At most 100 active topics; the API
// refuses past that (409), and its messages are shown inline. Every write is audited server-side.
import { useCallback, useEffect, useState } from "react";

interface AdminTopic {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  challengeCount: number;
  followerCount: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function TopicsSettingsCard({ onNotice }: { onNotice?: (m: string) => void }) {
  const [topics, setTopics] = useState<AdminTopic[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { name: string; description: string }>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/topics", { headers: { accept: "application/json" } })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error ?? "Could not load topics");
        setTopics(json.topics as AdminTopic[]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load topics"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** One write; on success the list reloads, on failure the API's message shows in the card. */
  const send = async (url: string, init: RequestInit, fallback: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? fallback);
      load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
      return false;
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    const ok = await send("/api/admin/topics", { method: "POST", body: JSON.stringify({ name: name.trim(), description: description.trim() }) }, "Could not add the topic");
    if (ok) {
      setName("");
      setDescription("");
      onNotice?.("Topic added.");
    }
    setCreating(false);
  };

  const save = async (topic: AdminTopic, draft: { name: string; description: string }) => {
    setBusyId(topic.id);
    const ok = await send(
      `/api/admin/topics/${topic.id}`,
      { method: "PATCH", body: JSON.stringify({ name: draft.name.trim(), description: draft.description.trim() }) },
      "Could not save the topic",
    );
    if (ok) {
      setDrafts((cur) => {
        const next = { ...cur };
        delete next[topic.id];
        return next;
      });
    }
    setBusyId(null);
  };

  const setActive = async (topic: AdminTopic, active: boolean) => {
    setBusyId(topic.id);
    await send(`/api/admin/topics/${topic.id}`, { method: "PATCH", body: JSON.stringify({ active }) }, "Could not update the topic");
    setBusyId(null);
  };

  // §34.2: delete a retired topic — its tags and follows go with it; nothing is reassigned.
  const remove = async (topic: AdminTopic) => {
    const msg = `Permanently delete ${topic.name}? It is removed from ${plural(topic.challengeCount, "challenge", "challenges")}, and ${plural(
      topic.followerCount,
      "person stops",
      "people stop",
    )} following it.`;
    if (!window.confirm(msg)) return;
    setBusyId(topic.id);
    const ok = await send(`/api/admin/topics/${topic.id}`, { method: "DELETE" }, "Could not delete the topic");
    if (ok) onNotice?.("Topic deleted.");
    setBusyId(null);
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="topics-card">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 6 }}>Topics</h3>
      <p className="muted" style={{ margin: "0 0 12px", fontSize: 13.5 }}>
        Curated tags people can follow to hear when a new challenge in them opens for solutions. A challenge can carry up to 3.
      </p>
      <form onSubmit={create} className="create-ns-form topic-admin-create" style={{ marginBottom: 14 }}>
        <input className="field" placeholder="New topic name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} required aria-label="New topic name" />
        <input
          className="field"
          placeholder="Description (optional)"
          value={description}
          maxLength={200}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="New topic description"
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={creating || name.trim() === ""}>
          Add
        </button>
      </form>
      {error && (
        <p className="muted" role="alert" style={{ color: "var(--danger)", fontSize: 13, margin: "0 0 12px" }}>
          {error}
        </p>
      )}
      {topics === null && !error && <p className="muted">Loading…</p>}
      {topics !== null && topics.length === 0 && <p className="muted" style={{ margin: 0 }}>No topics yet.</p>}
      {topics !== null && topics.length > 0 && (
        <div className="rows">
          {topics.map((t) => {
            const draft = drafts[t.id] ?? { name: t.name, description: t.description ?? "" };
            const dirty = draft.name.trim() !== "" && (draft.name.trim() !== t.name || draft.description.trim() !== (t.description ?? ""));
            const busy = busyId === t.id;
            const edit = (patch: Partial<{ name: string; description: string }>) => setDrafts((cur) => ({ ...cur, [t.id]: { ...draft, ...patch } }));
            return (
              <div className="row impact-row topic-admin-row" key={t.id} data-testid="admin-topic-row">
                <input className="field" value={draft.name} maxLength={40} onChange={(e) => edit({ name: e.target.value })} aria-label="Topic name" />
                <input
                  className="field topic-admin-description"
                  value={draft.description}
                  maxLength={200}
                  placeholder="No description"
                  onChange={(e) => edit({ description: e.target.value })}
                  aria-label="Topic description"
                />
                {t.active ? <span className="pill pill-ok">Active</span> : <span className="pill pill-muted">Retired</span>}
                <span className="muted topic-admin-counts">
                  {plural(t.challengeCount, "challenge", "challenges")} · {plural(t.followerCount, "follower", "followers")}
                </span>
                <button type="button" className="btn btn-sm" disabled={!dirty || busy} onClick={() => save(t, draft)}>
                  Save
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setActive(t, !t.active)}>
                  {t.active ? "Retire" : "Reactivate"}
                </button>
                {!t.active && (
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(t)}>
                    Delete
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
