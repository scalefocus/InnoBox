"use client";
// The public form itself (INNOBOX_SPEC.md §24.3, §24.4). Its only data request is the privacy
// notice (GET /api/public/settings); besides that it fetches a proof-of-work challenge and solves
// it in the background — Submit stays disabled until then, with a muted "Checking your browser…".
// The honeypot field is off-screen and out of the accessibility tree. *Who should see this?* is a
// request only (§24.3): specific people by work e-mail, specific teams by name, or everyone in the
// organization — the reviewing admin settles the real visibility, and the impact area, namespace
// and anonymity, on accept. The e-mails are checked for syntax only: the form never looks them up.
// No duplicate check (it would show the public existing challenges). On success the form gives way
// to the "Check your inbox" message.
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  POW_TTL_MS,
  PUBLIC_COMPANY_MAX,
  PUBLIC_DESCRIPTION_MAX,
  PUBLIC_EMAIL_MAX,
  PUBLIC_NAME_MAX,
  PUBLIC_TITLE_MAX,
  privacyNoticeSegments,
} from "@innobox/shared/public-intake";
import {
  REQUESTED_EMAILS_MAX,
  REQUESTED_TEAMS_MAX,
  REQUESTED_VISIBILITY_LABELS,
  type RequestedVisibility,
} from "@innobox/shared/challenge-access";
import { TagField, type TagFieldHandle } from "@/components/TagField";
import { solvePow } from "@/lib/pow-solver";

type Pow =
  | { kind: "solving" }
  | { kind: "ready"; salt: string; number: number; signature: string }
  | { kind: "failed" };

/** Re-solve a minute before the server's 10-minute expiry, so a slow writer still submits. */
const POW_REFRESH_MS = POW_TTL_MS - 60_000;

export function SubmitForm() {
  const [notice, setNotice] = useState<string | null>(null);
  const [pow, setPow] = useState<Pow>({ kind: "solving" });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [visibility, setVisibility] = useState<RequestedVisibility>("org");
  // Kept while the other option is chosen, in case the submitter switches back; only the chosen
  // option's tags are sent.
  const [emails, setEmails] = useState<string[]>([]);
  const [teams, setTeams] = useState<string[]>([]);
  const emailsRef = useRef<TagFieldHandle>(null);
  const teamsRef = useRef<TagFieldHandle>(null);
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);

  /** Fetch and solve a fresh challenge. The caller shows "solving" first (the initial state is). */
  const solve = useCallback(async () => {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    try {
      const res = await fetch("/api/public/pow", { headers: { accept: "application/json" }, cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const c = (await res.json()) as { salt: string; challenge: string; maxNumber: number; signature: string };
      const number = await solvePow(c, controller.signal);
      if (controller.signal.aborted) return;
      setPow(number === null ? { kind: "failed" } : { kind: "ready", salt: c.salt, number, signature: c.signature });
    } catch {
      if (!controller.signal.aborted) setPow({ kind: "failed" });
    }
  }, []);

  useEffect(() => {
    fetch("/api/public/settings", { headers: { accept: "application/json" }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { privacyNotice?: string } | null) => setNotice(json?.privacyNotice ?? ""))
      .catch(() => setNotice(""));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- solve() sets state only after its first await (the fetch), never synchronously
    void solve();
    return () => run.current?.abort();
  }, [solve]);

  /** Show "Checking your browser…" again and solve a fresh challenge. */
  const resolve = useCallback(() => {
    setPow({ kind: "solving" });
    void solve();
  }, [solve]);

  // A fresh challenge before the current one expires.
  useEffect(() => {
    if (pow.kind !== "ready") return;
    const timer = window.setTimeout(resolve, POW_REFRESH_MS);
    return () => window.clearTimeout(timer);
  }, [pow, resolve]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pow.kind !== "ready" || submitting) return;
    // §24.3: text still in the chosen tag field is locked in if valid; invalid text — or an empty
    // field — blocks the submission with the inline error.
    let request: { visibility: RequestedVisibility; emails?: string[]; teams?: string[] } = { visibility: "org" };
    if (visibility === "people") {
      const done = emailsRef.current?.finish();
      if (!done?.ok) return;
      request = { visibility, emails: done.values };
    } else if (visibility === "teams") {
      const done = teamsRef.current?.finish();
      if (!done?.ok) return;
      request = { visibility, teams: done.values };
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/public/submissions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          title,
          description,
          name,
          email,
          company: company.trim() || null,
          ...request,
          consent,
          website,
          pow: { salt: pow.salt, number: pow.number, signature: pow.signature },
        }),
      });
      if (res.status === 202) {
        setSentTo(email.trim());
        return;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setError(json.error ?? "Your submission could not be sent — try again later.");
      // A challenge is spendable once: a refused one is replaced either way.
      resolve();
    } catch {
      setError("Your submission could not be sent — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (sentTo) {
    return (
      <div className="public-done" role="status" data-testid="public-submit-done">
        <h1 className="page-title">Check your inbox</h1>
        <p className="page-sub" style={{ marginLeft: "auto", marginRight: "auto" }}>
          We&apos;ve sent a confirmation link to <strong style={{ overflowWrap: "anywhere" }}>{sentTo}</strong>. Your submission is sent for review
          only after you confirm it, and the link works for 24 hours.
        </p>
      </div>
    );
  }

  const ready = pow.kind === "ready";
  return (
    <>
      <h1 className="page-title">Submit a challenge</h1>
      <p className="page-sub">Tell us about a problem you&apos;d like solved. Our team reviews every submission.</p>

      <form className="public-form" onSubmit={submit} noValidate={false}>
        <div>
          <label className="public-label" htmlFor="ps-title">
            <span>Title</span>
            <span className="count">
              {title.length} / {PUBLIC_TITLE_MAX}
            </span>
          </label>
          <input id="ps-title" className="field" style={{ width: "100%" }} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={PUBLIC_TITLE_MAX} required />
        </div>

        <div>
          <label className="public-label" htmlFor="ps-description">
            <span>Description</span>
            <span className="count">
              {description.length.toLocaleString("en-US")} / {PUBLIC_DESCRIPTION_MAX.toLocaleString("en-US")}
            </span>
          </label>
          <textarea
            id="ps-description"
            className="field"
            style={{ width: "100%", minHeight: 160, resize: "vertical" }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={PUBLIC_DESCRIPTION_MAX}
            required
          />
        </div>

        <div>
          <label className="public-label" htmlFor="ps-name">
            <span>Your name</span>
          </label>
          <input id="ps-name" className="field" style={{ width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} maxLength={PUBLIC_NAME_MAX} autoComplete="name" required />
        </div>

        <div>
          <label className="public-label" htmlFor="ps-email">
            <span>Your e-mail</span>
          </label>
          <input
            id="ps-email"
            type="email"
            className="field"
            style={{ width: "100%" }}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={PUBLIC_EMAIL_MAX}
            autoComplete="email"
            required
          />
        </div>

        <div>
          <label className="public-label" htmlFor="ps-company">
            <span>Company (optional)</span>
          </label>
          <input id="ps-company" className="field" style={{ width: "100%" }} value={company} onChange={(e) => setCompany(e.target.value)} maxLength={PUBLIC_COMPANY_MAX} autoComplete="organization" />
        </div>

        <fieldset className="public-fieldset" aria-describedby="ps-visibility-hint">
          <legend className="public-label">
            <span>Who should see this?</span>
          </legend>
          <div className="public-radios">
            {(["org", "teams", "people"] as const).map((option) => (
              <label key={option} className="public-check">
                <input type="radio" name="ps-visibility" value={option} checked={visibility === option} onChange={() => setVisibility(option)} />
                <span>{REQUESTED_VISIBILITY_LABELS[option]}</span>
              </label>
            ))}
          </div>
          {visibility === "people" && (
            <div className="public-tags">
              <label className="public-label" htmlFor="ps-emails">
                <span>Their work e-mails</span>
                <span className="count">
                  {emails.length} / {REQUESTED_EMAILS_MAX}
                </span>
              </label>
              <TagField ref={emailsRef} id="ps-emails" kind="email" values={emails} onChange={setEmails} max={REQUESTED_EMAILS_MAX} placeholder="Type an address and press Enter" />
            </div>
          )}
          {visibility === "teams" && (
            <div className="public-tags">
              <label className="public-label" htmlFor="ps-teams">
                <span>Team names</span>
                <span className="count">
                  {teams.length} / {REQUESTED_TEAMS_MAX}
                </span>
              </label>
              <TagField ref={teamsRef} id="ps-teams" kind="team" values={teams} onChange={setTeams} max={REQUESTED_TEAMS_MAX} placeholder="Type a team name and press Enter" />
            </div>
          )}
          <p id="ps-visibility-hint" className="public-status" style={{ margin: "8px 0 0" }}>
            The team that reviews your submission decides the final visibility.
          </p>
        </fieldset>

        {/* The honeypot (§24.4): a person never sees or reaches it. */}
        <div className="public-hp" aria-hidden="true">
          <label htmlFor="ps-website">Website</label>
          <input id="ps-website" name="website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>

        <div>
          <div className="public-label">
            <span>Privacy notice</span>
          </div>
          <div className="public-notice" data-testid="privacy-notice">
            {notice === null
              ? "…"
              : privacyNoticeSegments(notice).map((seg, i) =>
                  seg.kind === "link" ? (
                    <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer">
                      {seg.href}
                    </a>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
          </div>
        </div>

        <label className="public-check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
          <span>I have read the privacy notice</span>
        </label>

        {error && (
          <div className="public-error" role="alert">
            {error}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <button type="submit" className="btn btn-primary" disabled={!ready || submitting}>
            {submitting ? "Sending…" : "Submit"}
          </button>
          {pow.kind === "solving" && <span className="public-status">Checking your browser…</span>}
          {pow.kind === "failed" && (
            <span className="public-status">
              Your browser could not be checked.{" "}
              <button type="button" className="btn btn-sm btn-ghost" onClick={resolve}>
                Try again
              </button>
            </span>
          )}
        </div>
      </form>
    </>
  );
}
