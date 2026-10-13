"use client";
// Platform settings → Public submissions (INNOBOX_SPEC.md §24.2, §14.3): the "Accept public
// submissions" switch (off by default), the privacy notice shown on the public form, and the
// read-only public address with a copy button. The switch can be turned on only while
// PUBLIC_INTAKE_KEY is set, a notice is saved and an e-mail transport is available — otherwise it
// is disabled with the missing item named. Audited server-side as
// `settings.public_submissions_changed`. Same pill switch and optimistic flip as the other cards.
import { useState } from "react";
import { PRIVACY_NOTICE_MAX } from "@innobox/shared/public-intake";

export interface PublicSubmissionsSettings {
  enabled: boolean;
  privacyNotice: string;
  publicUrl: string;
  live: boolean;
  missing: "key" | "notice" | "transport" | null;
  hint: string | null;
}

async function patch(body: Record<string, unknown>): Promise<void> {
  const res = await fetch("/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicSubmissions: body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Could not save the public submissions setting");
}

export function PublicSubmissionsSettingsCard({
  settings,
  onChanged,
  onError,
}: {
  settings: PublicSubmissionsSettings;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [on, setOn] = useState(settings.enabled);
  const [notice, setNotice] = useState(settings.privacyNotice);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Off → on needs every precondition; a saved notice counts only once it is saved.
  const blocked = !on && settings.missing !== null;
  const noticeDirty = notice.trim() !== settings.privacyNotice;

  const toggle = async () => {
    const next = !on;
    setOn(next);
    setSaving(true);
    try {
      await patch({ enabled: next });
      onChanged();
    } catch (err) {
      setOn(!next);
      onError(err instanceof Error ? err.message : "Could not save the public submissions setting");
    } finally {
      setSaving(false);
    }
  };

  const saveNotice = async () => {
    setSaving(true);
    try {
      await patch({ privacyNotice: notice });
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save the privacy notice");
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(settings.publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      onError("Could not copy the address");
    }
  };

  return (
    <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="public-submissions-card">
      <h3 style={{ fontFamily: "var(--font-display)", fontSize: 17, marginBottom: 12 }}>Public submissions</h3>
      <div className="row" style={{ border: 0, padding: 0 }}>
        <div className="grow">
          <div className="ttl">Accept public submissions</div>
          <div className="sub">
            People outside the organization can send a challenge through a public form, without an account. Every submission waits in a review queue
            until a platform admin accepts it.
          </div>
          {blocked && settings.hint && (
            <div className="sub" style={{ color: "var(--warn)", marginTop: 6 }} data-testid="public-submissions-hint">
              {settings.hint}
            </div>
          )}
          {on && !settings.live && settings.hint && (
            <div className="sub" style={{ color: "var(--danger)", marginTop: 6 }}>
              The form is offline until this is fixed: {settings.hint}
            </div>
          )}
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
            aria-label="Accept public submissions"
            disabled={saving || blocked}
            onClick={toggle}
          >
            <span className="toggle-knob" aria-hidden="true">
              {on ? "✉" : "✕"}
            </span>
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label htmlFor="public-privacy-notice" className="ttl" style={{ display: "block", marginBottom: 6 }}>
          Privacy notice
        </label>
        <div className="sub" style={{ marginBottom: 8 }}>
          Shown on the public form above the consent checkbox. Plain text; https links become clickable.
        </div>
        <textarea
          id="public-privacy-notice"
          className="field"
          style={{ width: "100%", minHeight: 120, resize: "vertical" }}
          value={notice}
          maxLength={PRIVACY_NOTICE_MAX}
          onChange={(e) => setNotice(e.target.value)}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn btn-sm btn-primary" disabled={saving || !noticeDirty} onClick={saveNotice}>
            Save notice
          </button>
          <span className="sub mono">
            {notice.length.toLocaleString("en-US")} / {PRIVACY_NOTICE_MAX.toLocaleString("en-US")}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div className="ttl" style={{ marginBottom: 6 }}>
          Public address
        </div>
        <div className="field-with-btn">
          <input className="field mono" readOnly value={settings.publicUrl} aria-label="Public address" />
          <button type="button" className="btn btn-sm" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="sub" style={{ marginTop: 6 }}>
          InnoBox links to it from nowhere — share it wherever you want outside submissions to come from.
        </div>
      </div>
    </div>
  );
}
