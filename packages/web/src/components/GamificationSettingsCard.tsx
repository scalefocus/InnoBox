"use client";
// Platform settings → Gamification (INNOBOX_SPEC.md §23.10, §14.3): one switch, "Points, levels and
// badges", off by default. Off hides every gamification surface and the Points leaderboard metric;
// points keep accruing while it is off, so turning it on shows accurate totals at once. Audited
// server-side as `settings.gamification_enabled_changed`. The same pill switch, optimistic flip
// and inline-error revert as the profile preferences.
import { useState } from "react";

export function GamificationSettingsCard({ enabled, onChanged, onError }: { enabled: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [on, setOn] = useState(enabled);
  const [saving, setSaving] = useState(false);

  const toggle = async () => {
    const next = !on;
    setOn(next);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gamificationEnabled: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not save the gamification setting");
      onChanged();
    } catch (err) {
      setOn(!next);
      onError(err instanceof Error ? err.message : "Could not save the gamification setting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 12 }}>Gamification</h3>
      <div className="row" style={{ border: 0, padding: 0 }}>
        <div className="grow">
          <div className="ttl">Points, levels and badges</div>
          <div className="sub">
            Shows levels, badges, the Points leaderboard and achievement notifications. Points keep counting while this is off.
          </div>
        </div>
        <div className="toggle-field">
          <span className={`toggle-state${on ? " is-on" : ""}`} aria-hidden="true">
            {on ? "On" : "Off"}
          </span>
          <button
            type="button"
            className="toggle toggle-pref"
            role="switch"
            aria-checked={on}
            aria-label="Points, levels and badges"
            disabled={saving}
            onClick={toggle}
          >
            <span className="toggle-knob" aria-hidden="true">
              {on ? "⭐" : "☆"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
