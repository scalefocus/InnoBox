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
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { APP_VERSION } from "@innobox/shared/version";
import { cachedGet, invalidateApi } from "../lib/ui";
import { postJson } from "../lib/api-client";
import { isChallengesSurface, leavesChallengesSurface } from "../lib/challenges-surface";
import { QUICK_START_PATH, shouldRedirectToQuickStart } from "../lib/quick-start";
import { ThemeToggle } from "./ThemeToggle";
import { NotificationBell } from "./NotificationBell";
import { SystemBanner } from "./SystemBanner";
import { usePulse } from "./usePulse";
import { TopbarSearch, type TopbarSearchHandle } from "./TopbarSearch";
import { AvatarBubble } from "./AvatarBubble";
import { SurveyCard, type BugCardOthers, type StartSelfOutcome } from "./SurveyCard";
import { bugButtonVisible, bugClickDecision, isSurveyFeature, type SurveyFeature, type SurveyOfferPayload, type SurveyVia } from "@innobox/shared/survey";
import { SURVEY_OPEN_EVENT, SURVEY_START_EVENT, announceSurveyChanged, claimFeatureReport, subscribeFeatureUse, surveyCanShow } from "../lib/survey-client";
import { WHATS_NEW_SEEN_EVENT, WhatsNewNotice } from "./WhatsNewNotice";
import { whatsNewAction } from "../lib/whats-new";
import { AchievementToast } from "./AchievementToast";
import { RumCollector, type RumConfig } from "./RumCollector";
import type { Achievement } from "@innobox/shared/gamification";

// Shape of the §16 `me` resource (packages/web/src/app/api/me/route.ts) — only the fields
// this shell needs (identity for the account menu, the admin role hints for nav gating, the
// §13.9 What's new marker for the update notice).
interface MeResponse {
  user: { id: string; displayName: string; email: string | null; userName: string };
  roles: { platformAdmin: boolean; namespaceAdmin: string[] };
  quickStartSeenAt: string | null;
  whatsNewSeenVersion: string | null;
  whatsNewSinceDate: string | null;
  /** §13.10 the open survey offer (null when none, or while the platform switch is off). */
  openSurvey?: SurveyOfferPayload | null;
  /** §13.10 on-demand survey: null while the switch is off, else the cooldown's end (null = now). */
  selfSurvey?: { nextAt: string | null } | null;
  /** §13.10 bug reports: the sidebar bug button and the picker's Bug option (both switches on). */
  bugReports?: boolean;
  /** §23.12: the sidebar ring's level (null while gamification is off) and the toast queue. */
  gamification?: { points: number; level: number; levelName: string; progress: number } | null;
  newAchievements?: Achievement[];
  /** §25.9: true while agent access is on, or while the user still holds a live connection —
   *  shows the account menu's AI agents item. */
  agentsMenu?: boolean;
  /** §14.12: whether this tab starts the monitoring collector, and at what sample rate. */
  rum?: RumConfig | null;
}

/** The survey card the shell has open (§13.10). */
interface SurveyCardState {
  via: SurveyVia;
  /** A fresh key per open: a reopened card starts blank. */
  key: number;
  /** False for an offer-less bug card (opened by the bug button with no usable offer). */
  holdsOffer: boolean;
  /** Open in Bug mode. */
  bug: boolean;
  /** Bumped by a bug-button click while the card is open. */
  bugSignal: number;
  /** Offer-less only: what the non-Bug picker options do. */
  others?: BugCardOthers;
}

/** The mobile layout's breakpoint — where the nav becomes a drawer and the bell a full sheet. */
const MOBILE_QUERY = "(max-width: 880px)";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /** §14.4 attention count — rendered as a 1–9+ bubble on the Triage & Administration items;
   *  §13.1 new-challenge count on the Challenges item. */
  badge?: number;
  /** Accessible label for the bubble; defaults to the attention wording. */
  badgeLabel?: (count: number) => string;
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
  // §12.2 pulse (v1.18): the shell's ONLY poll — the bell's unread count, the §13.1 "new since
  // your last visit" count behind the Challenges bubble, the §14.4 attention count behind the
  // Triage/Administration bubbles (null for non-admins) and the §14.6 banner. Visible tabs only.
  const { pulse, adoptUnreadCount } = usePulse(authed);
  const attention = pulse.attention ?? 0;
  const newChallenges = pulse.newChallenges;
  const previousPath = useRef<string | null>(null);
  // §13.10 feedback survey: the open offer, the card (and how it was opened), the bell's open
  // state (its mobile sheet blocks the card), and the shell's toast.
  const [survey, setSurvey] = useState<SurveyOfferPayload | null>(null);
  // `holdsOffer` false = an offer-less bug card (§13.10 *Bug reports*); `bugSignal` is bumped when
  // the bug button is clicked while the card is open.
  const [card, setCard] = useState<SurveyCardState | null>(null);
  const [bellOpen, setBellOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // §13.9 → §13.10: the update notice was dismissed (or acknowledged on /whats-new) this load.
  const [whatsNewClosed, setWhatsNewClosed] = useState(false);
  // §13.10: an on-demand survey opened by a click hides an on-screen notice WITHOUT stamping it.
  const [noticeSuppressed, setNoticeSuppressed] = useState(false);

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
        if (!live) return;
        setMe(res);
        setSurvey(res.openSurvey ?? null);
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
  // has never completed /quick-start, so every authenticated route goes there first — taking
  // priority over wherever they were headed. A full page load is redirected server-side by the
  // root layout before anything renders (lib/quick-start-gate.ts); this covers in-app
  // navigations, where the root layout does not re-render — the page is withheld (see
  // `quickStartPending` below) and replaced, so it never renders first either. Re-fires on every
  // navigation until "Continue to InnoBox" marks it seen.
  const quickStartPending = authed && me !== null && shouldRedirectToQuickStart(pathname, me.quickStartSeenAt);
  useEffect(() => {
    if (quickStartPending) router.replace(QUICK_START_PATH);
  }, [quickStartPending, router]);

  const isAdmin = Boolean(me?.roles.platformAdmin || (me?.roles.namespaceAdmin?.length ?? 0) > 0);

  // ── §13.10 feedback survey ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const mobileOverlayOpen = isMobile && (drawerOpen || bellOpen);
  // The §13.9 What's new decision, made once `me` has loaded (which `shellReady` waits for): while
  // the update notice is due or on screen, no survey shows — What's new always wins. Due is the
  // notice's own rule, so it errs towards "due" (a due notice with nothing to list still blocks).
  useEffect(() => {
    const onSeen = () => setWhatsNewClosed(true);
    window.addEventListener(WHATS_NEW_SEEN_EVENT, onSeen);
    return () => window.removeEventListener(WHATS_NEW_SEEN_EVENT, onSeen);
  }, []);
  const whatsNewDue =
    !whatsNewClosed &&
    pathname !== "/whats-new" &&
    me !== null &&
    whatsNewAction(me.whatsNewSeenVersion, APP_VERSION, me.quickStartSeenAt !== null) === "show";
  const shellReady = authed && me !== null;
  const quickStartGate = quickStartPending || pathname === QUICK_START_PATH;
  const canShow = surveyCanShow({ shellReady, whatsNewDue, quickStartGate, cardOpen: card !== null, mobileOverlayOpen });
  // Async handlers read the latest canShow without re-subscribing.
  const canShowRef = useRef(canShow);
  useEffect(() => {
    canShowRef.current = canShow;
  }, [canShow]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 4000);
  }, []);

  /** Re-reads `me` after start, close, submit and opt-out, so the menu item follows the offer. */
  const refreshSurvey = useCallback(() => {
    invalidateApi("/api/me");
    cachedGet<MeResponse>("/api/me")
      .then((res) => {
        setMe(res);
        setSurvey(res.openSurvey ?? null);
      })
      .catch(() => {});
    announceSurveyChanged();
  }, []);

  const openCard = useCallback((offer: SurveyOfferPayload, via: SurveyVia) => {
    setSurvey(offer);
    setCard({ via, key: Date.now(), holdsOffer: true, bug: false, bugSignal: 0 }); // a fresh key: a reopened card starts blank
  }, []);

  // First-use reports: pages dispatch them after a successful action; the shell queues them until
  // it has made its What's new decision (page-view features fire on load), then sends each with
  // the real canShow. Each tab reports a feature at most once per session.
  const featureQueue = useRef<SurveyFeature[]>([]);
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    if (!authed) return;
    return subscribeFeatureUse((feature) => {
      if (!isSurveyFeature(feature) || !claimFeatureReport(feature)) return;
      featureQueue.current.push(feature);
      setQueued((n) => n + 1);
    });
  }, [authed]);
  useEffect(() => {
    if (!shellReady || featureQueue.current.length === 0) return;
    for (const feature of featureQueue.current.splice(0)) {
      fetch("/api/me/features/used", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feature, canShow: canShowRef.current }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((json: { survey?: SurveyOfferPayload | null } | null) => {
          if (json?.survey) {
            openCard(json.survey, "popup");
            refreshSurvey();
          }
        })
        .catch(() => {});
    }
  }, [shellReady, queued, openCard, refreshSurvey]);

  // The 90-day fallback: once per full page load, after the What's new decision, only when the
  // survey could show and no offer is open.
  const checkedFallback = useRef(false);
  useEffect(() => {
    if (!shellReady || quickStartGate || checkedFallback.current) return;
    checkedFallback.current = true;
    if (!canShowRef.current || me?.openSurvey) return;
    fetch("/api/me/survey/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canShow: true }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { survey?: SurveyOfferPayload | null } | null) => {
        if (json?.survey) {
          openCard(json.survey, "popup");
          refreshSurvey();
        }
      })
      .catch(() => {});
  }, [shellReady, quickStartGate, me, openCard, refreshSurvey]);

  // "Take the survey" from the profile's Feedback section. A deliberate click overrides canShow,
  // so an on-screen What's new notice steps aside (unstamped) for the rest of this load.
  const reopenSurvey = useCallback(() => {
    if (!survey) return;
    setNoticeSuppressed(true);
    openCard(survey, "menu");
  }, [survey, openCard]);
  useEffect(() => {
    window.addEventListener(SURVEY_OPEN_EVENT, reopenSurvey);
    return () => window.removeEventListener(SURVEY_OPEN_EVENT, reopenSurvey);
  }, [reopenSurvey]);

  // The on-demand survey ("Give feedback", "Have your say"): an open offer is returned as is and
  // reopens like Take the survey; a new one opens a `self` card. Bypasses canShow (the user asked).
  const startSurvey = useCallback(async () => {
    setDrawerOpen(false);
    try {
      const res = await fetch("/api/me/survey/start", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { survey?: SurveyOfferPayload; created?: boolean; error?: string };
      if (res.ok && json.survey) {
        setNoticeSuppressed(true);
        openCard(json.survey, json.created ? "popup" : "menu");
      } else if (json.error === "cooldown") {
        showToast("You've shared feedback recently — you can again in a few days.");
      } else {
        showToast("Feedback isn't available right now.");
      }
    } catch {
      showToast("Feedback isn't available right now.");
    }
    refreshSurvey();
  }, [openCard, refreshSurvey, showToast]);
  useEffect(() => {
    const onStart = () => void startSurvey();
    window.addEventListener(SURVEY_START_EVENT, onStart);
    return () => window.removeEventListener(SURVEY_START_EVENT, onStart);
  }, [startSurvey]);

  // Where the on-demand entry points show (§13.10): signed in, past Quick start, switch on; the menu
  // item and the profile button only outside the cooldown and with no offer open; the colophon link
  // also while an offer is open (it then reopens it).
  const selfSurvey = me?.selfSurvey ?? null;
  const canStartSelf = selfSurvey !== null && selfSurvey.nextAt === null && survey === null;
  const showHaveYourSay = shellReady && !quickStartGate && me?.quickStartSeenAt != null && selfSurvey !== null && (survey !== null || selfSurvey.nextAt === null);

  // ✕ / Escape: "not now". Optimistic — a failed call is neither retried nor surfaced. An
  // offer-less bug card has nothing to close on the server.
  const holdsOffer = card?.holdsOffer ?? false;
  const closeCard = useCallback(() => {
    setCard(null);
    if (holdsOffer) fetch("/api/me/survey/close", { method: "POST" }).catch(() => {});
  }, [holdsOffer]);

  // Submitted, or expired meanwhile: the card's offer (if it held one) is gone. A bug report from
  // an offer-less card leaves every offer as it was.
  const finishCard = useCallback(() => {
    setCard(null);
    if (holdsOffer) setSurvey(null);
    refreshSurvey();
  }, [holdsOffer, refreshSurvey]);

  // ── §13.10 bug reports: the sidebar bug button ──────────────────────────────────────────────
  const bugReports = me?.bugReports === true;
  const showBugButton = bugButtonVisible({ shellReady, quickStartGate, quickStartSeen: me?.quickStartSeenAt != null, bugReports });
  // Bug reports switched off meanwhile: an open offer-less bug card goes (its text is discarded).
  useEffect(() => {
    if (!bugReports && card && !card.holdsOffer) setCard(null);
  }, [bugReports, card]);

  /** What a bug-button click does depends on what is open (cases 1–4). Like every on-demand click
   *  it overrides canShow: an on-screen What's new notice steps aside, unstamped. */
  const reportBug = useCallback(() => {
    setDrawerOpen(false);
    setNoticeSuppressed(true);
    const decision = bugClickDecision({
      openOffer: survey?.trigger ?? null,
      card: card ? { holdsOffer: card.holdsOffer } : null,
      selfNextAt: me?.selfSurvey?.nextAt ? new Date(me.selfSurvey.nextAt) : null,
      now: new Date(),
    });
    switch (decision.kind) {
      case "focus":
      case "switch":
        setCard((c) => (c ? { ...c, bug: true, bugSignal: c.bugSignal + 1 } : c));
        return;
      case "reopen":
        setCard({ via: "menu", key: Date.now(), holdsOffer: true, bug: true, bugSignal: 0 });
        return;
      case "offerless": {
        // A random offer's open card closes first, exactly like its ✕ ("not now").
        if (decision.closeRandom) fetch("/api/me/survey/close", { method: "POST" }).catch(() => {});
        const others: BugCardOthers =
          decision.others.state === "cooldown" ? { state: "cooldown", nextAt: decision.others.nextAt.toISOString() } : decision.others;
        setCard({ via: "popup", key: Date.now(), holdsOffer: false, bug: true, bugSignal: 0, others });
        return;
      }
    }
  }, [survey, card, me]);

  /** An offer-less bug card's user picked another category: start an on-demand survey now, and
   *  hand the card the new `self` offer. */
  const startSelfFromBugCard = useCallback(async (): Promise<StartSelfOutcome> => {
    try {
      const res = await fetch("/api/me/survey/start", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { survey?: SurveyOfferPayload; error?: string; nextAt?: string };
      if (res.ok && json.survey?.trigger === "self") {
        setSurvey(json.survey);
        setCard((c) => (c ? { ...c, holdsOffer: true, bug: false } : c));
        refreshSurvey();
        return { ok: true };
      }
      if (res.ok && json.survey) {
        // A random offer this tab didn't know about: the card stays on Bug, the others wait for it.
        setSurvey(json.survey);
        setCard((c) => (c ? { ...c, others: { state: "random" } } : c));
        refreshSurvey();
        return { ok: false, nextAt: null, random: true };
      }
      refreshSurvey();
      return { ok: false, nextAt: json.error === "cooldown" ? (json.nextAt ?? null) : null };
    } catch {
      return { ok: false, nextAt: null };
    }
  }, [refreshSurvey]);

  // "Don't ask me again": the profile opt-out, then the toast.
  const optOut = useCallback(async () => {
    const res = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surveysEnabled: false }),
    });
    if (!res.ok) throw new Error("opt-out failed");
    setCard(null);
    setSurvey(null);
    refreshSurvey();
    showToast("Got it — no more surveys. You can turn them back on in your profile.");
  }, [refreshSurvey, showToast]);

  // §14.4 / §13.1: the attention and new-challenges counts ride on the §12.2 pulse (usePulse). The
  // triage queue dispatches `innobox:triage-seen` after stamping triage_seen_at, and leaving the
  // Challenges surface dispatches `innobox:challenges-seen` below — both re-read the pulse at once.
  // A tab closed while on the surface counts as a leave too (a beacon survives page hide where a
  // fetch would not). Entering never touches the marker, so the count and the card tags stay
  // stable for the whole visit.
  useEffect(() => {
    if (!authed) return;
    const prev = previousPath.current;
    previousPath.current = pathname;
    if (leavesChallengesSurface(prev, pathname)) {
      fetch("/api/me/challenges-seen", { method: "POST" })
        .then(() => window.dispatchEvent(new Event("innobox:challenges-seen")))
        .catch(() => {});
    }
  }, [authed, pathname]);

  useEffect(() => {
    if (!authed) return;
    const onPageHide = () => {
      if (isChallengesSurface(previousPath.current)) navigator.sendBeacon("/api/me/challenges-seen");
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [authed]);

  const baseNav: NavItem[] = BASE_NAV.map((item) =>
    item.href === "/challenges"
      ? { ...item, badge: authed ? newChallenges : 0, badgeLabel: (n) => `${n} new challenge${n === 1 ? "" : "s"} since your last visit` }
      : item,
  );

  // No nav links unless signed in — the signed-out shell is wordmark + colophon + sign-in only.
  // Triage and Administration (admins only) both carry the §14.4 attention bubble (shared count).
  const nav: NavItem[] = !authed
    ? []
    : isAdmin
      ? [
          ...baseNav,
          { href: "/admin/triage", label: "Triage", icon: <TriageIcon />, badge: attention },
          { href: "/admin", label: "Administration", icon: <ShieldIcon />, badge: attention },
        ]
      : baseNav;

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
                      <span className="nav-badge" aria-label={item.badgeLabel ? item.badgeLabel(item.badge) : `${item.badge} item${item.badge === 1 ? "" : "s"} need attention`}>
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
          {authed && <AccountMenu me={me} survey={survey} onTakeSurvey={reopenSurvey} canGiveFeedback={canStartSelf} onGiveFeedback={() => void startSurvey()} onNotify={showToast} />}
          {status === "unauthenticated" && <SignInButton />}
          <div className="colophon">
            <span className="colophon-version">
              <Link href="/whats-new">v{APP_VERSION}</Link>
            </span>
            <span className="colophon-sub">Created by Scalefocus</span>
            <div className="colophon-last">
              <span className="colophon-sub">
                Powered by the community
                {showHaveYourSay && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="colophon-link"
                      data-testid="colophon-have-your-say"
                      onClick={() => {
                        // With an offer open it reopens that offer; otherwise it starts one.
                        if (survey) {
                          setDrawerOpen(false);
                          reopenSurvey();
                        } else {
                          void startSurvey();
                        }
                      }}
                    >
                      Have your say
                    </button>
                  </>
                )}
              </span>
              {/* §13.10 bug reports: icon-only, quiet, bottom-right of the sidebar foot. */}
              {showBugButton && (
                <button type="button" className="colophon-bug" aria-label="Report a bug" title="Report a bug" data-testid="report-bug" onClick={reportBug}>
                  <BugIcon />
                </button>
              )}
            </div>
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
          {authed && <SystemBanner banner={pulse.banner} />}
          {authed && <NotificationBell unreadCount={pulse.unreadCount} onUnreadCount={adoptUnreadCount} onOpenChange={setBellOpen} />}
          <ThemeToggle />
        </header>
        <main className="content">{quickStartPending ? null : children}</main>
      </div>

      {authed && card && (!card.holdsOffer || survey) && (
        <SurveyCard
          key={card.key}
          offer={card.holdsOffer ? survey : null}
          via={card.via}
          hidden={mobileOverlayOpen}
          bugReports={bugReports}
          startInBug={card.bug}
          others={card.others}
          bugSignal={card.bugSignal}
          onClose={closeCard}
          onDone={finishCard}
          onOptOut={optOut}
          onStartSelf={startSelfFromBugCard}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
      {/* §13.9 update notice — portaled to <body>; renders nothing unless a release is unacknowledged. */}
      {authed && <WhatsNewNotice me={me} pathname={pathname} onClosed={() => setWhatsNewClosed(true)} suppressed={noticeSuppressed} />}
      {/* §23.7 achievement toast — one per page load, then the marker advances. */}
      {authed && <AchievementToast achievements={me?.newAchievements ?? null} />}
      {/* §14.12 real user monitoring — signed-in pages only; inert unless collection is on. */}
      {authed && <RumCollector config={me?.rum} />}
    </div>
  );
}

/** Bottom-left account menu: the signed-in user (name, avatar bubble) with What's new
 *  and Sign out. Falls back to the Phase 0 "Account" look while `me` hasn't loaded yet
 *  (or never will, e.g. a fetch error) — the person icon and generic label. */
function AccountMenu({
  me,
  survey,
  onTakeSurvey,
  canGiveFeedback,
  onGiveFeedback,
  onNotify,
}: {
  me: Pick<MeResponse, "user" | "gamification" | "agentsMenu"> | null;
  /** §13.10: while an offer is open, "Take the survey" leads the menu. */
  survey: SurveyOfferPayload | null;
  onTakeSurvey: () => void;
  /** §13.10: "Give feedback" (above Sign out) — hidden in the cooldown, with an offer open, or
   *  while the switch is off. */
  canGiveFeedback: boolean;
  onGiveFeedback: () => void;
  /** The shell's toast — a failed "Sign out everywhere" stamp is reported here. */
  onNotify: (message: string) => void;
}) {
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
          {survey && (
            <button
              type="button"
              className="user-menu-item"
              role="menuitem"
              data-testid="menu-take-survey"
              onClick={() => {
                setOpen(false);
                onTakeSurvey();
              }}
            >
              <StarIcon />
              Take the survey
              <span className="menu-dot" aria-hidden="true" />
            </button>
          )}
          <Link className="user-menu-item" role="menuitem" href="/profile" onClick={() => setOpen(false)}>
            <PersonIcon />
            My profile
          </Link>
          <Link className="user-menu-item" role="menuitem" href="/quick-start" onClick={() => setOpen(false)}>
            <CompassIcon />
            Quick start
          </Link>
          {/* §25.9: AI agents sits directly above What's new while the server is on or the person
              still holds a connection (so a leftover connection can always be revoked). */}
          {me?.agentsMenu === true && (
            <Link className="user-menu-item" role="menuitem" href="/agents" data-testid="menu-ai-agents" onClick={() => setOpen(false)}>
              <AgentIcon />
              AI agents
            </Link>
          )}
          <Link className="user-menu-item" role="menuitem" href="/whats-new" onClick={() => setOpen(false)}>
            <SparkIcon />
            What&apos;s new
          </Link>
          {canGiveFeedback && (
            <button
              type="button"
              className="user-menu-item"
              role="menuitem"
              data-testid="menu-give-feedback"
              onClick={() => {
                setOpen(false);
                onGiveFeedback();
              }}
            >
              <ChatIcon />
              Give feedback
            </button>
          )}
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
          {/* §3 "Sign out everywhere" — always the last item, below Sign out. Confirm, stamp
              users.sessions_valid_from through the API (every other device is signed out at its
              next request), then sign THIS browser out exactly like Sign out. A failed stamp
              keeps this session: the user is told and can retry. */}
          <button
            type="button"
            className="user-menu-item"
            role="menuitem"
            data-testid="menu-sign-out-everywhere"
            onClick={() => {
              setOpen(false);
              if (!window.confirm("Sign out of InnoBox on every device? Each of your other sessions ends at its next request, and this browser is signed out now.")) return;
              void postJson("/api/me/sign-out-everywhere", {}).then(
                () => signOut({ callbackUrl: "/" }),
                (err: unknown) => onNotify(err instanceof Error ? err.message : "Could not sign out everywhere"),
              );
            }}
          >
            <SignOutAllIcon />
            Sign out everywhere
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
          /* noCard (§13.8): this element already opens the account menu on click. The §23.6 ring
             shows your own level progress (medium while it is on, so the ring has room). */
          <AvatarBubble
            size={me.gamification ? "md" : "sm"}
            userId={me.user.id}
            displayName={displayName}
            noCard
            ring={me.gamification ? { level: me.gamification.level, progress: me.gamification.progress, top: me.gamification.level >= 10 } : null}
          />
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

/** §13.10 the bug button's glyph — drawn on currentColor, so it follows the theme. */
function BugIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 7.5V6a3 3 0 0 1 6 0v1.5" />
      <path d="M7.5 9.5a4.5 4.5 0 0 1 9 0V15a4.5 4.5 0 0 1-9 0V9.5Z" />
      <path d="M12 10.5V19.5" />
      <path d="M7.5 12H4M16.5 12H20M7.8 16.5 5 18.5M16.2 16.5 19 18.5M8 8.5 5.5 6.5M16 8.5l2.5-2" />
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

/** Sign out everywhere: the Sign out arrow with a second, trailing door — "all of them". */
function SignOutAllIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 4h3a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 16 20h-3" />
      <path d="M19.5 6.5v11" />
      <path d="M8 16l5-4-5-4" />
      <path d="M13 12H2" />
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

function AgentIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="8" width="14" height="11" rx="2.5" />
      <path d="M12 4v4M9.5 13h.01M14.5 13h.01M9.5 16.5h5M3 12.5v2.5M21 12.5v2.5" />
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

function StarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.5l-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.5z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
      <path d="M8.5 9.5h7M8.5 12.5h4.5" />
    </svg>
  );
}
