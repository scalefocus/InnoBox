"use client";
// Platform settings → Featured challenges (INNOBOX_SPEC.md §14.3, §13.2): the cap on how many
// challenges may be pinned to the Home dashboard at once. Integer 1–6, default 3. Lowering it
// unpins nothing — new pins are refused until the count drops below the new limit. Audited
// server-side as `settings.featured_limit_changed`.
//
// Mount with `key={limit}` so a refreshed server value resets the draft without a setState-in-
// effect round trip.
import { useState } from "react";

const MIN = 1;
const MAX = 6;

export function FeaturedLimitCard({ limit, onChanged, onError }: { limit: number; onChanged: () => void; onError: (m: string) => void }) {
  const [draft, setDraft] = useState(limit);
  const [saving, setSaving] = useState(false);
  const valid = Number.isInteger(draft) && draft >= MIN && draft <= MAX;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ featuredLimit: draft }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not save the featured limit");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the featured limit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 12 }}>Featured challenges</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
          Maximum pinned on Home
          <input
            className="field"
            type="number"
            min={MIN}
            max={MAX}
            value={draft}
            onChange={(e) => setDraft(Number(e.target.value))}
            aria-label="Maximum featured challenges"
          />
        </label>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving || !valid || draft === limit} onClick={save}>
          Save
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>
        Between {MIN} and {MAX}. Lowering the limit keeps every current pin; new ones are refused until the count drops below it.
      </p>
    </div>
  );
}
