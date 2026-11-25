"use client";
// Quick start onboarding (INNOBOX_SPEC.md §13.7): one generic walkthrough for every
// authenticated user, auto-opened on first sign-in (AppShell redirects here while
// quickStartSeenAt is null) and always reachable afterward from the account menu.
// "Continue to InnoBox" marks it seen and hard-navigates to "/" — a full reload so the
// shell's cached /api/me is refetched fresh, rather than client-routing off a stale
// in-memory "unseen" state that would just bounce the user straight back here.
//
// The action sits in the page head as well as after the last section, so the way out is on the
// first screen. While the user is unseen the head also says that the rest of the app is held —
// the navigation stays on screen and every item in it leads back here. A Continue that fails is
// reported beside the action that was pressed; the page navigates only once it has saved.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { cachedGet } from "@/lib/ui";

// Real screenshots of the current UI (INNOBOX_SPEC.md §13.7), captured from a running instance
// with neutral demo content. Re-capture them when the pictured screens change. A step may draw an
// inline mockup on the §2.2 tokens instead (it follows light/dark), and may link to its page.
interface Step {
  eyebrow: string;
  title: string;
  body: string;
  image?: string;
  alt: string;
  mockup?: ReactNode;
  link?: { href: string; label: string };
}

const STEPS: Step[] = [
  {
    eyebrow: "1 · Raise an idea",
    title: "Submit a challenge",
    body:
      'Got a problem worth solving? Open "New challenge", describe it, pick an impact area, and choose who can see it — the whole organisation, or just your namespace. It starts out "Awaiting triage" until an admin reviews it.',
    image: "/quick-start/01-submit-challenge.png",
    alt: "The new challenge form, with title, description, impact area, and visibility fields",
  },
  {
    eyebrow: "2 · Pitch a fix",
    title: "Propose a solution",
    body:
      'Once a challenge is marked "Valid — open for solutions", anyone can propose a solution: describe your approach and, optionally, the cost versus the benefits. A challenge can have many proposals, but only one ever moves forward.',
    image: "/quick-start/02-propose-solution.png",
    alt: "A challenge detail page with the Propose a solution button and a valid-status pill",
  },
  {
    eyebrow: "3 · Join the conversation",
    title: "Comment, like, and follow",
    body:
      "Every challenge and solution has a comment thread for discussion, a like button so good ideas stand out, and a follow toggle so you get notified when something you care about moves forward.",
    image: "/quick-start/03-comment-like-follow.png",
    alt: "A challenge detail page showing the Like and Follow buttons above a comment thread",
  },
  {
    // §34.6: following a topic hears about challenges that do not exist yet.
    eyebrow: "4 · Stay in the loop",
    title: "Follow topics",
    body:
      "Topics group challenges by subject, such as AI or Sustainability, across every namespace. Follow the topics you care about and you'll hear when a new challenge in one of them opens for solutions — no need to find it first.",
    alt: "A row of the Topics page: a topic's name and description, how many challenges are open in it, and a Following button",
    mockup: <TopicRowMockup />,
    link: { href: "/topics", label: "Browse topics" },
  },
  {
    eyebrow: "5 · Get your bearings",
    title: "Find your way around",
    body:
      "Home is your dashboard — KPI tiles and recent spotlights at a glance. Challenges lists and filters everything you can see. Implementation shows every accepted solution on its way to being built. Leaderboard ranks top contributors. The search bar in the topbar finds anything by title, description, or number (like CH-123).",
    image: "/quick-start/04-dashboard.png",
    alt: "The Home dashboard with KPI tiles and spotlight cards",
    // §46.3: one sentence and this link — no section or mockup of its own for the board.
    link: { href: "/implementation", label: "See the implementation board" },
  },
];

/** Which of the two Continue actions was pressed — the error is shown beside that one. */
type ActionPlace = "head" | "foot";

export default function QuickStartPage() {
  const [continuing, setContinuing] = useState(false);
  const [failedAt, setFailedAt] = useState<ActionPlace | null>(null);
  // True only once `me` has loaded and says this user has never continued. The shell fetches the
  // same resource through the same cache, so this costs no request of the page's own.
  const [held, setHeld] = useState(false);

  useEffect(() => {
    let live = true;
    cachedGet<{ quickStartSeenAt: string | null }>("/api/me")
      .then((me) => {
        if (live) setHeld(me.quickStartSeenAt === null);
      })
      .catch(() => {
        /* unknown: say nothing rather than claim the app is held */
      });
    return () => {
      live = false;
    };
  }, []);

  const finish = async (place: ActionPlace) => {
    setContinuing(true);
    setFailedAt(null);
    let saved = false;
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quickStartSeen: true }),
      });
      saved = res.ok;
    } catch {
      saved = false; // no response at all
    }
    if (!saved) {
      // Navigating anyway would only meet the redirect again, with nothing to say why.
      setFailedAt(place);
      setContinuing(false);
      return;
    }
    // Hard navigation: a fresh load remounts the shell so it fetches /api/me anew,
    // instead of client-routing off the stale cached "unseen" state (see file header).
    // `continuing` stays set, so both actions remain disabled while the page unloads.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- the full reload is the point
    window.location.href = "/";
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
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, marginTop: 20 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px 16px" }}>
            <ContinueButton disabled={continuing} onContinue={() => finish("head")} />
            {held && (
              <p className="muted" data-testid="quick-start-held" style={{ margin: 0, fontSize: 14.5 }}>
                The rest of InnoBox opens once you continue.
              </p>
            )}
          </div>
          {failedAt === "head" && <ContinueError />}
        </div>
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
            {step.link && (
              <p style={{ margin: 0 }}>
                <Link href={step.link.href}>{step.link.label}</Link>
              </p>
            )}
            <div
              style={{
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-sm)",
                overflow: "hidden",
                background: "var(--surface-2)",
              }}
            >
              {step.mockup ?? (
                // eslint-disable-next-line @next/next/no-img-element -- a static screenshot served as-is from /public
                <img src={step.image} alt={step.alt} style={{ width: "100%", height: "auto", display: "block" }} />
              )}
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
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <ContinueButton disabled={continuing} onContinue={() => finish("foot")} />
            {failedAt === "foot" && <ContinueError />}
          </div>
        </div>
      </div>
    </>
  );
}

/** The Continue action. It is on the page twice; both share the page's one in-flight state. */
function ContinueButton({ disabled, onContinue }: { disabled: boolean; onContinue: () => void }) {
  return (
    <button type="button" className="btn btn-primary" disabled={disabled} onClick={onContinue}>
      Continue to InnoBox
    </button>
  );
}

/** Shown beneath whichever Continue action was pressed when the save did not go through. */
function ContinueError() {
  return (
    <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "var(--danger)" }}>
      That didn&apos;t save. Please try again.
    </p>
  );
}

/** §34.6: a `/topics` row, drawn on the §2.2 tokens so it follows light and dark. */
function TopicRowMockup() {
  const display = { fontFamily: "var(--font-display)" };
  return (
    <svg viewBox="0 0 640 132" role="img" aria-label="A row of the Topics page: AI, 3 open, Following" style={{ width: "100%", height: "auto", display: "block" }}>
      <rect x="20" y="20" width="600" height="92" rx="10" style={{ fill: "var(--surface)", stroke: "var(--line)" }} />
      <text x="44" y="58" style={{ ...display, fill: "var(--ink)", fontSize: 18, fontWeight: 600 }}>
        AI
      </text>
      <text x="44" y="84" style={{ fill: "var(--muted)", fontSize: 13, fontFamily: "var(--font-body)" }}>
        Machine learning, assistants and automation with AI
      </text>
      <text x="432" y="71" style={{ fill: "var(--muted)", fontSize: 13, fontFamily: "var(--font-mono)" }}>
        3 open
      </text>
      <rect x="500" y="48" width="100" height="34" rx="8" style={{ fill: "var(--surface-2)", stroke: "var(--line)" }} />
      <text x="550" y="70" textAnchor="middle" style={{ ...display, fill: "var(--ink)", fontSize: 13, fontWeight: 600 }}>
        Following
      </text>
    </svg>
  );
}
