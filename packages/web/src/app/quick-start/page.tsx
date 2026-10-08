"use client";
// Quick start onboarding (INNOBOX_SPEC.md §13.7): one generic walkthrough for every
// authenticated user, auto-opened on first sign-in (AppShell redirects here while
// quickStartSeenAt is null) and always reachable afterward from the account menu.
// "Continue to InnoBox" marks it seen and hard-navigates to "/" — a full reload so the
// shell's cached /api/me is refetched fresh, rather than client-routing off a stale
// in-memory "unseen" state that would just bounce the user straight back here.
import { useState } from "react";

// Illustrative diagrams, not photographic screenshots (INNOBOX_SPEC.md §13.7 called for real
// screenshots; the environment this was built in couldn't capture the running app, so these
// brand-styled mockups stand in — swap in real captures of the current UI when that's possible).
const STEPS: { eyebrow: string; title: string; body: string; image: string; alt: string }[] = [
  {
    eyebrow: "1 · Raise an idea",
    title: "Submit a challenge",
    body:
      'Got a problem worth solving? Open "New challenge", describe it, pick an impact area, and choose who can see it — the whole organisation, or just your namespace. It starts out "Awaiting triage" until an admin reviews it.',
    image: "/quick-start/01-submit-challenge.svg",
    alt: "The new challenge form, with title, description, impact area, and visibility fields",
  },
  {
    eyebrow: "2 · Pitch a fix",
    title: "Propose a solution",
    body:
      'Once a challenge is marked "Valid — open for solutions", anyone can propose a solution: describe your approach and, optionally, the cost versus the benefits. A challenge can have many proposals, but only one ever moves forward.',
    image: "/quick-start/02-propose-solution.svg",
    alt: "A challenge detail page with the Propose a solution button and a valid-status pill",
  },
  {
    eyebrow: "3 · Join the conversation",
    title: "Comment, like, and follow",
    body:
      "Every challenge and solution has a comment thread for discussion, a like button so good ideas stand out, and a follow toggle so you get notified when something you care about moves forward.",
    image: "/quick-start/03-comment-like-follow.svg",
    alt: "A challenge detail page showing the Like and Follow buttons above a comment thread",
  },
  {
    eyebrow: "4 · Get your bearings",
    title: "Find your way around",
    body:
      "Home is your dashboard — KPI tiles and recent spotlights at a glance. Challenges lists and filters everything you can see. Leaderboard ranks top contributors. The search bar in the topbar finds anything by title, description, or number (like CH-123).",
    image: "/quick-start/04-dashboard.svg",
    alt: "The Home dashboard with KPI tiles and spotlight cards",
  },
];

export default function QuickStartPage() {
  const [continuing, setContinuing] = useState(false);

  const finish = async () => {
    setContinuing(true);
    try {
      await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quickStartSeen: true }),
      });
    } finally {
      // Hard navigation: a fresh load remounts the shell so it fetches /api/me anew,
      // instead of client-routing off the stale cached "unseen" state (see file header).
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- the full reload is the point
      window.location.href = "/";
    }
  };

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Welcome</div>
        <h1 className="page-title">Quick start</h1>
        <p className="page-sub">
          A two-minute tour of the basics — submitting challenges, proposing solutions, and finding your way
          around InnoBox.
        </p>
      </div>

      <div className="reveal" style={{ display: "flex", flexDirection: "column", gap: 22, marginBottom: 26 }}>
        {STEPS.map((step) => (
          <div className="card card-pad" key={step.title} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 0 }}>
              {step.eyebrow}
            </div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, margin: 0 }}>{step.title}</h2>
            <p className="muted" style={{ maxWidth: "72ch", margin: 0 }}>
              {step.body}
            </p>
            <div
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                background: "var(--surface-2)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a static SVG illustration, not an optimizable photo */}
              <img src={step.image} alt={step.alt} style={{ width: "100%", height: "auto", display: "block" }} />
            </div>
          </div>
        ))}
      </div>

      <div className="card card-pad reveal">
        <div className="row" style={{ border: 0, padding: 0 }}>
          <div className="grow">
            <div className="ttl">Ready to dive in?</div>
            <div className="sub">You can always come back here from the account menu.</div>
          </div>
          <button type="button" className="btn btn-primary" disabled={continuing} onClick={finish}>
            Continue to InnoBox
          </button>
        </div>
      </div>
    </>
  );
}
