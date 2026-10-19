"use client";
// Platform settings → Hype (INNOBOX_SPEC.md §26.8, §14.3): one switch, "Weekly hype", off by
// default. Off hides every hype surface and closes the hype route; existing hypes, awards and
// badges are kept, so turning it back on shows accurate numbers at once. Audited server-side as
// `settings.hype_enabled_changed`. The same pill switch, optimistic flip and revert as the
// Gamification card.
import { useState } from "react";
import { invalidateApi } from "@/lib/ui";

export function HypeSettingsCard({ enabled, onChanged, onError }: { enabled: boolean; onChanged: () => void; onError: (m: string) => void }) {
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
        body: JSON.stringify({ hypeEnabled: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not save the hype setting");
      // The hype surfaces read these; refresh them on the next visit.
      invalidateApi("/api/me");
      invalidateApi("/api/dashboard");
      onChanged();
    } catch (err) {
      setOn(!next);
      onError(err instanceof Error ? err.message : "Could not save the hype setting");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 12 }}>Hype</h3>
      <div className="row" style={{ border: 0, padding: 0 }}>
        <div className="grow">
          <div className="ttl">Weekly hype</div>
          <div className="sub">
            Everyone gets 3 hypes a week to spend on the challenges and solutions they most want acted on. Hypes cannot be taken back and count double in an
            item&apos;s first 7 days.
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
            aria-label="Weekly hype"
            disabled={saving}
            onClick={toggle}
          >
            <span className="toggle-knob" aria-hidden="true">
              {on ? "🔥" : "·"}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
