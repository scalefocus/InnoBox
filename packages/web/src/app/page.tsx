"use client";
// Home (INNOBOX_SPEC.md §13.2): the app's landing for BOTH authenticated and unauthenticated
// visitors — the only public page (§2.1 invariant 2, §2.2). Signed in → the visibility-filtered
// dashboard (KPI tiles + spotlights). Signed out → a static welcome only: no /api/dashboard fetch,
// no data, no outbound links; sign-in is the shell's "Sign in with Entra ID" control (§2.2), and
// any Auth.js error (e.g. a deactivated account) handed back on the URL is surfaced here.
import Link from "next/link";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { getProviders, signIn, useSession } from "next-auth/react";
import { cachedGet } from "@/lib/ui";
import { useDateFmt } from "@/components/DateFormat";
import { AvatarBubble } from "@/components/AvatarBubble";
import { CHALLENGE_STATUS_LABEL, SOLUTION_STATUS_LABEL } from "./challenges/status";
import { FeaturedChallenges, type FeaturedChallengeCard } from "@/components/FeaturedChallenges";

interface SpotlightSolution {
  number: string;
  description: string;
  author: { userId: string | null; displayName: string; anonymous: boolean; active?: boolean };
  challengeNumber: string;
  challengeTitle: string;
  updatedAt: string;
}

interface DashboardData {
  featured: FeaturedChallengeCard[];
  kpis: {
    challenges: Record<string, number>;
    solutions: Record<string, number>;
  };
  spotlights: {
    lastImplemented: SpotlightSolution | null;
    lastInImplementation: SpotlightSolution | null;
  };
}

const CHALLENGE_KPI_ORDER = ["in_review", "valid", "solved", "rejected"];
const SOLUTION_KPI_ORDER = ["in_review", "valid", "in_implementation", "implemented"];

export default function HomePage() {
  // Three-state session (ENTRA_AUTH_SPEC.md §5): render the dashboard only when authenticated and
  // the sign-in welcome only when definitively unauthenticated — "loading" shows just the lede, so
  // an authenticated visitor never flashes the signed-out view before the session resolves.
  const { status } = useSession();
  const authed = status === "authenticated";
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (!authed) {
      setData(null);
      return;
    }
    cachedGet<DashboardData>("/api/dashboard")
      .then(setData)
      .catch(() => setData(null));
  }, [authed]);

  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Challenge &amp; solution management</div>
        <h1 className="page-title">Ideas worth building start here</h1>
        <p className="page-sub">
          Raise the challenges worth solving, propose solutions, and follow the winning one to
          implementation.
        </p>
      </div>

      {authed ? <Dashboard data={data} /> : status === "unauthenticated" ? <SignedOut /> : null}
    </>
  );
}

/** The signed-in dashboard: visibility-filtered KPI tiles, spotlight cards, and links out. */
function Dashboard({ data }: { data: DashboardData | null }) {
  return (
    <>
      <FeaturedChallenges items={data?.featured ?? []} />

      <div className="card card-pad reveal" style={{ marginBottom: 18 }}>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, marginBottom: 12 }}>Challenges</h3>
        <div className="stat-row quad" style={{ marginBottom: 22 }}>
          {CHALLENGE_KPI_ORDER.map((status) => (
            <div className="stat" key={status}>
              <div className="stat-num">{data?.kpis.challenges[status] ?? "–"}</div>
              <div className="stat-label">{CHALLENGE_STATUS_LABEL[status] ?? status}</div>
            </div>
          ))}
        </div>
        <h3 style={{ fontFamily: "var(--font-display)", fontSize: 16, marginBottom: 12 }}>Solutions</h3>
        <div className="stat-row quad">
          {SOLUTION_KPI_ORDER.map((status) => (
            <div className="stat" key={status}>
              <div className="stat-num">{data?.kpis.solutions[status] ?? "–"}</div>
              <div className="stat-label">{SOLUTION_STATUS_LABEL[status] ?? status}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card-grid" style={{ marginBottom: 18 }}>
        <SpotlightCard title="Most recently implemented" solution={data?.spotlights.lastImplemented ?? null} empty="No solutions implemented yet." />
        <SpotlightCard title="In implementation" solution={data?.spotlights.lastInImplementation ?? null} empty="Nothing in implementation right now." />
      </div>

      <div className="card card-pad reveal" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Link href="/challenges" className="btn btn-primary">
          Browse challenges
        </Link>
        <Link href="/leaderboard" className="btn btn-ghost">
          See the leaderboard
        </Link>
      </div>
    </>
  );
}

/** Signed-out landing: a static welcome and (dev only) the credentials panel. Carries no
 *  challenge/solution/user data or outbound links — sign-in is the shell's foot control (§2.2). */
function SignedOut() {
  const [authError, setAuthError] = useState<string | null>(null);
  const [hasDev, setHasDev] = useState(false);

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("error");
    if (err) setAuthError(err);
    // The `dev` credentials provider is registered only when INNOBOX_DEV_AUTH=1 (never in
    // production) — its presence gates the dev sign-in panel below.
    getProviders()
      .then((providers) => setHasDev(Boolean(providers && "dev" in providers)))
      .catch(() => {
        /* no providers info → no dev panel */
      });
  }, []);

  return (
    <>
      {authError && (
        <div className="card card-pad reveal" role="alert" style={{ marginBottom: 18, borderColor: "var(--danger)" }}>
          {authErrorMessage(authError)}
        </div>
      )}
      <div className="card card-pad reveal">
        <p className="muted" style={{ margin: 0 }}>
          Sign in with your Entra ID account to raise challenges, propose solutions, and follow
          them to implementation. Use the <strong>Sign in with Entra ID</strong> button in the
          sidebar to get started.
        </p>
      </div>
      {hasDev && <DevSignInPanel />}
    </>
  );
}

/** Maps an Auth.js `?error=` code (handed back to `/` because `pages.signIn` is `/`) to a message.
 *  A rejected `signIn` callback — notably a deactivated account (ENTRA_AUTH_SPEC.md §5) — arrives
 *  as `AccessDenied`. */
function authErrorMessage(code: string): string {
  switch (code) {
    case "AccessDenied":
      return "Your account has been deactivated. Contact an administrator if you believe this is a mistake.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

const devLabelStyle: CSSProperties = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: "var(--muted)",
  marginBottom: 6,
};

/** Dev-only credentials sign-in, rendered on the landing when the `dev` provider is configured
 *  (INNOBOX_DEV_AUTH=1) — never in production. Replaces the removed default Auth.js page for local
 *  dev and Playwright (ENTRA_AUTH_SPEC.md §5 dev bypass); the `admin` field mirrors the provider's
 *  `"1"` = platform-admin convention (lib/authOptions.ts). */
function DevSignInPanel() {
  const [name, setName] = useState("Dev");
  const [email, setEmail] = useState("dev@innobox.innovate");
  const [admin, setAdmin] = useState("1");
  const [freshOnboarding, setFreshOnboarding] = useState("0");
  return (
    <form
      className="card card-pad reveal"
      style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14, maxWidth: 440 }}
      onSubmit={(e) => {
        e.preventDefault();
        const callbackUrl = new URLSearchParams(window.location.search).get("callbackUrl") || "/";
        void signIn("dev", { name, email, admin, freshOnboarding, callbackUrl });
      }}
    >
      <div className="sub mono">DEVELOPER SIGN-IN</div>
      <div>
        <label style={devLabelStyle} htmlFor="dev-name">
          Display name
        </label>
        <input id="dev-name" className="field" style={{ width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label style={devLabelStyle} htmlFor="dev-email">
          Email (optional)
        </label>
        <input id="dev-email" className="field" style={{ width: "100%" }} value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label style={devLabelStyle} htmlFor="dev-admin">
          Platform admin (&quot;1&quot; = yes)
        </label>
        <input id="dev-admin" className="field" style={{ width: "100%" }} value={admin} onChange={(e) => setAdmin(e.target.value)} />
      </div>
      <div>
        <label style={devLabelStyle} htmlFor="dev-fresh-onboarding">
          Fresh onboarding (&quot;1&quot; = yes, skips /quick-start &quot;already seen&quot;)
        </label>
        <input
          id="dev-fresh-onboarding"
          className="field"
          style={{ width: "100%" }}
          value={freshOnboarding}
          onChange={(e) => setFreshOnboarding(e.target.value)}
        />
      </div>
      <button type="submit" className="btn btn-primary" style={{ justifyContent: "center" }}>
        Dev sign-in
      </button>
    </form>
  );
}

function SpotlightCard({ title, solution, empty }: { title: string; solution: SpotlightSolution | null; empty: string }) {
  const fmt = useDateFmt();
  return (
    <div className="card card-pad">
      <div className="sub mono" style={{ marginBottom: 8 }}>
        {title.toUpperCase()}
      </div>
      {!solution && <p className="muted" style={{ margin: 0 }}>{empty}</p>}
      {solution && (
        <Link href={`/challenges/${solution.challengeNumber.replace("CH-", "")}`} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="ttl" style={{ marginBottom: 4 }}>
            {solution.challengeTitle}
          </div>
          <p className="muted" style={{ fontSize: 13.5, margin: "0 0 8px" }}>
            {solution.description}
          </p>
          <div className="sub mono" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {solution.number} ·{" "}
            <AvatarBubble size="sm" userId={solution.author.userId} displayName={solution.author.displayName} anonymous={solution.author.anonymous} deactivated={solution.author.active === false} />
            {solution.author.anonymous ? "Anonymous" : solution.author.displayName} · {fmt.date(solution.updatedAt)}
          </div>
        </Link>
      )}
    </div>
  );
}
