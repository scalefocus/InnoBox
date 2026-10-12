"use client";
// Own profile (INNOBOX_SPEC.md §13.5): identity, challenges/solutions by status (incl.
// awaiting triage — the author can always see their own), likes received, items followed,
// recent activity (newest first, any status), the e-mail notification opt-out switch, and the
// Feedback section (§13.10): the random-survey opt-out and "Take the survey" while an offer is open.
import Link from "next/link";
import { useEffect, useState } from "react";
import { useDateFmt } from "@/components/DateFormat";
import { readJson } from "@/lib/api-client";
import { cachedGet, invalidateApi } from "@/lib/ui";
import { SURVEY_CHANGED_EVENT, announceSurveyChanged, requestSurveyOpen, requestSurveyStart } from "@/lib/survey-client";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL } from "../challenges/status";
import { AvatarBubble } from "@/components/AvatarBubble";
import {
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCE_LABEL,
  type NotificationPreference,
  type NotificationPreferences,
} from "@innobox/shared/notification-preferences";

interface OwnProfile {
  user: {
    id: string;
    displayName: string;
    email: string | null;
    department: string | null;
    jobTitle: string | null;
    officeLocation: string | null;
  };
  emailNotificationsEnabled: boolean;
  notificationPreferences: NotificationPreferences;
  surveysEnabled: boolean;
  challengesByStatus: Record<string, number>;
  solutionsByStatus: Record<string, number>;
  likesReceived: number;
  following: {
    challenges: { number: string; title: string; status: string }[];
    solutions: { number: string; description: string; status: string; challengeNumber: string }[];
  };
  recentActivity: { type: "challenge" | "solution"; number: string; challengeNumber: string; label: string; status: string; at: string }[];
}

export default function ProfilePage() {
  const fmt = useDateFmt();
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [emailPrefError, setEmailPrefError] = useState<string | null>(null);
  const [prefErrors, setPrefErrors] = useState<Partial<Record<NotificationPreference, string>>>({});
  const [surveyPrefError, setSurveyPrefError] = useState<string | null>(null);
  // §13.10: whether a survey offer is open (from the `me` resource), kept in step with the shell.
  const [surveyOpen, setSurveyOpen] = useState(false);
  // The on-demand survey: null while the platform switch is off, else the cooldown's end.
  const [selfSurvey, setSelfSurvey] = useState<{ nextAt: string | null } | null>(null);

  const refresh = () => {
    fetch("/api/profile", { headers: { accept: "application/json" } })
      .then((res) => res.json())
      .then((json) => setProfile(json.profile))
      .catch(() => setProfile(null));
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const readOffer = () => {
      cachedGet<{ openSurvey?: unknown; selfSurvey?: { nextAt: string | null } | null }>("/api/me")
        .then((me) => {
          setSurveyOpen(Boolean(me.openSurvey));
          setSelfSurvey(me.selfSurvey ?? null);
        })
        .catch(() => {});
    };
    readOffer();
    window.addEventListener(SURVEY_CHANGED_EVENT, readOffer);
    return () => window.removeEventListener(SURVEY_CHANGED_EVENT, readOffer);
  }, []);

  // §13.10 "Ask me for feedback": the same optimistic flip + slide-back-with-reason. Switching off
  // also ends an open random offer, so the shell re-reads `me` (the menu item goes).
  const toggleSurveys = async () => {
    if (!profile) return;
    const previous = profile.surveysEnabled;
    const next = !previous;
    setSurveyPrefError(null);
    setProfile({ ...profile, surveysEnabled: next });
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surveysEnabled: next }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not update preference");
      invalidateApi("/api/me");
      announceSurveyChanged();
    } catch (err) {
      setProfile((current) => (current ? { ...current, surveysEnabled: previous } : current));
      setSurveyPrefError(err instanceof Error ? err.message : "Could not update preference");
    }
  };

  // The switch flips optimistically so it feels like a switch, then reconciles with the
  // server; a rejected PATCH slides the knob back and says why (INNOBOX_SPEC.md §13.5).
  const toggleEmailPref = async () => {
    if (!profile) return;
    const next = !profile.emailNotificationsEnabled;
    const previous = profile.emailNotificationsEnabled;
    setEmailPrefError(null);
    setProfile({ ...profile, emailNotificationsEnabled: next });
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailNotificationsEnabled: next }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not update preference");
      refresh();
    } catch (err) {
      setProfile((current) => (current ? { ...current, emailNotificationsEnabled: previous } : current));
      setEmailPrefError(err instanceof Error ? err.message : "Could not update preference");
    }
  };

  // §12.1 per-event preferences: the same optimistic flip + slide-back-with-reason as the e-mail
  // switch, one row per toggle.
  const togglePref = async (key: NotificationPreference) => {
    if (!profile) return;
    const previous = profile.notificationPreferences[key];
    const next = !previous;
    setPrefErrors((cur) => ({ ...cur, [key]: undefined }));
    setProfile({ ...profile, notificationPreferences: { ...profile.notificationPreferences, [key]: next } });
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error(json.error ?? "Could not update preference");
    } catch (err) {
      setProfile((current) =>
        current ? { ...current, notificationPreferences: { ...current.notificationPreferences, [key]: previous } } : current,
      );
      setPrefErrors((cur) => ({ ...cur, [key]: err instanceof Error ? err.message : "Could not update preference" }));
    }
  };

  if (!profile) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="page-head reveal" style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <AvatarBubble size="lg" userId={profile.user.id} displayName={profile.user.displayName} />
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow">Profile</div>
          <h1 className="page-title">{profile.user.displayName}</h1>
          <p className="page-sub">
            {[profile.user.jobTitle, profile.user.department, profile.user.officeLocation, profile.user.email].filter(Boolean).join(" · ") || "—"}
          </p>
        </div>
      </div>

      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <div className="row" style={{ border: 0, padding: 0 }}>
          <div className="grow">
            <div className="ttl">E-mail notifications</div>
            <div className="sub">In-app notifications are always on. This toggles e-mail delivery only.</div>
            {emailPrefError && <div className="sub" style={{ color: "var(--danger)" }} role="status">{emailPrefError}</div>}
          </div>
          <div className="toggle-field">
            <span className={`toggle-state${profile.emailNotificationsEnabled ? " is-on" : ""}`} aria-hidden="true">
              {profile.emailNotificationsEnabled ? "On" : "Off"}
            </span>
            <button
              type="button"
              className="toggle toggle-pref"
              role="switch"
              aria-checked={profile.emailNotificationsEnabled}
              aria-label="E-mail notifications"
              onClick={toggleEmailPref}
            >
              <span className="toggle-knob" aria-hidden="true">
                {profile.emailNotificationsEnabled ? "📧" : "🔇"}
              </span>
            </button>
          </div>
        </div>
        {NOTIFICATION_PREFERENCES.map((key) => {
          const on = profile.notificationPreferences[key];
          const label = NOTIFICATION_PREFERENCE_LABEL[key];
          return (
            <div className="row" style={{ border: 0, borderTop: "1px solid var(--line)", padding: "14px 0 0", marginTop: 14 }} key={key}>
              <div className="grow">
                <div className="ttl">{label.title}</div>
                <div className="sub">{label.sub}</div>
                {prefErrors[key] && (
                  <div className="sub" style={{ color: "var(--danger)" }} role="status">
                    {prefErrors[key]}
                  </div>
                )}
              </div>
              <div className="toggle-field">
                <span className={`toggle-state${on ? " is-on" : ""}`} aria-hidden="true">
                  {on ? "On" : "Off"}
                </span>
                <button type="button" className="toggle toggle-pref" role="switch" aria-checked={on} aria-label={label.title} onClick={() => togglePref(key)}>
                  <span className="toggle-knob" aria-hidden="true">
                    {on ? "🔔" : "🔕"}
                  </span>
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card card-pad reveal" style={{ marginBottom: 18 }} data-testid="profile-feedback">
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, marginBottom: 12 }}>Feedback</h3>
        <div className="row" style={{ border: 0, padding: 0 }}>
          <div className="grow">
            <div className="ttl">Ask me for feedback</div>
            <div className="sub">
              {profile.surveysEnabled
                ? "Now and then, at most once a month, InnoBox asks how it's doing. Answers are anonymous."
                : "You won't be asked to take surveys."}
            </div>
            {surveyPrefError && (
              <div className="sub" style={{ color: "var(--danger)" }} role="status">
                {surveyPrefError}
              </div>
            )}
          </div>
          <div className="toggle-field">
            <span className={`toggle-state${profile.surveysEnabled ? " is-on" : ""}`} aria-hidden="true">
              {profile.surveysEnabled ? "On" : "Off"}
            </span>
            <button
              type="button"
              className="toggle toggle-pref"
              role="switch"
              aria-checked={profile.surveysEnabled}
              aria-label="Ask me for feedback"
              data-testid="profile-survey-switch"
              onClick={toggleSurveys}
            >
              <span className="toggle-knob" aria-hidden="true">
                {profile.surveysEnabled ? "💬" : "🔕"}
              </span>
            </button>
          </div>
        </div>
        {/* Row 2: Give feedback now — replaced by Take the survey while any offer is open, and
            hidden while the platform switch is off (§13.10). Shown whatever the random switch says. */}
        {surveyOpen ? (
          <div className="row" style={{ border: 0, borderTop: "1px solid var(--line)", padding: "14px 0 0", marginTop: 14 }}>
            <div className="grow">
              <div className="ttl">A short survey is waiting for you</div>
              <div className="sub">About a minute, and anonymous.</div>
            </div>
            <button type="button" className="btn btn-sm" data-testid="profile-take-survey" onClick={requestSurveyOpen}>
              Take the survey
            </button>
          </div>
        ) : (
          selfSurvey && (
            <div className="row" style={{ border: 0, borderTop: "1px solid var(--line)", padding: "14px 0 0", marginTop: 14 }}>
              <div className="grow">
                <div className="ttl">Give feedback</div>
                <div className="sub" data-testid="profile-give-feedback-help">
                  {selfSurvey.nextAt
                    ? `You can share feedback again on ${fmt.date(selfSurvey.nextAt)}.`
                    : "Tell us what you think, any time. Once a week at most."}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                data-testid="profile-give-feedback"
                disabled={selfSurvey.nextAt !== null}
                onClick={requestSurveyStart}
              >
                Give feedback now
              </button>
            </div>
          )
        )}
      </div>

      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, marginBottom: 12 }}>My challenges</h3>
        <div className="stat-row quad" style={{ marginBottom: 22 }}>
          {Object.keys(CHALLENGE_STATUS_LABEL).map((status) => (
            <div className="stat" key={status}>
              <div className="stat-num">{profile.challengesByStatus[status] ?? 0}</div>
              <div className="stat-label">{CHALLENGE_STATUS_LABEL[status]}</div>
            </div>
          ))}
        </div>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, marginBottom: 12 }}>My solutions</h3>
        <div className="stat-row quad" style={{ marginBottom: 22 }}>
          {Object.keys(SOLUTION_STATUS_LABEL).map((status) => (
            <div className="stat" key={status}>
              <div className="stat-num">{profile.solutionsByStatus[status] ?? 0}</div>
              <div className="stat-label">{SOLUTION_STATUS_LABEL[status]}</div>
            </div>
          ))}
        </div>
        <div className="stat-row">
          <div className="stat">
            <div className="stat-num">{profile.likesReceived}</div>
            <div className="stat-label">Likes received</div>
          </div>
        </div>
      </div>

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 12px" }}>Following</h2>
      {profile.following.challenges.length === 0 && profile.following.solutions.length === 0 && (
        <p className="muted" style={{ marginBottom: 22 }}>
          You&apos;re not following anything yet.
        </p>
      )}
      {(profile.following.challenges.length > 0 || profile.following.solutions.length > 0) && (
        <div className="rows" style={{ marginBottom: 26 }}>
          {profile.following.challenges.map((c) => (
            <Link key={c.number} href={`/challenges/${c.number.replace("CH-", "")}`} className="row">
              <span className="chip mono">{c.number}</span>
              <span className="ttl grow">{c.title}</span>
              <span className="sub">{CHALLENGE_STATUS_LABEL[c.status] ?? c.status}</span>
            </Link>
          ))}
          {profile.following.solutions.map((s) => (
            <Link key={s.number} href={`/challenges/${s.challengeNumber.replace("CH-", "")}`} className="row">
              <span className="chip mono">{s.number}</span>
              <span className="ttl grow">{s.description}</span>
              <span className="sub">{SOLUTION_STATUS_LABEL[s.status] ?? s.status}</span>
            </Link>
          ))}
        </div>
      )}

      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 19, margin: "0 0 12px" }}>Recent activity</h2>
      {profile.recentActivity.length === 0 && <p className="muted">No activity yet.</p>}
      {profile.recentActivity.length > 0 && (
        <div className="rows">
          {profile.recentActivity.map((a) => (
            <Link key={`${a.type}-${a.number}`} href={`/challenges/${a.challengeNumber.replace("CH-", "")}`} className="row">
              <span className="chip mono">{a.number}</span>
              <span className="ttl grow">{a.label}</span>
              <span className="sub">{(a.type === "challenge" ? CHALLENGE_STATUS_LABEL : SOLUTION_STATUS_LABEL)[a.status] ?? a.status}</span>
              <span className="sub mono">{fmt.date(a.at)}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
