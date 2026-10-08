"use client";
// "Feature on Home" control on the challenge detail page (INNOBOX_SPEC.md §13.1, §13.2
// *Featured challenges*). Rendered by the page only when the detail payload says `canFeature`
// (a platform admin, status valid/solved) — everyone else sees no featured indicator at all
// outside the Home section. A 409 (at the cap, or the status moved) shows its message inline.
import { useState } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { invalidateApi } from "@/lib/ui";

export function FeatureOnHomeControl({
  challengeDigits,
  featured,
  featuredBy,
  featuredAt,
  onChanged,
}: {
  challengeDigits: string;
  featured: boolean;
  featuredBy?: string;
  featuredAt?: string;
  onChanged: () => Promise<void> | void;
}) {
  const fmt = useDateFmt();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/challenges/${challengeDigits}/featured`, {
        method: featured ? "DELETE" : "PUT",
        headers: { accept: "application/json" },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? (featured ? "Could not unfeature this challenge" : "Could not feature this challenge"));
      invalidateApi("/api/dashboard"); // the Home section must reflect the new pin on the next visit
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>
        Home dashboard
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" className={featured ? "btn btn-sm" : "btn btn-sm btn-primary"} disabled={busy} onClick={toggle}>
          {featured ? "Unfeature" : "Feature on Home"}
        </button>
        {featured && featuredAt && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            Featured by {featuredBy ?? "an admin"} on {fmt.date(featuredAt)}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" style={{ margin: "8px 0 0", fontSize: 12.5, color: "var(--danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
