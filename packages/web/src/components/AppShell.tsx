"use client";
// App shell (INNOBOX_SPEC.md §2.2): persistent left sidebar — InnoBox's own wordmark logo
// (the official brand image, navy on light / white on dark; deliberately NOT the corporate
// eye), live-route nav, account menu, and the colophon showing APP_VERSION above the two
// attribution lines. Off-canvas drawer + hamburger on mobile.
// The colophon below is the ONLY place in the product that names the creating organization
// (§2.2 attribution rule); the hygiene test in lib/attribution.test.ts enforces that.
// Markup follows the class contract in app/globals.css; nav items are added here as
// each phase ships its routes — never dead links.
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signIn, signOut, useSession } from "next-auth/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { APP_VERSION } from "@innobox/shared/version";
import { cachedGet } from "../lib/ui";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { TopbarSearch, type TopbarSearchHandle } from "./TopbarSearch";
import { AvatarBubble } from "./AvatarBubble";

// Shape of the §16 `me` resource (packages/web/src/app/api/me/route.ts) — only the fields
// this shell needs (identity for the account menu, the admin role hints for nav gating).
interface MeResponse {
  user: { id: string; displayName: string; email: string | null; userName: string };
  roles: { platformAdmin: boolean; namespaceAdmin: string[] };
  quickStartSeenAt: string | null;
}

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** §14.4 attention count — rendered as a 1–9+ bubble on the Triage & Administration items. */
  badge?: number;
}

const BASE_NAV: NavItem[] = [
  { href: "/", label: "Home", icon: <HomeIcon /> },
  { href: "/challenges/new", label: "Submit a Challenge", icon: <SubmitChallengeIcon /> },
  { href: "/challenges", label: "Challenges", icon: <ChallengesIcon /> },
  { href: "/leaderboard", label: "Leaderboard", icon: <TrophyIcon /> },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // Session is the three-state signal (ENTRA_AUTH_SPEC.md §5): "authenticated" → the full app
  // shell; "unauthenticated" → the sign-in shell (no nav, "Sign in with Entra ID" in the foot);
  // "loading" → neutral, so we never flash the wrong state before the session resolves.
  const { status } = useSession();
  const authed = status === "authenticated";
  const [drawerOpen, setDrawerOpen] = useState(false);
  const searchRef = useRef<TopbarSearchHandle>(null);
  // Role/identity hints for the nav + account menu. Fetched only when authenticated — the
  // signed-out landing shows no user data (INNOBOX_SPEC.md §2.1 invariant 2, §13.2).
  const [me, setMe] = useState<MeResponse | null>(null);
  // §14.4 attention count for the Triage/Administration nav bubbles — polled while an admin is
  // signed in (see the effect below).
  const [attention, setAttention] = useState(0);

  // Navigating closes the mobile drawer.
  useEffect(() => setDrawerOpen(false), [pathname]);

  useEffect(() => {
    if (!authed) {
      setMe(null);
      return;
    }
    let live = true;
    cachedGet<MeResponse>("/api/me")
      .then((res) => {
        if (live) setMe(res);
      })
      .catch(() => {
        /* keep the neutral look on a transient error */
      });
    return () => {
      live = false;
    };
  }, [authed]);

  // Global Ctrl+K / Cmd+K search shortcut (INNOBOX_SPEC.md §13.4): focuses the topbar search
  // from anywhere while signed in. Suppresses the browser/OS default for the combo, but leaves
  // it alone while focus is inside a *different* text field so it can't clobber in-progress
  // typing (e.g. a comment box) — refocusing the search input itself still fires normally.
  useEffect(() => {
    if (!authed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey)) return;
      const active = document.activeElement as HTMLElement | null;
      const activeIsTextField =
        active &&
        !searchRef.current?.isActive() &&
        (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (activeIsTextField) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [authed]);

  // First-sign-in onboarding (INNOBOX_SPEC.md §13.7): a null quickStartSeenAt means this user
  // has never completed /quick-start, so every authenticated route bounces there first — taking
  // priority over wherever they were headed. Re-fires on every navigation until the page's
  // "Continue to InnoBox" action marks it seen, which is the intended "force them through it"
  // behavior for a still-unseen user.
  useEffect(() => {
    if (!me || me.quickStartSeenAt !== null) return;
    if (pathname === "/quick-start") return;
    router.replace("/quick-start");
  }, [me, pathname, router]);

  const isAdmin = Boolean(me?.roles.platformAdmin || (me?.roles.namespaceAdmin?.length ?? 0) > 0);

  // §14.4: poll the unseen-actionable count while an admin is signed in, on the same 30s cadence
  // as the notification bell. The triage-queue page dispatches `innobox:triage-seen` after it
  // stamps triage_seen_at, so the bubble clears promptly on open instead of waiting for the tick.
  useEffect(() => {
    if (!authed || !isAdmin) {
      setAttention(0);
      return;
    }
    let live = true;
    const fetchAttention = () => {
      fetch("/api/admin/triage/attention", { headers: { accept: "application/json" } })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (live && json) setAttention(json.count ?? 0);
        })
        .catch(() => {});
    };
    fetchAttention();
    const interval = window.setInterval(fetchAttention, 30_000);
    window.addEventListener("innobox:triage-seen", fetchAttention);
    return () => {
      live = false;
      window.clearInterval(interval);
      window.removeEventListener("innobox:triage-seen", fetchAttention);
    };
  }, [authed, isAdmin]);

  // No nav links unless signed in — the signed-out shell is wordmark + colophon + sign-in only.
  // Triage and Administration (admins only) both carry the §14.4 attention bubble (shared count).
  const nav: NavItem[] = !authed
    ? []
    : isAdmin
      ? [
          ...BASE_NAV,
          { href: "/admin/triage", label: "Triage", icon: <TriageIcon />, badge: attention },
          { href: "/admin", label: "Administration", icon: <ShieldIcon />, badge: attention },
        ]
      : BASE_NAV;

  return (
    <div className="shell">
      <aside className={drawerOpen ? "sidebar open" : "sidebar"}>
        <div className="sidebar-head">
          <div className="brand">
            {/* InnoBox's own wordmark (official brand asset). The two theme variants swap via CSS on
                [data-theme] — set before paint in layout.tsx, so there's no flash: navy on light,
                white on dark. Deliberately InnoBox's own mark, not the corporate eye. */}
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand logo, not an optimizable photo */}
            <img className="brand-logo brand-logo--light" src="/brand/innobox-light.png" alt="InnoBox" width={1041} height={200} />
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand logo, not an optimizable photo */}
            <img className="brand-logo brand-logo--dark" src="/brand/innobox-dark.png" alt="InnoBox" width={1041} height={200} />
          </div>
          <button type="button" className="nav-close" aria-label="Close menu" onClick={() => setDrawerOpen(false)}>
            ✕
          </button>
        </div>

        {nav.length > 0 && (
          <>
            <div className="nav-label">Menu</div>
            <nav aria-label="Main">
              {nav.map((item) => {
                // Exact match, or a descendant path — but a parent item (e.g. Challenges, `/challenges`)
                // must NOT light up when a more specific sibling (Submit a Challenge, `/challenges/new`)
                // matches the current path; `/challenges/:number` still keeps Challenges active.
                const active =
                  pathname === item.href ||
                  (item.href !== "/" &&
                    pathname.startsWith(`${item.href}/`) &&
                    !nav.some(
                      (other) =>
                        other.href.length > item.href.length &&
                        (pathname === other.href || pathname.startsWith(`${other.href}/`)),
                    ));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={active ? "nav-item active" : "nav-item"}
                    aria-current={active ? "page" : undefined}
                  >
                    <span className="nav-ico" aria-hidden="true">
                      {item.icon}
                    </span>
                    {item.label}
                    {typeof item.badge === "number" && item.badge > 0 && (
                      <span className="nav-badge" aria-label={`${item.badge} item${item.badge === 1 ? "" : "s"} need attention`}>
                        {item.badge > 9 ? "9+" : item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          </>
        )}

        <div className="sidebar-foot">
          {authed && <AccountMenu me={me} />}
          {status === "unauthenticated" && <SignInButton />}
          <div className="colophon">
            <span className="colophon-version">
              <Link href="/whats-new">v{APP_VERSION}</Link>
            </span>
            <span className="colophon-sub">Created by Scalefocus</span>
            <span className="colophon-sub">Powered by the community</span>
          </div>
        </div>
      </aside>

      {drawerOpen && <div className="nav-backdrop" onClick={() => setDrawerOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button type="button" className="nav-toggle" aria-label="Open menu" onClick={() => setDrawerOpen(true)}>
            <MenuIcon />
          </button>
          {authed && <TopbarSearch ref={searchRef} />}
          <div className="topbar-spacer" />
          {authed && <NotificationBell />}
          <ThemeToggle />
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

/** Bottom-left account menu: the signed-in user (name, avatar bubble) with What's new
 *  and Sign out. Falls back to the Phase 0 "Account" look while `me` hasn't loaded yet
 *  (or never will, e.g. a fetch error) — the person icon and generic label. */
function AccountMenu({ me }: { me: { user: { id: string; displayName: string; email: string | null } } | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const displayName = me?.user.displayName || null;

  return (
    <div className="user-foot" ref={rootRef}>
      {open && (
        <div className="user-menu menu-pop" role="menu">
          <Link className="user-menu-item" role="menuitem" href="/profile" onClick={() => setOpen(false)}>
            <PersonIcon />
            My profile
          </Link>
          <Link className="user-menu-item" role="menuitem" href="/quick-start" onClick={() => setOpen(false)}>
            <CompassIcon />
            Quick start
          </Link>
          <Link className="user-menu-item" role="menuitem" href="/whats-new" onClick={() => setOpen(false)}>
            <SparkIcon />
            What&apos;s new
          </Link>
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut({ callbackUrl: "/" });
            }}
          >
            <SignOutIcon />
            Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        className="user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {/* The 26px bubble must not sit inside the 16px .nav-ico slot — it would overflow
            the slot and swallow the flex gap before the name. */}
        {me?.user.id && displayName ? (
          /* noCard (§13.8): this element already opens the account menu on click. */
          <AvatarBubble size="sm" userId={me.user.id} displayName={displayName} noCard />
        ) : (
          <span className="nav-ico" aria-hidden="true">
            <PersonIcon />
          </span>
        )}
        {displayName ?? "Account"}
      </button>
    </div>
  );
}

/** The signed-out sidebar-foot control — a primary "Sign in with Entra ID" button in the exact
 *  slot the account menu occupies when signed in. Starts Entra OIDC directly and returns the user
 *  to where they were headed (the middleware-preserved `callbackUrl`, else Home). */
function SignInButton() {
  return (
    <button
      type="button"
      className="btn btn-primary signin-foot"
      onClick={() => {
        const callbackUrl = new URLSearchParams(window.location.search).get("callbackUrl") || "/";
        void signIn("azure-ad", { callbackUrl });
      }}
    >
      <LogInIcon />
      Sign in with Entra ID
    </button>
  );
}

// Inline icons: outline, rounded, monochrome (SF brand icon rule) — stroke currentColor.
function LogInIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M10 8l4 4-4 4" />
      <path d="M14 12H3" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  );
}

function SubmitChallengeIcon() {
  // Document with a plus — "raise a new challenge". Outline, rounded, monochrome (SF icon rule).
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9" />
      <path d="M13 3v5h5" />
      <path d="M16.5 3.5v5M14 6h5" />
    </svg>
  );
}

function ChallengesIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.44 1 1.16 1 1.95V17h5v-1.15c0-.79.4-1.51 1-1.95A6 6 0 0 0 12 3Z" />
      <path d="M9.5 20h5M10.5 21.5h3" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
      <path d="M7 5H4v2a3 3 0 0 0 3 3M17 5h3v2a3 3 0 0 1-3 3" />
      <path d="M12 14v3M9 20.5h6M10 17.5h4v3h-4z" />
    </svg>
  );
}

function TriageIcon() {
  // Inbox / sort tray — "items waiting to be triaged". Outline, rounded, monochrome (SF icon rule).
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 13h4l1.5 2.5h5L16 13h4" />
      <path d="M5.5 6h13l1.5 7v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5l1.5-7Z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 5 6v5c0 4.5 3 7.6 7 9 4-1.4 7-4.5 7-9V6l-7-3Z" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15" />
      <path d="M10 16l5-4-5-4" />
      <path d="M15 12H4" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5c1.5-3.5 4.2-5 7.5-5s6 1.5 7.5 5" />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M14.8 9.2 13 13l-3.8 1.8L11 11l3.8-1.8Z" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}
