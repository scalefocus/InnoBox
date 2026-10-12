"use client";
// The achievement toast (INNOBOX_SPEC.md §23.7): on page load, when the `me` payload's
// `newAchievements` is non-empty, ONE celebratory toast summarizes them — the same copy as the
// event 13 inbox row — and `me/achievements-seen` advances the marker so they are not celebrated
// again. The server already returns an empty list while the feature is off or the Achievements
// preference is off. Seeing the toast does not mark the inbox row read.
import { useEffect, useRef, useState } from "react";
import { achievementMessage, type Achievement } from "@innobox/shared/gamification";

const SHOW_MS = 6000;

export function AchievementToast({ achievements }: { achievements: Achievement[] | null }) {
  const [message, setMessage] = useState<string | null>(null);
  const shown = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (shown.current || !achievements || achievements.length === 0) return;
    shown.current = true; // once per page load, even though `me` is cached across navigations
    const text = achievementMessage(achievements);
    if (!text) return;
    setMessage(text);
    fetch("/api/me/achievements-seen", { method: "POST" }).catch(() => {});
    timer.current = window.setTimeout(() => setMessage(null), SHOW_MS);
  }, [achievements]);

  // Cleared on unmount only — a refreshed `me` must not cancel the hide timer.
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  if (!message) return null;
  return (
    <div className="toast toast-achievement" role="status" aria-live="polite">
      <span aria-hidden="true">🎉 </span>
      {message}
    </div>
  );
}
