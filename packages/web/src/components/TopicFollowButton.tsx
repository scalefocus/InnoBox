"use client";
// The Follow button for a topic (INNOBOX_SPEC.md §34.4, §34.6) — on `/topics` and in the filtered
// gallery's header. It reads *Follow*, or *Following* while followed (and *Unfollow* on hover or
// focus then), and sets the wanted state through POST /api/topics/:id/follow, so a repeated click
// is harmless. The flip is optimistic: a refused request slides it back and says why, briefly.
import { useEffect, useState } from "react";
import { postJson } from "@/lib/api-client";

export function TopicFollowButton({ topicId, following, onChange }: { topicId: string; following: boolean; onChange?: (following: boolean) => void }) {
  const [on, setOn] = useState(following);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hover or focus on a followed topic offers the way out.
  const [armed, setArmed] = useState(false);

  // A new value from the parent (a refetch, another control) wins over the local one.
  useEffect(() => setOn(following), [following]);

  const toggle = async () => {
    if (busy) return;
    const next = !on;
    setError(null);
    setOn(next);
    setBusy(true);
    try {
      await postJson(`/api/topics/${topicId}/follow`, { following: next });
      onChange?.(next);
    } catch (err) {
      setOn(!next);
      setError(err instanceof Error ? err.message : "Could not update the topic");
    } finally {
      setBusy(false);
    }
  };

  const label = on ? (armed ? "Unfollow" : "Following") : "Follow";
  return (
    <span className="topic-follow">
      <button
        type="button"
        className={on ? "btn btn-sm" : "btn btn-sm btn-primary"}
        aria-pressed={on}
        onClick={toggle}
        onMouseEnter={() => setArmed(true)}
        onMouseLeave={() => setArmed(false)}
        onFocus={() => setArmed(true)}
        onBlur={() => setArmed(false)}
        data-testid="topic-follow"
      >
        {label}
      </button>
      {error && (
        <span className="sub" style={{ color: "var(--danger)" }} role="status">
          {error}
        </span>
      )}
    </span>
  );
}
