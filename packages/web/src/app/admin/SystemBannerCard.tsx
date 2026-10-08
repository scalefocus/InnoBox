"use client";
// The §14.6 Administration card body (INNOBOX_SPEC.md): compose the platform-wide banner — text
// with a live counter, tone, optional link, one of the fixed durations — Save (an unconditional
// replace whose countdown restarts), and, while one is active, the live message, remaining time
// and Clear now. Reverts to the empty state on its own once expired. The card wrapper and the
// platform-admin gate live in admin/page.tsx.
import { useEffect, useState, type FormEvent } from "react";
import {
  SYSTEM_BANNER_DURATIONS,
  SYSTEM_BANNER_DURATION_LABEL,
  SYSTEM_BANNER_MESSAGE_MAX,
  SYSTEM_BANNER_TONES,
  bannerRemainingLabel,
  isSystemBannerActive,
  type SystemBanner,
  type SystemBannerDuration,
  type SystemBannerTone,
} from "@innobox/shared/system-banner";
import { readJson } from "@/lib/api-client";

const URL_ = "/api/admin/system-banner";

export function SystemBannerCard({ onNotify, onActiveChange }: { onNotify: (message: string) => void; onActiveChange?: (active: boolean) => void }) {
  const [stored, setStored] = useState<SystemBanner | null>(null);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<SystemBannerTone>("info");
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState<SystemBannerDuration>("1d");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = () =>
    fetch(URL_, { headers: { accept: "application/json" } })
      .then(readJson)
      .then((j) => setStored((j.banner as SystemBanner | null) ?? null))
      .catch(() => onNotify("Could not load the system banner"));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The remaining-time label and the "expired" flip are judged client-side every 30 s, so the card
  // reverts to its empty state on its own (lazy expiry, no polling of the server needed).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const active = isSystemBannerActive(stored, now);
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(URL_, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, tone, url: url.trim() || null, duration }) });
      const j = await readJson(res);
      if (!res.ok) throw new Error(j.error ?? `request failed (${res.status})`);
      setStored(j.banner as SystemBanner);
      setNow(Date.now());
      setMessage("");
      setUrl("");
      onNotify("Banner published.");
      window.dispatchEvent(new Event("innobox:banner-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the banner");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(URL_, { method: "DELETE" });
      const j = await readJson(res);
      if (!res.ok) throw new Error(j.error ?? `request failed (${res.status})`);
      setStored(null);
      onNotify("Banner cleared.");
      window.dispatchEvent(new Event("innobox:banner-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear the banner");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
        One announcement, shown to every signed-in person in the header until it expires or you clear it. Saving replaces whatever is
        showing and restarts the clock. It is not a notification — nobody is e-mailed.
      </p>

      {active && stored && (
        <div className="row" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", marginBottom: 16, flexWrap: "wrap" }} data-testid="banner-active">
          <span className={stored.tone === "warning" ? "pill pill-warn" : "pill pill-accent"}>{stored.tone === "warning" ? "Warning" : "Info"}</span>
          <span className="grow">
            <span className="ttl">{stored.message}</span>
            {stored.url && (
              <span className="sub mono" style={{ display: "block" }}>
                {stored.url}
              </span>
            )}
          </span>
          <span className="sub mono">{bannerRemainingLabel(stored.expiresAt, now)}</span>
          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={clear}>
            Clear now
          </button>
        </div>
      )}
      {!active && <p className="sub" style={{ marginTop: 0 }}>No banner is showing right now.</p>}

      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="sub">
            Message <span className="mono">({message.length}/{SYSTEM_BANNER_MESSAGE_MAX})</span>
          </span>
          <input
            className="field"
            value={message}
            maxLength={SYSTEM_BANNER_MESSAGE_MAX}
            placeholder="e.g. Planned maintenance on Friday from 18:00 — InnoBox will be read-only for an hour."
            onChange={(e) => setMessage(e.target.value)}
            required
            aria-label="Banner message"
          />
        </label>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <select className="field" value={tone} onChange={(e) => setTone(e.target.value as SystemBannerTone)} aria-label="Tone">
            {SYSTEM_BANNER_TONES.map((t) => (
              <option key={t} value={t}>
                {t === "info" ? "Info" : "Warning"}
              </option>
            ))}
          </select>
          <select className="field" value={duration} onChange={(e) => setDuration(e.target.value as SystemBannerDuration)} aria-label="Duration">
            {SYSTEM_BANNER_DURATIONS.map((d) => (
              <option key={d} value={d}>
                {SYSTEM_BANNER_DURATION_LABEL[d]}
              </option>
            ))}
          </select>
          <input
            className="field"
            style={{ flex: 1, minWidth: 220 }}
            value={url}
            placeholder="Optional link (https://… or /page)"
            onChange={(e) => setUrl(e.target.value)}
            aria-label="Learn more link"
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || message.trim() === ""}>
            {active ? "Replace banner" : "Publish banner"}
          </button>
        </div>
        {error && (
          <p className="sub" style={{ color: "var(--danger)", margin: 0 }} role="alert">
            {error}
          </p>
        )}
      </form>
    </>
  );
}
