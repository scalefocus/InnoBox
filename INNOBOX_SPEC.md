# INNOBOX_SPEC.md — InnoBox

> **The authoritative specification.** Every change to app behavior lands here first,
> is reviewed and approved, and only then gets implemented. Code follows spec, never
> the reverse. `§n` references are internal to this document.
>
> Status: **v0.11 — draft for review** (2026-10-09; v0.2 added the UI and CI/CD
> sections; v0.3 pinned every externally-referenced convention inline, so the
> document is fully self-contained; v0.4 pinned the canonical production URL as
> deployment configuration (`PUBLIC_BASE_URL`), aligned §12.1 with the bundled
> delegated-Graph e-mail engine, and named the bundled implementation skills; v0.5
> synced the §2.2 token table to the scalify-ui brand sheet per the "skill wins"
> rule in §2.2; v0.6 pinned the Phase 1 identity decisions in §3/§4.2 and added
> `ENTRA_AUTH_SPEC.md` as the detailed identity integration spec; v0.7 pinned the
> §2.2 attribution rule and the §2.3 "no organization-specific values in the
> repository" rule for open-source readiness; v0.8 pinned the actual open-source
> release in **§21** — Apache-2.0, the brand as a removable default, GitHub as the
> new home, and the reframing of §2.2's attribution rule from a mention count into a
> fork-removability guarantee; v0.9 added eight operability and engagement features,
> each shipped as its own minor release in this order: rate limiting for search and SCIM (§2.4), the system
> log (§14.7), audit browser filters + CSV export (§15), the system banner (§14.6),
> "new since your last visit" markers (§13.1), the duplicate warning on submit (§6.1),
> per-event notification preferences and coalesced comment notifications (§12.1); v0.10
> added ten more features, each again shipped as its own minor release in this order:
> the submission lock (§6.4), the shared popover treatment (§2.2), a full Auth.js cookie
> sweep on sign-out and sign-in relinking of SCIM-provisioned accounts (§3), a CSP mode
> switch with a violation-report sink (§2.4), erasure with hand-over of open assignments
> (§3), identity-sync diagnostics (§14.10), a hash-chained, verifiable audit log (§15), a
> cards/list toggle on the Challenges gallery (§13.1), per-namespace channel webhooks to
> Teams or any JSON receiver (§12.4), and featured challenges on Home (§13.2); v0.11
> (2026-10-09) followed a full spec-vs-code audit: where the shipped behaviour was
> accepted the spec now describes it, and every place where the code still has to change
> is marked inline (see *Implementation gaps* below); a second pass re-triaged every
> marker against the code shipped since, deleted the closed ones, and wrote in the
> product owner's decisions and the defaults chosen where the spec was silent).
> Derived from the legacy
> Power Apps "InnoBox" canvas app (solution export `innobox-solution-master@e67e8ca94e4`)
> and a requirements interview with the product owner. This is a **brand-new
> development**: it serves the same business process but carries **no backwards
> compatibility** with, and no data migration from, the Power Apps app or its
> SharePoint lists.
>
> **Implementation gaps.** A block that starts **`⚠ GAP-nn`** marks a place where the
> shipped code does not yet do what the surrounding text says. The spec text is
> authoritative; the marker states what the code must change to match it. Markers are
> numbered across this document and `ENTRA_AUTH_SPEC.md`, and each is deleted in the
> same commit that closes it, so `grep -n "GAP-" INNOBOX_SPEC.md ENTRA_AUTH_SPEC.md`
> always lists exactly the open work.

---

## §1 What this is

**InnoBox** — an enterprise, self-hosted **challenge & solution management** platform:
employees raise **Challenges** (problems worth solving), colleagues propose
**Solutions**, a per-namespace review organization (admins + committee) triages,
validates, and drives the winning solution to implementation. Social signals (likes,
comments, follows), leaderboards, and notifications keep the innovation funnel alive.

Identity/access is anchored in **Microsoft Entra ID** (OIDC sign-in, SCIM 2.0
provisioning, group-based RBAC). The complete non-functional profile — architecture,
stack, UI system, deployment model, security invariants, and engineering process —
is pinned explicitly in §2 and §17; this document stands alone.

### §1.1 Terminology (legacy → new)

The Power Apps app mixed three names for the parent entity and two generations of
screens. The new vocabulary is fixed:

| Legacy term(s) | New term |
|---|---|
| innovation / problem / idea (parent entity) | **Challenge** |
| innovation solution / proposed idea (child entity) | **Solution** |
| reporter / inventor | **Author** |
| approval team / innobox admins (O365 group) | **Namespace Admin** (+ **Committee**, new) |
| "Anonymous Jedi" / "Anonymous Team" | **Anonymous** (neutral, corporate) |
| request number | **Challenge number / Solution number** (`CH-123`, `SOL-456`) |

Status renames are in §7.1/§8.1.

---

## §2 Architecture & non-functional requirements

TypeScript monorepo (pnpm workspaces — `@innobox/shared`, `@innobox/web`,
`@innobox/worker`), three processes + two stateful backends + a scanner:

- **`packages/web`** — Next.js (App Router) **standalone** server: UI + REST API +
  admin panel + OIDC (Auth.js/Entra). **Never Vercel.**
- **`packages/worker`** — standalone Node service: SCIM 2.0 endpoints, Entra
  reconciliation, ClamAV scan pipeline, notification dispatch (outbox), channel-webhook
  delivery (§12.4). **Singleton, leader-locked** via Postgres advisory lock. Its
  leader-only sweeps include the notification and webhook-delivery sweeps (every 30 s),
  the system-log alert (every 5 min, §14.7), and the **hourly housekeeping sweep**
  (presence rollup §14.5, system-log trim §14.7, webhook-delivery trim §12.4, stale
  upload sessions §11). Pure-DB sweeps are scheduled before the Entra-credential check,
  so a missing Graph/S3 configuration never skips them. Only work that calls Microsoft
  Graph (reconciliation, photo sync, the Graph mail transport) depends on the Entra
  credentials; the notification sweep (SMTP needs no Entra), the ClamAV scan sweep, and
  the draft and upload-session GC run regardless.
- **`packages/shared`** — domain types, RBAC resolution, state-machine logic,
  validation.
- **Postgres** — metadata, `tsvector` FTS, append-only `audit_log`.
- **S3/MinIO** — immutable attachment objects.
- **ClamAV** — attachment scanning.
- **Deployment** — docker compose stack (`postgres`, `migrate`, `minio`, `clamav`,
  `web`, `worker`, `proxy`); plain-SQL migrations in `db/migrations` applied in order
  by the `migrate` service.

Cross-cutting requirements:

- **Node 24 LTS** (the runtime images, `.tool-versions`, CI, and `engines` all name the
  same major), pnpm 9.x pinned via `packageManager`; TypeScript everywhere, ESM. The
  platform tracks a Node line that is still receiving security fixes: Node 20 reached
  end-of-life in April 2026, and moving to the next LTS line before the current one's
  end-of-life is a routine maintenance task, not a feature.
- Parameterized SQL through a thin query layer; no ORM magic.
- Secrets via env / mounted files only; never in images or the repo.
- Structured JSON logs; health `/healthz`, readiness `/readyz`, Prometheus `/metrics`
  on **both** web and worker. `/metrics` emits the Prometheus text exposition format:
  `innobox_build_info{version,service}`, `innobox_up`, process memory/uptime gauges,
  (web) `innobox_csp_violations_total{directive}` (§2.4), and (worker)
  `innobox_worker_leader` plus notification- and scan-sweep counters and
  `innobox_webhook_deliveries_total{outcome}` (§12.4). When
  `METRICS_TOKEN` is set, `/metrics` requires `Authorization: Bearer <token>` (401 otherwise),
  compared in **constant time**. When it is unset, `/metrics` is open **only outside
  production** (local dev); in a production build (`NODE_ENV=production`) an unset token
  **disables** the endpoint (404) rather than exposing it, so forgetting the variable can
  never publish process details through the public proxy. `/healthz` and `/readyz` stay
  unauthenticated (orchestrator probes) but return **only** a status word
  (`ok` / `not_ready`) and the failing check's name — never an exception message,
  host, role, or other connection detail; the detail goes to the structured log.
- **Timestamps: store UTC (`timestamptz`), serialize UTC ISO, convert in the browser**
  via a shared formatter. Display style (EU dd/mm/yyyy 24h vs US mm/dd/yyyy AM/PM) is
  a platform setting (§14.3).
- `APP_VERSION` in `packages/shared/src/version.ts`, shown in the sidebar colophon;
  bumped on every behavior change; matching entry in the **What's new** changelog
  (`/whats-new`) in the same commit. Commit subjects `type(scope): summary (vX.Y.Z)`.
- Gated spec-first change workflow, release ritual, and testing bar: §17.

### §2.1 Platform invariants (non-negotiable)

1. **Roles resolve from SCIM-synced group membership + `role_mappings`, never from
   OIDC token claims** (Entra group-claim overage).
2. **All access is auth-required and strictly visibility-filtered.** A
   namespace-restricted challenge must never leak through lists, search,
   autocomplete, counts, KPIs, leaderboards, notifications, or outbound channel
   webhooks (§12.4) to users outside its namespace (§4.3). The **sole** unauthenticated surface is the Home route (`/`),
   which doubles as the sign-in landing: while unauthenticated it renders a static
   welcome and the sign-in control **only** — no challenge/solution/user data, KPIs,
   counts, spotlights, search, or notifications are fetched or shown (§2.2, §13.2).
3. **Anonymity is enforced at the API layer, everywhere** — lists, details, search,
   exports, e-mails, in-app notifications, and webhook payloads (§12.4). The true
   identity is stored but is exposed
   only through the audited admin **reveal** action (§9).
4. **Attachments are served only through the authenticated fetch gateway** — no
   direct object-store URLs — and become visible only after a clean ClamAV scan (§11).
   Attachment rows are permanent tombstones; the **sole** exception is the
   platform-admin delete cascade (§10.3), which removes them with their parent.
5. **`audit_log` is append-only.** App DB role lacks UPDATE/DELETE; a trigger enforces
   it too (§15); rows written since the chain migration are SHA-256 hash-chained by a
   database trigger and verifiable from the audit browser (§15).
6. **Status transitions follow the enforced state machines** (§7.2, §8.2) for
   committee members and assignees; namespace/platform admins may set any status
   freely — every transition, enforced or override, is audited with `from → to` and
   actor.
7. **At most one Solution per Challenge advances past `valid`** (single accepted
   solution, §8.3).

### §2.2 UI & design system

The **InnoBox brand** — the corporate brand of the organization that created it,
carried over unchanged in every visual respect. **The token table below is the sole
authority** for the palette, and this section for typography and assets: the
`scalify-ui` skill that previously held that role is not part of the repository
(§21.4) and no longer overrides this document. Typography: **Montserrat**
(display/headings), **Open Sans** (body), **JetBrains Mono** (numbers, IDs,
metadata — a deliberate technical extension; the brand book defines no mono face).
Fonts are **self-hosted** via `@fontsource-variable` packages — no external font
CDNs. Body text 15 px / 1.55 line-height, antialiased.

**Design tokens** live as CSS variables in a single `globals.css`; **light + dark
themes** switch via a `[data-theme]` attribute with a user toggle, `color-scheme`
set per theme. No CSS framework (no Tailwind/MUI) — plain CSS on the tokens,
including theme-aware scrollbars and form controls. Pinned values:

| Token | Light | Dark |
|---|---|---|
| `--paper` (page background) | `#F1F2F2` | `#1A1A1A` |
| `--surface` / `--surface-2` (cards) | `#FFFFFF` / `#F8F9F9` | `#232529` / `#2B2E33` |
| `--ink` (text) | `#1A1A1A` | `#F1F2F2` |
| `--muted` / `--faint` (secondary text) | `#58595B` / `#909193` | `#A7A9AC` / `#6E7073` |
| `--line` / `--line-strong` (borders) | `#E2E3E4` / `#D1D3D4` | `#303236` / `#404349` |
| `--anchor` (brand navy) | `#082773` | `#9DB4E8` |
| `--accent` / `--accent-2` (brand cyan) | `#14ABE3` / `#0E87B5` | `#2FBCF0` / `#6CD0F7` |
| `--accent-ink` / `--accent-soft` | `#FFFFFF` / `#DCF2FB` | `#06202C` / `#10303E` |
| `--ok` / `--ok-soft` | `#049C70` / `#D9F7EC` | `#00CB91` / `#0D2B22` |
| `--warn` / `--warn-soft` | `#C97A1F` / `#FFEDD9` | `#FFA652` / `#2E2214` |
| `--danger` / `--danger-soft` | `#E5343D` / `#FFE1E3` | `#FF5860` / `#331518` |
| `--radius` / `--radius-sm` / `--radius-lg` | `14px` / `9px` / `22px` | same |

- **Status colors** map to the semantic tokens — `--ok` for valid/implemented,
  `--warn` for in-review/needs-improvement, `--danger` for rejected, `--accent` for
  informational states. The legacy Power Apps hex palette is not carried over.
- **Dropdowns (`<select>`)** are de-chromed (`appearance: none`, native `::-ms-expand`
  hidden) and given a single custom down-chevron drawn as a background-image SVG on
  `select.field`, so every dropdown looks the same in both themes rather than falling
  back to the browser/OS arrow. The chevron is inset from the right edge by roughly the
  same margin it has from the top and bottom (≈12 px, optically balanced) — not crammed
  against the edge — and the option text is right-padded so long labels never slide under
  it. It uses `--faint` at rest, `--accent-2` on focus, and dims when disabled; because a
  background-image SVG can't read CSS variables, its color is theme-swapped under
  `[data-theme="dark"]`. This is the only select-styling path (the earlier unused
  `.select-wrap`/`.select-chevron` chevron-element rules are dropped).
- **Pill switches (`.toggle`)** are the one control for any on/off state: a 58×30 track
  with a 24 px knob that springs across on change, `role="switch"` + `aria-checked`, and a
  state glyph inside the knob. The knob position is driven by the control's **own
  `aria-checked`**, not by an ambient document attribute, so a single rule serves every
  switch on a page and two switches never move in lockstep. The one exception is a
  **pre-hydration fallback** scoped to the theme switch alone: `[data-theme]` is set by an
  inline script before paint whereas the button's `aria-checked` is only correct after
  mount, so without it the knob would animate across on every dark-mode page load. It
  applies the same transform, so hydration merely swaps which rule matches and nothing
  visibly moves. The switches in v1 are the topbar **theme** toggle (☀️/🌙 — its track
  stays `--surface-2` in both states, because the whole page already reports which theme
  is active) and the **preference** switches: on the profile (§13.5) the e-mail
  notifications switch and the three §12.1 per-event toggles, and on the Administration
  console each channel webhook's **enabled** switch (§12.4). A *preference* switch,
  whose state nothing else on the page reveals, additionally fills its track with
  `--accent` when on and carries a visible `On`/`Off` word to the left of the pill. **Travel direction is per-switch, not global:** the theme
  toggle slides right for dark (the knob follows the page getting darker), while every
  preference switch slides **left for on and right for off**, so its knob comes to rest
  beside the `On`/`Off` word rather than away from it. This is a deliberate divergence from
  the more common on-is-right convention; a switch therefore declares its own direction and
  never inherits one.
- **App shell:** persistent left-sidebar navigation; the sidebar colophon shows
  `APP_VERSION` above **"Created by Scalefocus"** and, below it, **"Powered by the
  community"** — three stacked lines, the two attribution lines sharing the same
  `.colophon-sub` treatment, both plain text (no links); the account menu carries the
  **Quick start** and **What's new** links; fully responsive. The shell renders in
  three states keyed on the session:
  - **Authenticated** — unchanged from the signed-in experience: full nav (Home,
    **Submit a Challenge**, Challenges, Leaderboard, plus **Triage** and
    Administration for admins — both carrying the §14.4 attention bubble),
    the account menu
    (display name + initials avatar, with My profile / Quick start / What's new /
    Sign out) in the sidebar foot, and the topbar search + notification bell +
    theme toggle — plus the §14.6 **system banner** pill between search and bell
    while one is active.
  - **Unauthenticated** — the wordmark and version colophon only, **no nav links**,
    and a primary **"Sign in with Entra ID"** button occupying the exact sidebar-foot
    slot the account menu uses when signed in; the topbar shows only the theme toggle
    and, on mobile, the drawer toggle (search and bell are hidden). On mobile the
    sidebar is the off-canvas drawer as usual, so the signed-out drawer holds the
    wordmark, the sign-in button and the colophon — the drawer toggle is the only route
    to sign-in there and is therefore kept. The button starts Entra OIDC sign-in and
    honors a `callbackUrl` (default `/`). The accompanying main area is the §13.2 landing.
  - **Loading** — neutral (no nav, no foot control) until the session resolves, so
    the shell never flashes the wrong state.
  There is **no** separate Auth.js sign-in page: the "Sign in with Azure Active
  Directory" default page is removed in favor of this in-shell control (§5 of
  `ENTRA_AUTH_SPEC.md`).
- **Breadcrumbs:** a section's sub-pages render a breadcrumb back to the section root
  above the page title, via a shared component — currently the Administration
  console's sub-pages (§14). Shown only once the viewer passes the page's access gate.
- **Popovers — one shared treatment.** Every popover — any floating panel anchored to
  a trigger, opened and closed in place (menus, dropdown result lists, hover/focus
  cards, pickers) — carries the shared `.menu-pop` class and nothing bespoke:
  - **Open:** a **~120 ms** ease-out **fade + scale** (opacity 0 → 1, scale 0.96 → 1,
    with a ~6 px travel toward the trigger; each popover sets `--menu-pop-y` and
    `transform-origin` for the side it opens on). It plays **once, on mount**. A popover
    whose content refreshes while open (e.g. autocomplete results) does not replay it.
  - **Close:** **instant** (unmount). There is no exit animation.
  - **`prefers-reduced-motion: reduce`:** no animation at all, open or close.
  - **Chrome:** `--surface` fill, `--line-strong` border, `--radius-sm`, `--shadow`,
    defined **once** on the shared class. List popovers (menus, result lists, pickers)
    add 5 px inner padding and rounded per-row hover. Content popovers — the §13.8
    directory card and the notification panel — keep their own content padding. This is
    the account-menu look §7.3 already calls the standard popover chrome.
  - **In scope today:** the account menu, the notification panel (desktop), the §7.3
    assignee search on the challenge detail page, the §14.1 triage assignee pickers
    (filter-by-assignee, bulk-assign, per-row assign), the §13.8 directory card, and the
    **topbar search autocomplete** (§13.4). Any future popover joins this list by
    construction.
  - **Explicit exceptions:** native `<select>` lists and `window.confirm` dialogs
    (OS-drawn), the mobile nav drawer, and the mobile full-screen notification
    **sheet**. The sheet keeps its own slide-up (~220 ms, also silenced under reduced
    motion) because it has no anchor to scale from. Inline expanders
    (the §10.3 danger zone, admin card collapse) are not popovers.
- **Submission lock:** the author submit paths (challenge form, solution form,
  Resubmit) cover their form with a `.form-lock-scrim` while the request is in flight —
  `--surface` at ~60% opacity, `cursor: progress`, no new token; one shared component
  serves all three (§6.4).
- **Segmented view toggles** reuse the existing `.sort-toggle` look, each option
  `aria-pressed` — e.g. the Challenges gallery's **Cards | List** toggle (§13.1).
- **Identity:** InnoBox has its **own wordmark/mark** — the official `innobox`
  logotype (deep navy, with the terminal `o` rendered as an orange box). The sidebar
  renders the wordmark image from `packages/web/public/brand`, with two theme variants
  that swap on `[data-theme]` (navy on light, white on dark). The browser icon
  (`app/icon.svg`) is the standalone orange **box** mark with a hollow centre. The
  corporate eye logo is not reused as an app logo.
- **Social-share (Open Graph) card:** link unfurls (Teams, Slack, and similar) show a
  single, **static, app-level** card — a **1200×630** image on a deep-navy field with
  the white `innobox` wordmark (orange `o`-box) and the product tagline, checked in
  under `packages/web/public/brand`. The root layout sets `metadataBase` (derived from
  `PUBLIC_BASE_URL`, §2.3) and the full Open Graph set (`og:title`, `og:description`,
  `og:type` = `website`, `og:url`, `og:site_name` = "InnoBox", and `og:image` → the
  card) plus the matching Twitter tags (`twitter:card` = `summary_large_image`,
  `twitter:title`, `twitter:description`, `twitter:image`). **There are deliberately no
  per-challenge/per-solution preview images:** every route except the Home page (`/`)
  redirects an unauthenticated request to `/` (invariant 2), so an OG scraper — always
  unauthenticated — can never reach resource content, and generating per-resource cards
  would leak titles/authors/namespaces in violation of invariants 2 and 3. The card
  **image asset** lives under the already-public `/brand/` tree (opened for the sidebar
  wordmark; `isPublicPath` in `routeAccess.ts`, §5 of `ENTRA_AUTH_SPEC.md`), so an
  always-unauthenticated scraper can fetch it — a static brand asset, no data.
- Dates/times render through the shared client-side formatter honoring the EU/US
  platform setting (§2); rich text is not required for v1 (plain text with line
  breaks).

**Attribution (removability rule).** InnoBox is released as open source under
Apache-2.0 (§21). Apache-2.0 §6 grants no trademark rights, so the creating
organization's name and marks are **not** licensed to downstream users — a fork
must be able to strip them, and this rule exists to make that a *one-edit*
operation rather than an archaeology exercise. The organization's name — 
**"Scalefocus"** — therefore appears in a **closed, enumerated set of places**:

| Where | Why |
|---|---|
| The sidebar colophon line "Created by Scalefocus" | The shipped attribution (§2.2 app shell). The one product surface. |
| `packages/web/e2e/discovery.spec.ts` | The e2e assertion that the colophon renders. A known, deliberate second occurrence — not a blind spot. |
| `LICENSE` and `NOTICE` | Apache-2.0 copyright holder. Legal files, not product surfaces (§21.1). |
| The passages of this spec and `CLAUDE.md` that *define* this rule | A rule cannot state itself without naming its subject. |

Nowhere else — not in page copy, e-mails, notifications, exports, metadata, log
output, code comments, other tests, fixtures, configuration defaults, or other
documentation. Prose that would otherwise name the company refers to "the
organization" or "the InnoBox brand". Values a deployment supplies at runtime
(§2.3) are likewise absent from the repository, living only in the uncommitted
`deploy/.env`.

**This is a naming rule only. Every visual aspect of the brand is unchanged** —
palette, Montserrat/Open Sans/JetBrains Mono typography, logo assets, the token
table above. The brand ships as the default look; forks are free to replace it, and
§21.2 pins the exact file list that a rebrand touches.

A **repository hygiene unit test** (`packages/web/src/lib/attribution.test.ts`)
enforces the rule. It scans the whole `packages/**` tree — source, tests, e2e,
fixtures, and configuration alike, excluding only build output and `node_modules` —
case-insensitively, and fails on any occurrence outside an allowlist of exactly the
two product-tree entries above. Its existing guard against a vacuously-empty scan is
retained. The scanner's previous `packages/*/src/**` scope silently excluded `e2e/`,
which is how the `discovery.spec.ts` occurrence went unrecorded; widening the scope
and allowlisting that file explicitly closes the gap in both directions.

### §2.3 Source control, CI/CD & environments

The delivery pipeline, pinned:

- **Canonical production URL:** supplied by the deployment as **`PUBLIC_BASE_URL`**
  — the repository pins no host. The OIDC and e-mail-consent redirect URIs, the SCIM
  `documentationUri`, the Open Graph `metadataBase`, and all notification deep links
  derive from it. TLS terminates at the org reverse proxy in front of the compose
  stack (which serves internally on :8080).
- **No organization-specific value lives in the repository** (open-source
  readiness, §2.2 attribution rule). Concretely:
  - **No org-specific fallbacks in code.** Web and worker read the canonical URL
    through **one `publicBaseUrl()` helper in `@innobox/shared`** — e-mail and
    notification deep links, channel-webhook item links, the e-mail consent redirect,
    the Open Graph `metadataBase`, and the SCIM `serviceProviderConfig.documentationUri`
    all take it from there; no other variable (`NEXTAUTH_URL` included) is consulted as
    a fallback. Outside production (`NODE_ENV !== "production"`) an unset or blank
    `PUBLIC_BASE_URL` falls back to `http://localhost:3000`. **In production an unset or
    blank `PUBLIC_BASE_URL` is a start-up refusal**: web (in the instrumentation
    `register` hook) and worker each log a fatal structured error naming the variable and
    exit 1 — the same guard pattern as the `INNOBOX_DEV_AUTH` / `CSP_MODE` refusals below
    and the tenant guard (`ENTRA_AUTH_SPEC.md` §5), so a missing URL fails the `/readyz`
    smoke check instead of shipping empty links. (The edge-middleware consumers — the
    CSRF origin check, the CSP report endpoint and HSTS, §2.4 — follow the same
    variable; in local dev with it unset they use the request's own origin.)
    `SMTP_FROM` has no baked-in address — when unset or blank it falls back to
    `SMTP_USER`, and if both are unset the SMTP transport is treated as **not
    configured** (the Graph transport and the in-app inbox are unaffected). Web and
    worker apply the one rule: SMTP counts as configured only with `SMTP_HOST` **and** a
    sender (`SMTP_FROM` or `SMTP_USER`), blank values counting as unset; compose passes
    `SMTP_USER` and `SMTP_FROM` to both services.

    > **⚠ GAP-04 · code fix:** (a) there is no shared helper. `app/layout.tsx` uses
    > `PUBLIC_BASE_URL ?? "http://localhost:3000"` regardless of `NODE_ENV`;
    > `lib/security-headers.ts` `canonicalBaseUrl()` (behind `lib/email.ts`
    > `webBaseUrl()`), `lib/csrf.ts` `allowedOrigins()`, `lib/auth-cookie-sweep.ts` and
    > `api/admin/webhooks/responses.ts` fall back to `NEXTAUTH_URL`; the worker passes
    > `PUBLIC_BASE_URL ?? ""` to the notification sweep (`worker/src/index.ts`) and the
    > webhook sweep (`webhooks/deliver.ts` `startWebhookSweeps`), and
    > `scim/resources.ts` reads the variable directly. Add `publicBaseUrl()` to
    > `@innobox/shared`, route every consumer through it, drop the `NEXTAUTH_URL`
    > fallbacks, and add the production refusal to `web/src/instrumentation.ts` and the
    > worker's start-up. (b) Web: `lib/email.ts` sets `smtpConfigured` from `SMTP_HOST`
    > alone — reuse the worker's `buildSmtpEnv` rule (`worker/src/notifications/smtp-env.ts`,
    > moved to `@innobox/shared`), and pass `SMTP_USER` / `SMTP_FROM` to the `web`
    > service in `deploy/docker-compose.yml`.
  - **Committed files carry placeholders, never real values** — `deploy/.env.example`,
    `docker-compose.yml`, the `Caddyfile`, the `Jenkinsfile`, `README.md`, and the
    specs use `https://innobox.example.com`, `innobox@example.com`, and
    `<your-git-host>` in prose, examples, and comments. Test fixtures use addresses
    on reserved example domains only — `example.com` or the `.test` top-level domain
    (`@example.test`) — plus the dev sign-in default `dev@innobox.innovate`, which
    names the product, not a deployment. The same rule binds product code: the
    synthetic user name of a dev sign-in persona is `<slug>@dev.test`.

    > **⚠ GAP-05 · code fix:** non-reserved domains remain. Product code:
    > `web/src/lib/users.ts` builds the dev persona's `userName` as `<slug>@dev.local` —
    > make it `@dev.test`, with `lib/users.test.ts` and `e2e/helpers/auth.ts` (which
    > fills `@dev.local`). Fixtures → `@example.com`: `@contoso.com`
    > (`worker/src/scim/filter.test.ts`, `resources.test.ts`, `scim.dbtest.ts`),
    > `a@x.com` / `b@x.com` (`resources.test.ts`), `a@b.com`
    > (`worker/src/notifications/dispatch.test.ts`) and `svc@corp.com`
    > (`shared/src/email-graph.test.ts`).
  - **Real values reach production only through the Jenkins credentials vault** —
    the `innobox-deploy-env` secret file (the production `deploy/.env`, carrying
    `PUBLIC_BASE_URL`, `SMTP_FROM`, and every secret) plus the `innobox-deploy-host`,
    `innobox-deploy-path`, `innobox-repo-url`, and `innobox-deploy-ssh` credentials.
    Nothing environment-specific is a build parameter or a repo literal.
- **Source control:** the **public GitHub repository** under the organization's
  GitHub org is the canonical home (§21.4). `main` is the release branch; feature
  branches merge to `main`. The deploy host still clones from the
  `innobox-repo-url` credential, whose *value* is the GitHub clone URL. Because the
  repository is public the clone and fetch are **anonymous** — the pipeline carries no
  git token (§21.4) and re-points an existing checkout's `origin` on every deploy.
- **CI (GitHub Actions — `.github/workflows/ci.yml`):** runs on every push and pull
  request. Mirrors the Jenkins CI stages below (install → build → typecheck → lint →
  unit tests), which is what a reader of the public repository can actually see and what
  proves the tree is green. The **live-DB integration suite** runs on a `postgres:16`
  service container with the least-privilege app role created and all
  `db/migrations/*.sql` applied in order. `.gitlab-ci.yml` is removed — it mirrors
  stages nobody outside the organization can run and duplicates the Actions
  workflow.

  > **⚠ GAP-06 · code fix:** the `build` job in `.github/workflows/ci.yml` builds only
  > `@innobox/shared` and `@innobox/web`; it must run the recursive `pnpm -r build`, so
  > the worker is built too.
- **CI (Jenkins declarative pipeline) — retained for deploy, and as the internal
  pre-deploy gate:** stages —
  **Toolchain** (asdf-provisioned Node 24 from `.tool-versions`, corepack-pinned
  pnpm) → **Install** (`pnpm install --frozen-lockfile`) → **Build** (recursive;
  `shared` builds first) → **Typecheck** (recursive) → **Lint** (recursive) → **Unit tests** (recursive;
  hermetic — live-DB suites self-skip) → **DB integration tests** (parameter-gated:
  ephemeral `postgres:16-alpine` container, least-privilege app role created,
  all `db/migrations/*.sql` applied in order, integration suites run against it,
  container always cleaned up).
- **Deploy (gated to `main`, or manual trigger; never a pull-request build):**
  Docker-over-SSH remote model, no image registry — Jenkins SSHes to the deploy host,
  fast-forwards the checkout to the exact built commit (anonymous fetch from the public
  repository), copies the production
  `deploy/.env` from the **Jenkins credentials vault** (secret-file credential;
  the file is never in git), runs `docker compose up --build -d` on the host,
  idempotently ensures the MinIO bucket, and smoke-checks `/readyz` before the
  pipeline goes green. If `/readyz` never answers `ok` within the retry window, the
  stage **fails**.
- **Jenkins credentials vault entries:** `innobox-deploy-env` (secret file — the
  production env), `innobox-deploy-ssh` (SSH key to the deploy host), and the
  `innobox-deploy-host` / `innobox-deploy-path` / `innobox-repo-url` strings. No secret
  ever appears in the repo, images, or build logs.
- **Dev/e2e auth bypass — fail-closed by construction.** The `INNOBOX_DEV_AUTH`
  flag enables the Playwright/dev credentials sign-in locally and in e2e runs. It is
  guarded by **two** conditions, not one: the flag *and* `NODE_ENV !== "production"`.
  Because the Dockerfile builds a Next standalone production bundle, `NODE_ENV` is
  `production` in every shipped container, so the credentials provider is **never
  registered** there and the flag is inert regardless of how the environment is
  configured. Now that the source is public, this guarantee is load-bearing and
  stated here deliberately: it is a **structural** guarantee, not an operational
  one, and it must not be weakened. Setting the flag in a production deployment
  remains forbidden (deploy env review stays in the release checklist), but a
  mistake there is no longer sufficient to open a bypass. **No evaluation/demo mode
  ships** (§19, §21.8) — precisely because the only way to build one on this flag
  would be to punch a hole in that second condition.
  **The mistake is also loud, not silent:** a production build that finds
  `INNOBOX_DEV_AUTH` set in its environment **refuses to start** (web logs a fatal
  structured error naming the variable and exits non-zero). The structural guard above
  is unchanged and remains the actual protection; the refusal exists so a bad deploy env
  fails the `/readyz` smoke check instead of shipping a misconfiguration nobody noticed.
  **`CSP_MODE=off` gets the same treatment** (§2.4): a production build that finds
  it — or any value other than `enforce` / `report-only` / `off` — logs a fatal
  structured error naming the variable and exits non-zero. A deployment can switch to
  `report-only` while tuning a policy but can never ship without one. `report-only`
  itself is permitted in production: it is a deliberate rollout state, visible in the
  response headers.
- **Deployment variables added in v0.10** — each documented, commented, with its
  default, in `deploy/.env.example`, passed through by `docker-compose.yml`, and supplied
  in production through the existing `innobox-deploy-env` secret file (no new Jenkins
  credential ID):
  - **`CSP_MODE`** (web) — `enforce` (default) | `report-only` | `off` (§2.4); `off` or
    an unknown value refuses to start in a production build (above).
  - **`WEBHOOK_ENC_KEY`** (web **and** worker) — 32 bytes, base64 (`openssl rand
    -base64 32`); encrypts channel-webhook URLs at rest (§12.4). Unset or invalid →
    webhooks are off. Compose passes `${WEBHOOK_ENC_KEY:-}` to both services.
  - **`TRUST_PROXY`** — now read by **web** as well as the worker, for the CSP report
    sink's per-IP key (§2.4); compose passes the same `${TRUST_PROXY:-1}` to `web`.
  - **Egress:** web and worker need outbound HTTPS (443) to channel-webhook receivers
    (Teams Workflows URLs are on `*.logic.azure.com` or
    `*.environment.api.powerplatform.com`). No forward-proxy support in v1 (§12.4).
- **Object-store credentials:** `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are optional
  overrides in `deploy/.env` that default to the MinIO root credentials
  (`MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`). Compose wires them into **web and
  worker** as `S3_ACCESS_KEY: ${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER:-innobox}}` and
  `S3_SECRET_KEY: ${S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD}}`, so setting the
  overrides points both services at a separate key without touching how MinIO itself
  starts. `deploy/.env.example` documents both as optional.

  > **⚠ GAP-08 · code fix:** `deploy/docker-compose.yml` wires `S3_ACCESS_KEY` /
  > `S3_SECRET_KEY` for `web` and `worker` straight from `MINIO_ROOT_*`, so the
  > documented `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` overrides do nothing. Use the
  > nested defaults above for both services.

### §2.4 Web security baseline

Cross-cutting rules for every HTTP response and every API request served by the web
tier. They sit beside the invariants (§2.1): the invariants say *what* must never leak;
these rules close the generic web-platform paths by which it could.

- **Response headers (every response, pages and API):**
  - `Content-Security-Policy` — `default-src 'self'`; `script-src 'self' 'nonce-<per-request>'
    'strict-dynamic'`; `style-src 'self' 'unsafe-inline'` (inline `style` attributes);
    `img-src 'self' data: blob:`; `font-src 'self'` (fonts are self-hosted, §2.2);
    `connect-src 'self'`; `object-src 'none'`; `base-uri 'none'`; `frame-ancestors 'none'`;
    `form-action 'self' https://login.microsoftonline.com` (the OIDC sign-in redirect).
    The nonce is minted per request by the middleware and applied to the framework's own
    inline scripts and to the theme-init script, so **no** `'unsafe-inline'` script source
    exists. Local dev additionally allows `'unsafe-eval'` and the HMR websocket — never in
    a production build. In the `enforce` and `report-only` modes (below) the policy
    also carries `report-uri /api/csp-report` and `report-to csp`, and the response
    carries the companion `Reporting-Endpoints: csp="<origin>/api/csp-report"`, where
    `<origin>` is the origin of `PUBLIC_BASE_URL` (in local dev with it unset, the
    request's own origin; §2.3). Both are sent because
    browsers differ: the Reporting API (`report-to`) delivers only to `https`
    endpoints and batches, while the legacy `report-uri` covers the rest.
  - **CSP mode — `CSP_MODE=enforce | report-only | off`** (env, default **`enforce`**).
    It governs **only** the page/API policy above. The §11 attachment-download policy
    (`sandbox; default-src 'none'`) is a file-serving control and stays **enforced in
    every mode**. Every other header in this list is also unaffected, including
    `X-Frame-Options: DENY`, which keeps anti-framing in force.
    - `enforce` — the policy is sent as `Content-Security-Policy` (the v0.9 behaviour).
    - `report-only` — the identical policy (same directives, same per-request nonce,
      same report endpoints) is sent as `Content-Security-Policy-Report-Only` instead,
      and **no** enforcing `Content-Security-Policy` is sent. This is the rollout
      switch for a policy change: violations are counted, nothing is blocked.
    - `off` — neither header (nor `Reporting-Endpoints`) is sent. **Local dev and e2e
      only:** a production build that finds `CSP_MODE=off` **refuses to start** (§2.3,
      the same fail-loud startup check as `INNOBOX_DEV_AUTH`). An unrecognised value is
      the same startup error in a production build, and is treated as `enforce`
      (with a structured warning) outside production.

    In every mode the middleware still mints the nonce and hands the policy to the
    renderer on the request side. The framework's inline scripts and the theme-init
    script therefore stay nonce-tagged, and switching modes needs no rebuild. (The
    implementation verifies that the renderer still applies the nonce when the response
    header is report-only.)
  - **CSP violation reports — `POST /api/csp-report`** (the report sink). The **one
    public API endpoint**: browsers send reports without a session, so it is on the
    public-path allowlist (no session required) and **exempt from the CSRF `Origin`
    check** below (a report carries no reliable `Origin` and changes no application
    state). Its rules:
    - **Accepts** `application/csp-report` (the legacy `report-uri` body,
      `{"csp-report": {…}}`) and `application/reports+json` (the Reporting API body —
      an array of reports, of which only `type: "csp-violation"` entries are counted;
      others are ignored). `application/json` is accepted and parsed as either shape.
      Any other content type → **415**; any method but `POST` → **405**.
    - **Body cap 64 KB** (not the 1 MB JSON limit), enforced before the body is read
      (from `Content-Length`, and by a running byte count when it is absent) → **413**.
      A body that does not parse, or matches neither shape → **400**. Otherwise **204**
      with an empty body.
    - **Rate limit — per client IP, not per user** (there is no user): **120 requests
      per minute**, token bucket, held in the web process like the other web buckets
      (reset on restart; scaled by `RATE_LIMIT_MULTIPLIER` outside production only).
      The client IP is the `X-Forwarded-For` entry selected by `TRUST_PROXY` with the
      worker's semantics (below, *SCIM rate limiting*). When no address can be
      determined (e.g. the org proxy forwards none), all such requests share one
      bucket, which can only under-count. Exceeded → **429** with `Retry-After`.
      Dropping a report only under-counts a metric, so 429s here are **not** logged
      individually.
    - **Never stores a report.** No body, URL, `blocked-uri`, sample or user agent is
      persisted or logged — a report can carry fragments of page content and URLs. The
      only effect is the Prometheus counter **`innobox_csp_violations_total{directive}`**
      on the web `/metrics` (§2), incremented once per violation (a Reporting API
      batch of *n* violations counts *n*). `directive` is the report's
      `effective-directive` (legacy) or `body.effectiveDirective` (Reporting API),
      lower-cased and mapped onto a **fixed allowlist**: `default-src`, `script-src`,
      `script-src-elem`, `script-src-attr`, `style-src`, `style-src-elem`,
      `style-src-attr`, `img-src`, `font-src`, `connect-src`, `media-src`, `object-src`,
      `frame-src`, `child-src`, `worker-src`, `manifest-src`, `base-uri`,
      `form-action`, `frame-ancestors`. Anything else becomes `other`, so an
      unauthenticated caller can never mint new label values. The counter is in-process
      (resets on restart), like every other web-tier counter.
    - **Not recorded in the system log (§14.7)** — none of its responses, its 413 and
      429 included — and **not audited**: an unauthenticated endpoint must not be a
      write path into either table. The handler is deliberately not wrapped by the
      system-log capture and never throws (every failure resolves to one of the
      statuses above).
  - `Strict-Transport-Security: max-age=31536000` whenever `PUBLIC_BASE_URL` is `https`
    (no `includeSubDomains`/`preload` — those are decisions for the deployment's own
    domain, made at the org proxy).
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (legacy companion to
    `frame-ancestors`), `Referrer-Policy: strict-origin-when-cross-origin`,
    `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that denies
    camera, microphone, geolocation, payment, and USB.
  - No `X-Powered-By` (web or worker).
  - Attachment downloads add their own stricter policy (§11 *Download gateway*).
- **Cross-site request forgery.** Session cookies are `SameSite=Lax`, which stops other
  sites but not a sibling sub-domain of the same registrable domain. So every
  state-changing API request (`POST`/`PUT`/`PATCH`/`DELETE` under `/api/*`, except the
  Auth.js routes under `/api/auth/*`, which carry their own CSRF token, and the public
  CSP report sink `/api/csp-report` — exact path — which changes no application state)
  must carry an `Origin` header equal to the origin of `PUBLIC_BASE_URL`; a missing or
  different `Origin` is rejected with **403** before the route runs. Endpoints that take
  a JSON body additionally require `Content-Type: application/json` (**415** otherwise),
  so a plain HTML form cannot forge one. Safe methods (`GET`/`HEAD`) never change state.
  The JSON `Content-Type` rule likewise does not apply to the report sink, which takes
  the two CSP report media types instead (above).
- **Request body limits** — enforced **before** a body is read into memory (from
  `Content-Length`, and by a running byte count when it is absent), answering **413**:
  - JSON bodies: **1 MB**.
  - Single-shot attachment upload (§11): the chunk size plus 64 KB of multipart
    overhead — anything larger must use the chunked protocol anyway.
  - Chunked-upload part (§11): the session's negotiated chunk size.
  - The bundled reverse proxy enforces a site-wide outer cap as a backstop:
    `request_body { max_size {$PROXY_MAX_BODY_SIZE:201MiB} }` — by default the 200 MB
    settings ceiling for the maximum upload size plus 1 MB, since the proxy cannot read
    the runtime setting; an operator who pins a lower maximum may tighten it through
    `PROXY_MAX_BODY_SIZE`. The per-route limits above are the real ones.
  - The CSP report sink: **64 KB** (above).
- **Outbound requests.** The only user-configured outbound HTTP the platform makes is
  the channel webhook (§12.4). It is `https` on port 443 only, refuses private,
  loopback, link-local and other non-public addresses after DNS resolution, connects to
  the vetted address, follows no redirects, ignores proxy environment variables, and
  times out after 10 s.
- **Rate limiting** — per signed-in user, token-bucket, held in the web process
  (v1 runs one web instance; the buckets reset on restart, which is acceptable for an
  abuse brake). Limits:
  - creating a challenge or solution — **30 per hour**;
  - posting a comment — **60 per hour**;
  - starting an upload (single-shot or chunked initiate; parts are bounded by the
    declared size instead) — **60 per hour**;
  - search, autocomplete — the topbar search **and** the user-directory search behind
    every assignee/successor picker (`GET /api/users?q=`) — and the §6.1 similarity
    check — **120 per minute** (the one limited read: each is a query a script could
    hammer, and the directory search could otherwise enumerate every user);
  - every other state-changing API request — **120 per minute**.
  An exceeded limit answers **429** with `Retry-After` and a plain message ("Too many
  requests — try again shortly."). Rate-limit rejections are **logged** (structured
  warning with user id and bucket), **not audited** — a flood must not become an audit
  flood — and, like any web-tier 429, are recorded in the system log (§14.7), which is
  operational telemetry, not the audit log. The limits apply to every role; a bulk
  triage action is one request. The CSP report sink is the one exception to *per
  signed-in user*: it is limited per client IP (above), and its 429s are not recorded in
  the system log.
- **SCIM rate limiting** — the worker's SCIM endpoints are limited per **client IP**:
  **2 000 requests per 15 minutes**, sized so an initial Entra sync of a few thousand
  users never trips it (Entra honours a 429 with `Retry-After` if it does). The worker
  sits behind the proxy and trusts the forwarded address for a configured number of
  hops (`TRUST_PROXY`), so the real client is keyed, never the proxy itself.
  `/healthz`, `/readyz`, and `/metrics` are **exempt**, so probe and scrape cadence
  can never be throttled. Like the web buckets, the counters are in memory per
  instance.
- **Dev and e2e scaling** — local dev and e2e may scale every limit above via
  `RATE_LIMIT_MULTIPLIER`, honoured **only when `NODE_ENV !== "production"`** (the
  same guard as the dev-auth bypass, §2.3); a production build ignores the variable.
- **Existence is not disclosed.** Any request about a challenge, solution, comment, or
  attachment the caller **cannot see** (§4.3) answers **404**, indistinguishable from a
  number or id that does not exist. Permission (**403**) and state (**409**) checks
  run **only after** the visibility check passes. So a probe across challenge numbers
  cannot tell "exists in a namespace you can't see" from "doesn't exist". This
  generalizes the rule §16 already states for admin delete.
- **Malformed input is a 4xx, never a 500.** A JSON body that is not an object
  (`null`, an array, a scalar) or does not parse is **400**. A well-formed body whose
  fields fail validation is **400** or **422**, as each route documents (e.g. the §10.3
  delete reason is 422). A path parameter that is
  not a well-formed id (a non-UUID user id, a non-integer challenge number) is **404**
  without reaching the database. Every free-text field has a maximum length; the
  challenge **client name** is capped at **200** characters (§6.1).

---

## §3 Identity & provisioning

Identity covers OIDC sign-in, SCIM 2.0 provisioning, and group-based RBAC, developed
in the same spec-first, approval-gated working mode as the rest of the project. The
detailed integration spec is **`ENTRA_AUTH_SPEC.md`** (data model, endpoint contracts,
Entra runbook); on conflict this document wins.

- **Sign-in:** OIDC against Microsoft Entra ID via Auth.js. No local accounts. All
  routes (UI + API) require an authenticated session. **Any tenant member** may sign
  in (no Entra app assignment gate); capabilities are gated by roles. **JIT sign-in
  is allowed**: a first sign-in before SCIM provisioning creates a stub user from
  token claims (keyed on `oid`), completed and thereafter owned by SCIM/
  reconciliation. **Sign-out clears every Auth.js cookie, server-side, and nothing in
  Entra** (no front-channel logout). On a sign-out request Auth.js has accepted (its own
  CSRF token checked), the response additionally **expires every cookie the request
  carried whose name — after stripping a `__Secure-` or `__Host-` prefix — starts
  with `next-auth.`**. That covers the session token **and every chunk of it**
  (`.0`, `.1`, …; the set is read from the request, so no chunk count is guessed),
  the CSRF token, the callback URL, and the PKCE code-verifier, `state` and `nonce`
  cookies left by an unfinished sign-in. Each is expired with `Max-Age=0`, `Path=/`,
  no `Domain` (Auth.js cookies are host-only), and `Secure` whenever the name carries
  a prefix or `PUBLIC_BASE_URL` is `https`. A shared or kiosk machine is therefore
  left with no InnoBox auth state at all, and no orphaned session chunk can ever be
  re-assembled with a newer one. Non-auth browser state (theme, collapsed admin
  cards, the §13.1 view choice) is untouched.
  Sessions: rolling 7-day cookie; the user's `active` flag and roles are resolved
  from the DB on every request — the session token never carries roles.
- **Sign-in relink (SCIM-provisioned rows).** The identity key stays the Entra
  `oid` (`users.external_id`); the UPN is never an identity key. It is used for
  exactly one repair, at sign-in, when **no `users` row has `external_id = oid`**:
  - **Candidates** are rows with `lower(user_name) = lower(<preferred_username
    claim>)` **and** `scim_synced = true` (written by SCIM — reconciliation-created
    rows and JIT stubs are `false`) **and** `active = true` **and**
    `scrubbed_at IS NULL` **and** `last_seen_at IS NULL` (the row has **never been
    used** — §14.5) **and** `external_id <> oid`. No `preferred_username` claim → no
    relink attempt. The never-used condition is the guard against **UPN reuse**: if a
    leaver's UPN is reassigned to a new hire before SCIM has deactivated the leaver's
    row, that row has been used and can never be taken over; the real target — a row
    SCIM provisioned with a mismatched `externalId`, whose owner could therefore never
    sign in — is still covered.
  - **Exactly one candidate → relink.** That row's `external_id` is set to the
    `oid` by a guarded single update (`… WHERE id = <row> AND external_id = <old>`;
    a concurrent sign-in that loses the race re-reads by `oid` and proceeds). The
    change is audited **`user.relinked`** (actor = the relinked user, as
    `user.jit_created` is; `before: { externalId: <old> }`,
    `after: { externalId: <oid> }`). **No JIT stub is created**. The row keeps its
    roles, content, profile and SCIM ownership (claims never overwrite a
    `scim_synced` row), and reconciliation thereafter addresses Graph by the new
    `oid`.
  - **More than one candidate, or a UPN collision the relink does not cover** (the
    only row holding the UPN is inactive, a JIT/reconciliation stub, scrubbed, or
    already used) → **no merge, ever.** Sign-in falls back to the JIT path unchanged.
    Because `user_name` is unique case-insensitively, that path cannot insert a second
    row for the same UPN. The sign-in is therefore **refused** (`/?error=AccessDenied`)
    rather than surfacing an unhandled error, and a **system-log row** is recorded
    (§14.7: status `409`, `error_code = signin_upn_conflict`, route
    `/api/auth/callback/[provider]`, `user_id` null and no actor snapshot, message
    naming the candidate **user ids** only). It never records the UPN, e-mail or
    `oid`, which a later erasure of those rows could not find and scrub. A platform
    admin resolves it in Entra (the SCIM `externalId` mapping or the duplicate
    account). The unique index makes two simultaneous candidates structurally
    impossible; the branch is kept as a defensive guard.
  - **SCIM can undo a relink.** If the tenant maps a *different* Entra object to the
    SCIM resource, that object's next SCIM `PUT` rewrites `external_id` back (or its
    SCIM DELETE deactivates the row). Because the relinked row has been used by then,
    the next sign-in is refused as `signin_upn_conflict` rather than relinked again.
    The `user.relinked` audit trail and the identity-sync card (§14.10) make this
    visible; the fix belongs in the tenant mapping, not in InnoBox.
  - The dev credentials provider (§2.3) never relinks.
- **Provisioning:** SCIM 2.0 (users + groups) served by the worker; Entra is the
  source of truth. Periodic reconciliation against Entra corrects drift. Deactivated
  users lose access immediately at session validation. **SCIM DELETE deactivates**
  (idempotent) — it never triggers the GDPR scrub, which stays a deliberate, audited
  platform-admin action. **SCIM never writes to — or returns — an erased row.** Every
  id-addressed `/Users/{id}` verb (`GET`, `PUT`, `PATCH` **and** `DELETE`) on a
  scrubbed user (`scrubbed_at` set) answers **404**, exactly as a malformed (non-UUID)
  id does (`ENTRA_AUTH_SPEC.md` §5); a well-formed id that matches no row keeps the
  idempotent **204** on `DELETE`. A `POST /Users` whose `externalId` matches a scrubbed
  row answers **409**. SCIM list and filter reads exclude scrubbed rows — from the
  resources and from `totalResults`. A group membership add (`POST`, `PUT` or `PATCH`
  on `/Groups`) naming a scrubbed user treats it as an unknown member: nothing is
  written. Nothing on the row changes, so erased personal data cannot flow back from
  Entra, and each refusal on an erased row is audited as `scim.anomaly`.
  Reconciliation already skips scrubbed rows.

  > **⚠ GAP-12 · code fix:** `worker/src/scim/router.ts` never checks `scrubbed_at`:
  > `findUserById`, `findUserByExternalId` and `findUserByUserNameCI` return erased
  > rows, so `GET`/`PUT`/`PATCH`/`DELETE /Users/:id` act on them (a `PUT`/`PATCH`
  > refills name, e-mail and UPN, sets `scim_synced`, and can reactivate the row), a
  > `POST /Users` with a matching `externalId` runs `updateUserFull` on one, the
  > `GET /Users` page, filter and count include them, and `addMembersTolerantly`
  > (via `userExists`) adds them to groups. Add the refusals above, each audited
  > `scim.anomaly`, with `scim.dbtest.ts` cases.
- **User attributes:** display name, e-mail, department, job title, **office
  location**, photo (Entra); cached locally, refreshed by reconciliation. Department,
  job title and office location are the **directory profile** — display-only data
  behind the profile page (§13.5) and the directory hover card (§13.8). **Nothing in
  RBAC, visibility or governance reads them** (invariant 1 unaffected).
- **Directory profile sourcing.** Reconciliation is the **only** automatic writer and
  it **overwrites unconditionally** — a promotion, a re-org or an office move must
  propagate, and a Graph value that is absent or empty writes NULL so clearing the
  attribute upstream clears it here too. Its hourly pass already visits **every local
  active user** (not only members of role-mapped groups), so there is no cohort that
  never gets a directory profile: `officeLocation` simply joins `department`/`jobTitle`
  on the `GET /users/{oid}` `$select` the pass already issues — **no extra Graph
  request and no new application permission** (all three are default properties of the
  user resource, covered by the granted application `User.Read.All`). Sign-in still
  fetches nothing from Graph (§3.1); a JIT stub therefore shows no office location for
  at most one reconciliation interval, exactly as it shows no photo.

  > **⚠ GAP-13 · code fix:** `worker/src/recon/graph.ts` `getUser` normalizes the three
  > directory fields through `directoryAttr`, but still maps `mail: j.mail ?? null`, so
  > an empty or blank `mail` from Graph is stored as `""`. Route `mail` through
  > `directoryAttr` too.
- **SCIM stays unmapped for office location.** The SCIM payload carries `title` and the
  enterprise `department` as today, but **no** office attribute — SCIM writes must never
  touch `office_location` (leaving it to reconciliation), so **no Entra provisioning
  attribute-mapping change is required in the tenant**.
- **GDPR erasure:** "Delete user info" scrubs the `users` row and personal data and
  de-identifies the user's comments/challenges/solutions to "Deleted User";
  `audit_log` is deliberately exempt (invariant 5) and retains actor identity for
  provenance. **The erasure also clears the cached photo bytes + etag (§3.1)** —
  the "Deleted User" placeholder renders the neutral bubble — **and the whole
  directory profile (department, job title, office location), which is personal data
  and is scrubbed exactly like the photo.** It **also erases all presence data**
  (`last_seen_at`, `last_route`, and every `user_activity_days` row for that user,
  §14.5): a retained "Deleted User was last online at 14:32" would defeat the erasure.
  A scrubbed user therefore never appears in the Currently online panel. It likewise
  **scrubs the user's system-log rows** (§14.7 — `actor_name`/`actor_email` cleared,
  `user_id` nulled; that table is mutable and so, unlike `audit_log`, not exempt). It
  nulls the per-user seen markers (`triage_seen_at`, `challenges_seen_at`,
  `system_log_seen_at`, `quick_start_seen_at`) and resets the notification preferences
  (`email_notifications_enabled` to false, since no address is left; the three
  `notify_followed_*` columns, which are `NOT NULL`, to their default). Everything runs
  in **one transaction**. In the same transaction the erasure also:
  - **leaves the row unrelinkable** — `scim_synced` is set to `false` and `user_name` is
    rewritten to `deleted-<id>`, so a scrubbed row can never be a sign-in relink
    candidate (above);
  - optionally **hands over open assignments** to a successor (below).

  What erasure deliberately **keeps**, attached to the de-identified row: the user's
  likes and follows; **curation provenance** — their Home pins stay in place and
  `featured_by` keeps pointing at the scrubbed row, so the admin control's sub-text reads
  *"Featured by Deleted User on <date>"* (erasure does not unpin anything); and the user
  references on channel-webhook configuration rows they created or updated (§12.4),
  which render "Deleted User". The
  system-log row a refused relink records (above) carries candidate user ids only, so the
  system-log scrub (which keys on `user_id`) has nothing extra to find.

  **Optional successor for open assignments.** The erasure may name a **successor**
  ("Reassign open assignments to"). When it does, the following happens inside the
  **same transaction** as the scrub (all-or-nothing):
  - **What moves:** every challenge whose `assignee_id` is the erased user and whose
    status is **non-terminal** (not `solved`, `rejected`, `withdrawn`, §7.1), locked
    `FOR UPDATE` against a concurrent assignment. Terminal challenges keep the erased
    row as their historical assignee.
  - **Visibility gate:** a challenge moves only if the successor **can see it** under
    §4.3, evaluated with the successor's roles resolved from SCIM-synced membership
    (invariant 1). For example, an `awaiting_triage` item moves only to a namespace or
    platform admin of its namespace, and a namespace-restricted item only to a member.
    An item the successor cannot see is **skipped**: it stays assigned to the
    de-identified row ("Deleted User") and is listed in the result so the admin can
    reassign it by hand (§7.3).
  - **Each move is an ordinary assignment change:** `assignee_id` set to the
    successor, the successor auto-followed (§12.3), and one **`challenge.assigned`**
    audit row per challenge with exactly the §7.3 shape (actor = the platform admin;
    `before: { assigneeId: <erased> }`, `after: { assigneeId: <successor> }`).
    `updated_at` bumps; `edited_at` does not; status is untouched.
  - **Authorship never moves.** Challenges, solutions and comments the erased user
    wrote stay attributed to the de-identified row, exactly as without a successor.
    Only the assignee role is handed over.
  - **One notification:** after commit the successor receives **one** summary item
    (§12.1 event 12) listing the moved challenges — not one event-7 item per move.
    No other recipient is notified (the erased user is not).
  - **Successor rules:** an **active**, not-scrubbed user other than the one being
    erased. The acting admin may name themselves, and then gets no notification
    (actors never notify themselves). Anything else is rejected (**400**) before any
    change is made. Without a successor, erasure behaves exactly as before: open
    assignments keep pointing at "Deleted User".

  **The `user.scrubbed` audit row** records `reassignedTo` (user id or null),
  `reassignedCount` and `skippedCount` — numbers and ids only, never content.

  > **⚠ GAP-14 · code fix:** the `scrubUser` UPDATE in `api/users/store.ts` sets
  > `email_notifications_enabled = default` (true); it must be `false`. Flip the
  > assertion in `api/users/store.dbtest.ts`, which currently expects `true`.

  **The "Delete user info (GDPR)" card** (Administration console, platform admins).
  Choosing **Delete info** on a search result opens an inline confirmation, replacing
  the browser confirm dialog. It holds an **optional "Reassign open assignments to"**
  picker — the §7.3 assignee search over active users, excluding the user being
  erased — and the irreversibility warning. On success the toast reports *"Deleted
  personal info for <name>. Moved N open assignments to <successor>."* When items
  were skipped, the card lists them (*"Left with Deleted User — <successor> can't see
  these: CH-12, CH-40"*, each a link) until dismissed. The endpoint is
  `POST /api/admin/users/:userId/scrub` (§16).

### §3.1 Profile photos (avatars)

The Entra profile photo is the **only** avatar source — no user uploads, no external
avatar services. Rendered as **avatar bubbles** on every surface where a user is
shown (§13.6).

- **Fetch & storage:** Microsoft Graph `GET /users/{oid}/photos/240x240/$value`
  (metadata first — the `@odata.mediaEtag` skips the download when unchanged), using
  the same application credentials as reconciliation (application `User.Read.All`,
  already granted). **One stored size** (240×240 — crisp at every §13.6 rendering
  size incl. 2× DPR), stored as-is (JPEG/PNG as Graph returns it) in
  `users.photo` (bytea) + `users.photo_etag` — small corporate avatars live in
  Postgres, no object-store coupling.
- **Sync: reconciliation-owned** (deliberate — sign-in fetches no photo). The hourly
  pass checks every active user's photo metadata and downloads only on etag change;
  Graph 404 ("no photo") clears any cached copy. A brand-new user shows the initials
  bubble for at most one reconciliation interval. Corrupt or unreadable image data
  is treated as absent — the UI falls back to initials silently.
- **Serving:** **only** through the authenticated `GET /api/users/:id/photo`
  gateway — session-required; responses carry an `ETag` and `Cache-Control` with
  revalidation; `404` when the user has no photo or is deactivated (client renders
  the initials bubble). The endpoint exposes **no other profile data** and never
  serves a photo for content whose author is masked (§9 — the client never learns
  an anonymous author's id in the first place, invariant 3). The response's
  `Content-Type` is the stored image's real type (JPEG or PNG, sniffed from the leading
  bytes), and its `ETag` is the stored Graph etag as one well-formed entity tag: a value
  that is already quoted — strong, or weak with a `W/` prefix — is sent unchanged, and
  only an unquoted value is wrapped in quotes. `If-None-Match` is compared against that
  same form.

  > **⚠ GAP-15 · code fix:** `api/users/[userId]/photo/route.ts` always wraps the stored
  > `photo_etag` in quotes (`` `"${row.photo_etag}"` ``), which yields a malformed `ETag`
  > when Graph's value is already quoted or weak. Quote only an unquoted value, pass a
  > `W/"…"` value through, and compare `If-None-Match` against the result.
- **Deactivation:** when a user deactivates (SCIM or reconciliation), the cached
  photo bytes + etag are cleared; the user renders as a greyed initials bubble
  thereafter (§13.6).

---

## §4 Namespaces, roles & permissions

### §4.1 Namespaces

- A **namespace** represents a business unit / organizational scope. Platform admins
  create, rename, and archive namespaces (archive blocks new submissions — no new
  challenge into the namespace and no new solution on any of its challenges, each
  refused with **409** and `code: "namespace_archived"`; an id that matches no
  namespace at all stays a 400; existing content remains readable per its visibility).

  > **⚠ GAP-16 · code fix:** `createSolution` (`api/challenges/store.ts`) has no
  > archived-namespace check. Refuse with 409 `code: "namespace_archived"` in
  > `api/challenges/[number]/solutions/route.ts`.

  > **⚠ GAP-57 · code fix:** `createChallenge` (`api/challenges/store.ts`) folds an
  > archived namespace into `unknown_namespace` (`archived_at is null` in the lookup),
  > which `api/challenges/route.ts` answers with **400** "namespace not found or
  > archived". Return a distinct result for an archived namespace and answer 409
  > `code: "namespace_archived"`.
- A built-in **`global`** namespace always exists; **every authenticated user is an
  implicit member** of `global`.
- Namespace membership and roles come from Entra groups mapped in `role_mappings`
  (group → `{namespace, role}`), synced via SCIM (invariant 1).

### §4.2 Roles

| Role | Scope | Powers |
|---|---|---|
| **Platform Admin** | global | Everything below in every namespace + platform settings (§14.3), namespace CRUD, role mappings, impact-area management; **feature/unfeature challenges on Home** (§13.2); **channel webhooks** (§12.4); GDPR erasure with assignment hand-over (§3); identity-sync diagnostics (§14.10); audit integrity verification (§15) |
| **Namespace Admin** | per-namespace | Triage queue; assign/unassign; **free any→any status set** (audited override); anonymity reveal (audited); comment deletion; bulk actions; CSV export |
| **Committee Member** | per-namespace | Move challenges/solutions of the namespace through the **enforced** state machines (§7.2, §8.2); comment with a committee badge. No assignment, no reveal, no bulk/config |
| **Member** | per-namespace | Namespace membership only: read the namespace's restricted content and submit into it (§4.3). No powers beyond the authenticated-user baseline. Every user is an implicit member of `global` |
| **Assignee** | per-challenge | Enforced transitions on the assigned challenge and its solutions; request improvements; comment. Granted by assignment, revoked by unassignment |
| **Authenticated user** (implicit) | global | Submit challenges, propose solutions (on `valid` challenges), comment, like/unlike, follow, view per visibility, manage own profile/preferences |

A user may hold different roles in different namespaces. Roles are additive.

### §4.3 Visibility

- Every challenge has **`visibility: org | namespace`** chosen at submission
  (default `org`) and changeable later only by a namespace/platform admin (audited).
- `org` → readable by every authenticated user. `namespace` → readable only by
  members of the challenge's namespace (any role) and platform admins.
- **Solutions, comments, likes, attachments, and notifications inherit the parent
  challenge's visibility.**
- Additional state-based visibility (applies on top, most restrictive wins):
  - `awaiting_triage` and `withdrawn` challenges: visible only to their author,
    the namespace's admins, and platform admins. For these three the state rule
    **replaces** the namespace rule rather than narrowing it: the author of a
    `namespace`-visible item keeps seeing it even after losing membership of its
    namespace. The same predicate holds in every list, count and search (the SQL form)
    as on the detail page.

    > **⚠ GAP-58 · code fix:** the SQL twin of `canSeeChallenge`
    > (`pushChallengeVisibilityConditions`, `api/challenges/store.ts`) ANDs the namespace
    > condition with the state condition, so an author who has lost membership of a
    > restricted namespace no longer finds their own `awaiting_triage`/`withdrawn` item
    > in the gallery, the new-count or search, while `canSeeChallenge`
    > (`shared/src/challenges.ts`) still shows it on the detail page. Make the SQL match:
    > for those two statuses, author or namespace admin of the item's namespace (or
    > platform admin) regardless of membership.
  - Solutions in `proposed` status: visible only to their author, the challenge's
    assignee, and the namespace's committee/admins (mirrors the legacy behavior of
    hiding un-reviewed solutions).
  - `rejected` / `not_selected` / `withdrawn` solutions: shown in a collapsed
    (`<details>`) "Closed solutions" section of the challenge page to anyone who can
    see the challenge; excluded from solution counts and galleries. The detail page's
    `Solutions (n)` heading counts only the open list above that section, consistent
    with the gallery's solution count, which likewise leaves closed solutions out.

    > **⚠ GAP-17 · code fix:** the detail page (`challenges/[number]/page.tsx`) renders
    > every visible solution in one list, and its heading `Solutions (n)` counts
    > `challenge.solutions.length`. Move `rejected`/`not_selected`/`withdrawn` into a
    > collapsed `<details>` "Closed solutions" section and count only the open list.
- Search, autocomplete, KPIs, counts, and leaderboards are computed strictly within
  the viewer's visibility (invariant 2). Leaderboards additionally count **org-visible
  content only**, so a public leaderboard never hints at restricted work.
- Submission targeting: a user may submit a challenge into any namespace they are a
  member of (everyone can use `global`). A solution may be proposed by anyone who can
  **see** the challenge.

---

## §5 Domain model

Entities (Postgres; key fields only — types/constraints finalized in migrations):

- **`namespaces`** — id, slug, display name, archived_at.
- **`users`** — id, entra object id (`external_id`), email, display name,
  **user_name** (the UPN as SCIM sent it; unique case-insensitively — the §3 relink
  hint), **scim_synced** (true once a SCIM write has touched the row; false for JIT
  stubs and reconciliation-created rows, and reset by erasure — §3 relink, §14.10),
  **scrubbed_at** (the GDPR erasure marker, §3), department, job title,
  **office_location** (nullable text — the directory profile's third field, mirroring
  the Entra `officeLocation` attribute; §3, §13.8),
  photo (cached 240×240 bytes) + photo_etag (§3.1), email_notifications_enabled
  (default true), triage_seen_at (nullable; last time the user opened the triage
  queue — drives the §14.4 attention badge),
  **last_seen_at** (nullable timestamptz; last user-initiated request, throttled to one
  write per 60 s — §14.5), **last_route** (nullable text; the route category/entity the
  user was last on, masked per §14.5 — current value only, never a history),
  **challenges_seen_at** (nullable timestamptz; the §13.1 "new since your last visit"
  marker, backfilled to the migration's run time), **system_log_seen_at** (nullable;
  platform admins' §14.7 nav badge), **notify_followed_comments** /
  **notify_followed_status** / **notify_followed_solutions** (boolean, not null,
  default true — the §12.1 per-event preferences), deactivated_at.
- **`groups`** — id, external_id (Entra group object id), display_name,
  **scim_synced** (boolean, not null, default false; set true by every SCIM group
  create/replace/patch and left untouched by reconciliation's mirroring of mapped
  groups — §14.10; backfilled true for groups whose `scim.group_created` /
  `scim.group_renamed` audit rows show a SCIM origin, i.e. no `via: reconciliation`),
  created_at, updated_at; plus **`group_members`** (group_id, user_id).
- **`role_mappings`** — entra group id → (namespace_id | null for platform) + role.
- **`impact_areas`** — id, name, active flag. Seeded: **Client, Internal,
  Accelerator**. Platform-admin managed (§14.3); retiring an area keeps it on
  historical items but removes it from the submission form. A **retired** area may
  be **deleted** (§14.3) — either when no challenge references it, or by reassigning
  its challenges to another active area as part of the delete. Deletion is the only
  path that removes a row.
- **`challenges`** — id (uuid), **number** (global sequence, displayed `CH-<n>`),
  namespace_id, visibility, title (≤ 120 chars), description (plain text, ≤ 10 000
  chars), impact_area_id, client_name (**required iff impact area = Client**, hidden
  otherwise), is_anonymous, author_id, assignee_id (nullable), status (§7.1),
  status_changed_at (defaults to created_at at genesis, bumped on every transition —
  drives the §14.4 attention badge), created_at, updated_at, edited_at, resolved_at,
  **first_valid_at** (nullable timestamptz; set on
  the challenge's first transition into `valid`, never cleared — it pins the §12.4
  `challenge.validated` webhook to once per challenge; the migration backfills it from
  the earliest `challenge.status_changed` audit row whose target is `valid`, falling
  back to `status_changed_at` for challenges currently `valid` or `solved`),
  **featured_at** + **featured_by** (nullable timestamptz / user FK, set together;
  non-null only while status is `valid` or `solved`, DB-checked — the §13.2 Home pin).
  Curation columns are not content: writing them bumps neither `updated_at` nor
  `edited_at`.
  A platform admin may **hard-delete** a challenge, cascading to every child row
  (§10.3); that is the only path that removes the row.
- **`solutions`** — id, **number** (`SOL-<n>`), challenge_id, description (≤ 10 000),
  cost_vs_benefits (≤ 5 000, optional), is_anonymous, author_id, status (§8.1),
  status_changed_at (as challenges, §14.4), created_at, updated_at, edited_at.
  Hard-deletable by a platform admin on the same terms (§10.3), and removed with its
  parent challenge when that is deleted.
- **`comments`** — id, parent (challenge | solution), author_id, body (≤ 5 000),
  created_at, edited_at, deleted_at + deleted_by (soft delete, §10.2); rows are
  hard-deleted only inside the §10.3 parent-delete cascade.
- **`likes`** — (user_id, parent) unique; created_at. Toggling like/unlike
  inserts/deletes the row.
- **`follows`** — (user_id, parent) unique; created_at.
- **`attachments`** — id, parent (challenge | solution; `parent_id` **nullable while
  staged**, §11), **`draft_key`** (nullable UUID; set only while staged, before the
  parent exists), filename, size, mime, object key, scan_status (pending | clean |
  infected | unscannable), scanned_at, scan_attempts, next_scan_at, uploaded_by,
  created_at. Rows are retained as tombstones
  (§11) and hard-deleted only inside the §10.3 cascade.
- **`attachment_uploads`** — transient chunked-upload sessions (initiate → complete),
  §11: id, attachment_id, parent (nullable) / draft_key, filename, mime,
  declared_size_bytes, object_key, s3_upload_id, chunk_size_bytes, uploaded_by,
  created_at. Deletable working state (unlike `attachments`).
- **`notifications`** — id, user_id, type, payload (jsonb), read_at, created_at
  (in-app inbox, §12.2); plus an **outbox** table driving e-mail dispatch from the
  worker. Rows targeting a challenge/solution are deleted with it (§10.3), so no
  inbox item ever points at a vanished entity. **Comment rows coalesce** (§12.1): a
  partial unique index on `(user_id, payload->>'parentType', payload->>'parentId')
  WHERE read_at IS NULL AND type = 'comment_posted'` lets the insert become an atomic
  update-in-place while the row is unread; the payload carries `count`, `latestBy`,
  `latestAt`, and the parent `challengeId` (so opening the challenge page can read
  the rows for the challenge and its solutions). Event 12 (§12.1) uses the type
  `assignments_transferred` (payload `{ message, link, count, numbers[] }`).
- **`channel_webhooks`** — id, namespace_id (FK), name (≤ 80), format
  (`json | teams_workflows`), url_enc (AES-256-GCM under `WEBHOOK_ENC_KEY`, §12.4),
  url_hint (plaintext host + last 4 characters), enabled, created_by, created_at,
  updated_by, updated_at (§12.4). At most 5 per namespace.
- **`webhook_deliveries`** — the §12.4 webhook outbox: id (also the
  `X-InnoBox-Delivery` header); webhook_id (FK, `ON DELETE CASCADE`); event
  (`challenge.validated | solution.implemented | challenge.solved`); entity_type,
  entity_id (no FK); event_status, occurred_at (snapshotted); status
  (`pending | sent | failed | skipped`); attempts, next_attempt_at; last_http_status
  (nullable); last_reason (fixed reason code, never the URL); created_at, finished_at.
  Mutable working data: terminal rows are trimmed 30 days after `finished_at`. Rows of
  a deleted subtree are removed by the §10.3 cascade.
- **`system_events`** — the §14.7 operational error log: id, created_at, status,
  method, route (matched template), path (concrete, no query string; the template
  only when the target is anonymous), user_id (nullable), actor_name, actor_email
  (point-in-time snapshot), error_code, message (one sanitized line), request_id,
  duration_ms, source (`web | worker`). **Mutable** working data (no append-only
  trigger): trimmed at 90 days by the worker, scrubbed by GDPR erasure (§3). Trigram
  GIN index for substring search.
- **`user_activity_days`** — (user_id, day) unique; the transient per-person day set
  that makes "distinct users per day" computable (§14.5). **Deleted by the worker once
  older than 3 days** — long-lived presence history is aggregate-only.
- **`presence_daily`** — (day) unique, active_users int; the rolled-up daily
  distinct-active-user count behind the §14.5 chart. Carries **no user ids** and is
  retained indefinitely.
- **`platform_settings`** (called `settings` elsewhere in this document) — key/value
  platform configuration (§14.3); also holds the
  `system_banner` singleton (§14.6), the `system_log_notify_at` watermark (§14.7), the
  `featured_limit` (§13.2, §14.3), and the **`scim_last_request_at`** stamp (ISO UTC;
  written by the worker on accepted SCIM requests, at most once a minute — §14.10).
- **`audit_log`** — append-only (§15): id, actor_user_id, action, target_type,
  target_id, before, after, created_at, plus the hash-chain columns **chain_seq**
  (bigint, unique where set), **prev_hash** and **row_hash** (hex SHA-256). All three
  are NULL on pre-chain rows and are set by the `audit_log_chain` trigger on every later
  insert.

Dropped from the legacy model (never used by any screen): `Portfolio`,
`expert_team`, `accessteam(s)`, the challenge-level free-text `Comments` column, the
`app_version` SharePoint list (superseded by web deployment).

Validation is enforced server-side (shared package), mirrored client-side for UX:
title required ≤ 120; description required ≤ 10 000; client_name required iff
impact = Client; impact area required and must be active at submission time.

---

## §6 Submission

### §6.1 Challenge submission (any authenticated user)

Reached at **`/challenges/new`**, via the **Submit a Challenge** sidebar nav item
(§2.2, directly above **Challenges**) — shown to every authenticated user.

Form: title, description, impact area (active areas), client name (only when
impact = Client; at most 200 characters, §2.4), namespace (memberships; default `global`), visibility (default
`org`), attachments (**staged inline via a `draftKey`**, §11), **"Submit
anonymously"** checkbox (§9).

On submit: challenge created with status **`awaiting_triage`**, number allocated, any
files staged during the form **bound** to it in the same transaction (§11) — the create
is **rejected while any staged file is still scanning, infected, or unscannable** when a scanner is
available (§11 *Binding at submit* scan gate) — author auto-follows it (§12.3),
notifications fire (§12.1 event 1), audit entry.

**Duplicate warning.** The first **Submit** click runs a server-side similarity check
before anything is created: `POST /api/challenges/similar { title, description }`
ranks the caller's **visible** challenges — the same visibility predicate as search
(invariant 2), so another author's `awaiting_triage` item is never a candidate (an
accepted gap: two people submitting the same idea in the same hour will not see each
other; the triage queue is where that surfaces) — with the §13.4 full-text index over
title + description, **excluding `rejected` and `withdrawn`** and keeping `solved` (a
solved duplicate is the most useful hit), and returns at most **5** matches above a
minimum rank, each as number, title, status and the author **masked per §9**. With
matches, the form shows an advisory banner (*"These challenges look similar — is yours
one of them?"*) listing them as links, and the button flips to **Submit anyway**; the
next click submits. **Editing any field after the warning re-arms the check** — the
banner clears and the next click re-checks — so a changed challenge is never posted
on a stale acknowledgement. With no matches the first click submits directly. The
check and the create share one submission lock (§6.4). The
check is **advisory, always on, never a hard block**, and has no platform setting.
When the author submitted past a warning, the `challenge.created` audit payload
records `similarAcknowledged: [<numbers>]` (absent otherwise) — no new column. The
endpoint shares the search rate limit (§2.4). **Solutions get no duplicate check in v1.**

### §6.2 Solution proposal (any user who can see the challenge)

Allowed **only while the challenge status is `valid`** (the UI hides/disables the
action otherwise; the API enforces it).

Form: description, cost vs benefits (optional), attachments (**staged inline via a
`draftKey`**, §11), "Submit anonymously".

On submit: solution created with status **`proposed`**, number allocated, any files
staged during the form **bound** to it in the same transaction (§11) — the create is
**rejected while any staged file is still scanning, infected, or unscannable** when a scanner is
available (§11 *Binding at submit* scan gate) — author auto-follows it, notifications
fire (§12.1 event 2), audit entry. The form locks
while the request is in flight and closes only once the challenge has re-rendered
(§6.4).

There is no draft state for the solution itself; cancel discards (any files staged
via §11 are left to the 24-hour GC). Editing after submission: §10.1.

### §6.4 Submission lock

The three author submit paths **lock** while their request is in flight, so a slow
server never invites a second click, a half-edited resend or a stray Cancel:
the **challenge form** (§6.1), the **solution form** (§6.2), and the **Resubmit**
action (§10.1). Withdraw, edit, comment and admin controls are out of scope (their
existing `busy` disabling is unchanged).

- **What locks.** A **scrim** covers the form body: an overlay on the form card
  (`--surface` at ~60% opacity, `cursor: progress`, no new token) over contents made
  **`inert`** — no pointer, no focus, no typing, staged attachments included — with
  `aria-busy="true"` on the form. The **primary button** stays visible above the scrim,
  disabled, with the shared `.spinner` and the label **"Working…"** (replacing the
  per-form "Checking…"/"Submitting…" labels). A polite live region announces
  "Working…" once. The scrim appears immediately, with no delay and no animation.
  The handler is guarded too, not only the UI: a second `submit` event (e.g. Enter)
  while locked is a no-op.
- **Released on error.** Any failure (validation 400, the §11 scan gate, 429, network)
  lifts the lock: the scrim goes, every field is editable again with its values and
  staged files intact, and the server's message renders in the form's error line
  (`role="alert"`). Nothing is re-sent automatically.
- **Held on success.** The lock is **never released on success**, so no frame exists
  in which the form is both submitted and clickable:
  - *Challenge form* — held through `router.push` to the new `/challenges/:number`;
    the form unmounts while still locked.
  - *Solution form* — there is no navigation: the form stays locked until the parent
    challenge has been **re-read and re-rendered**, and then closes. Closing on success
    must wait for that refresh, not fire alongside it.
  - *Resubmit* — the lock covers the item's **author action bar** (Edit / Resubmit /
    Withdraw) and, if open, that item's inline edit form; the Resubmit button reads
    "Working…". On success the lock is held until the detail re-read has rendered.
    The item is then `in_review`, `canResubmit` is false, and the bar re-renders
    without it. On error it releases and the message shows through the page's
    existing notice. No separate resubmit form is introduced.
- **The duplicate check (§6.1) is part of the lock.** The first **Submit** click
  locks the form *before* `POST /api/challenges/similar`:
  - **matches** → the lock **releases**, and the advisory banner and **Submit anyway**
    appear. The author must be able to read, edit or proceed.
  - **no matches, or a failed check** (advisory, never blocking) → the lock is **held
    continuously** into the create call, with no release and re-lock flicker in between.
  - **Submit anyway** → locks again for the create. The "editing re-arms the check"
    rule is unaffected: edits are only possible while unlocked.
- **Not a lock:** the existing **"Waiting for attachments…"** state (an upload still
  scanning *before* submit) keeps the form editable and only disables the button,
  exactly as before. A lock never blocks leaving the page (no `beforeunload` prompt).
- One shared implementation (a small form-lock component/hook plus the
  `.form-lock-scrim` rule in `globals.css`, §2.2) serves all three surfaces.

---

## §7 Challenge lifecycle

### §7.1 Statuses

| Canonical | Display | Legacy name |
|---|---|---|
| `awaiting_triage` | Awaiting triage | genesis |
| `in_review` | In review | in review |
| `needs_improvement` | Needs improvement | need improvements |
| `meeting_scheduled` | Meeting with author | Meeting With Inventor |
| `valid` | Valid — open for solutions | valid |
| `solved` | Solved | solved |
| `rejected` | Rejected | reject |
| `withdrawn` | Withdrawn | — (new) |

### §7.2 Enforced state machine (committee & assignee)

```
awaiting_triage → in_review | rejected
in_review       → valid | needs_improvement | meeting_scheduled | rejected
meeting_scheduled → in_review | valid | needs_improvement | rejected
needs_improvement → in_review           (author resubmit §10.1, or committee/assignee)
valid           → solved                (automatic §8.3; manual only via admin override)
solved, rejected, withdrawn = terminal  (exit only via admin override)
```

Namespace/platform admins may set any status at any time (invariant 6); every
transition is audited with actor and `from → to`, and override transitions are
flagged as such in the audit entry. The one exit from a terminal status that no actor
requests directly is `solved → valid`, applied when the challenge's `implemented`
solution is deleted (§10.3) — audited as an override transition with the deleting
platform admin as actor. A transition out of `valid`/`solved` (other than between
those two) clears any Home pin (§13.2), and the first transition into `valid` stamps
`first_valid_at` (§5, §12.4). Entering `solved` sets `resolved_at`; **any** transition
out of `solved` — the §10.3 revert or an admin override — clears it.

> **⚠ GAP-18 · code fix:** `applyChallengeStatusChange` (`api/challenges/store.ts`)
> only sets `resolved_at` on entry to `solved`; an admin override (single or bulk) out
> of `solved` leaves it set — only the §10.3 delete-revert in `challenges/delete.ts`
> clears it. Clear it there whenever the previous status is `solved` and the new one
> is not.

Triage (leaving `awaiting_triage`) and assignment are namespace-admin actions;
committee members operate from `in_review` onward.

*Enforcement (who may traverse which arrow):*
- **Namespace/platform admins** free-set any status (invariant 6), audited
  `override: true` — unconstrained by the graph.
- **Committee members** of the challenge's namespace, and the challenge's
  **assignee**, may traverse the arrows above **from `in_review` onward** — i.e.
  legal transitions whose *source* is `in_review`, `meeting_scheduled`, or
  `needs_improvement`. They may NOT leave `awaiting_triage` (triage is a
  namespace-admin action), set `valid → solved` (automatic/admin-override only), or
  exit a terminal status. Enforced transitions are audited `override: false`.
- Any other actor is refused (403). A committee/assignee request for a target that
  is not a legal arrow from the current status is refused (422, illegal transition).

The enforced and override controls both live on the §13.1 challenge detail page:
admins get the free-set dropdown (all statuses); committee members and the assignee
get a control offering **only the legal next statuses** for the current one, hidden
when there is no legal move. The transition endpoint is shared
(`PATCH /api/challenges/:number`); the mode (enforced vs override) is derived from
the actor's role, not a request field. A real transition fires the same §12.1
notifications regardless of mode.

### §7.3 Assignment

A namespace admin assigns an active user as the challenge's **assignee** (searchable
directory of active users). The assignee must be able to **see** the challenge under
§4.3 — the same visibility gate as the §3 erasure hand-over: a `namespace`-visible
challenge can go only to a member of its namespace or a platform admin, and an
`awaiting_triage` one only to a namespace or platform admin of its namespace. The gate
applies **at assignment time only**:
- the per-challenge pickers — the detail-page control and the §14.1 per-row assign
  field — search `GET /api/users?q=&challenge=<number>`, which returns only users who
  can see that challenge;
- the assign API (single and §14.1 bulk) refuses anyone else — the single-item
  endpoint with **422**, bulk assign with a per-item `assignee_cannot_see` outcome
  while the rest of the selection proceeds;
- the filter-by-assignee and bulk-assign search pickers (§14.1) span many challenges
  and are **not** filtered;
- an existing assignee who later **loses** visibility (a namespace-membership change,
  a visibility change to `namespace`) keeps the assignment — there is no automatic
  unassign and no assignee carve-out in §4.3, so they cannot open it — until an admin
  reassigns it.

Assignment/unassignment is audited and notifies the assignee (§12.1 event 7 — fixing the legacy bug where the
notification went to the assigning admin with a `[TEST]` subject); a **reassignment**
notifies both people — the new assignee that they were assigned and the previous one
that they were unassigned. Assignment is possible from `awaiting_triage` onward and is
blocked on terminal statuses. The assignee gains the per-challenge powers in §4.2. The
detail-page control both **assigns** and **unassigns** (an "Unassign" action beside
the current assignee); the §14.1 triage queue offers the same through its inline field.

> **⚠ GAP-19 · code fix:** nothing checks that the assignee can see the challenge.
> `GET /api/users` (`api/users/route.ts` → `searchActiveUsers`) ignores any
> `challenge` parameter, and `loadChallengeForAssignment` (`api/challenges/store.ts`,
> shared by `setChallengeAssignee` and `setChallengeAssigneeLean`/`bulkAssign`) checks
> only that the user is active. Add the `challenge=` filter (evaluated with the
> candidate's roles resolved from SCIM-synced membership, as the §3 hand-over does),
> pass it from the detail-page and per-row triage pickers, answer 422 from
> `api/challenges/[number]/assign/route.ts`, and return `assignee_cannot_see` per item
> from `bulkAssign`.

**Search-result presentation.** The assignee search input opens a popover listing
matching active users. Each result row is a single control laid out as: the user's
**avatar bubble** (§13.6, small) on the left, then a stacked text column — display
name on the first line and the dimmed e-mail on the second. Both lines are
constrained to the row width and **truncate with an ellipsis** when too long (the
untruncated name/e-mail is exposed via the row's native `title` tooltip), so no text
ever spills outside the popover. The popover itself adopts the app's standard
popover-menu chrome (soft shadow, inner padding, rounded per-row hover — the same
look as the account menu), and its width is bounded. This directory lists real active
users only — never anonymous authors — so the avatar is always the user's real photo
or initials bubble; there is no anonymity path here. The **identical** result-row
presentation is used by every assignee-search control in the app: the challenge-detail
assignment control (this section) and the triage queue's filter-by-assignee,
bulk-assign, and per-row assign controls (§14.1). The search payload is unchanged
(`id`, `displayName`, `email`), as is who may assign and when.

---

## §8 Solution lifecycle

### §8.1 Statuses

| Canonical | Display | Legacy name |
|---|---|---|
| `proposed` | Proposed | suggest a solution |
| `in_review` | In review | in review |
| `needs_improvement` | Needs improvement | need improvements |
| `valid` | Valid | valid |
| `accepted_internally` | Accepted internally | accepted internally |
| `waiting_for_resources` | Waiting for resources | waiting for resources |
| `in_implementation` | In implementation | in implementation |
| `external_acceptance` | External acceptance | external acceptance |
| `implemented` | Implemented | solution implemented |
| `rejected` | Rejected | rejected |
| `not_selected` | Not selected | — (new, §8.3) |
| `withdrawn` | Withdrawn | — (new) |

### §8.2 Enforced state machine (committee & assignee)

```
proposed            → in_review | rejected
in_review           → valid | needs_improvement | rejected
needs_improvement   → in_review        (author resubmit §10.1, or committee/assignee)
valid               → accepted_internally            (single-winner gate §8.3)
accepted_internally → waiting_for_resources | rejected
waiting_for_resources → in_implementation | rejected
in_implementation   → external_acceptance | implemented | rejected
external_acceptance → implemented | rejected
implemented, rejected, not_selected, withdrawn = terminal (admin override only)
```

Admin free-set and audit rules identical to §7.2.

*Enforcement:* mirrors §7.2 — admins free-set any status (`override: true`);
committee members of the challenge's namespace and the challenge's assignee traverse
the arrows above (`override: false`); anyone else is refused. **Unlike challenges,
there is no admin-only "triage" step for solutions:** committee/assignee may take
`proposed → in_review | rejected` directly. Terminal statuses
(`implemented`/`rejected`/`not_selected`/`withdrawn`) are exited by admin override
only. The §8.3 single-winner gate and the `implemented` auto-close cascade apply to
**enforced and override transitions alike** (setting `valid → accepted_internally`
is refused while a sibling is at or past that status; `→ implemented` solves the
challenge and closes siblings as `not_selected`). Controls live on the §13.1 detail
page per solution; the endpoint is shared (`PATCH /api/solutions/:number`).

### §8.3 Single accepted solution & auto-close

- **Gate:** `valid → accepted_internally` is refused (enforced *and* override) while
  another solution of the same challenge is at or past `accepted_internally`
  (invariant 7).
- **On `implemented`:** in one transaction —
  1. the solution becomes `implemented` (terminal);
  2. the parent challenge automatically becomes **`solved`** (`resolved_at` set);
  3. every other non-terminal solution of the challenge becomes **`not_selected`**
     (terminal; distinct from `rejected` — no stigma, excluded from "rejected"
     metrics);
  4. notifications fire (§12.1 event 8) and every change is audited — the challenge's
     `solved` row and each sibling's `not_selected` row as ordinary `status_changed`
     rows carrying `before.status`, `after.status`, `override` and
     `trigger: "auto_close"`, with the implementing actor as actor. `override`
     **inherits the mode of the triggering transition**: the cascade rows are part of
     the actor's one action, so an admin override that set `implemented` writes them
     with `override: true`, and an enforced move with `override: false`.
- A `solved` challenge accepts no new solutions, and comments stay open.
- **Likes freeze while the challenge is closed** — status `solved`, `rejected` or
  `withdrawn`. Nobody can like or unlike the challenge **or any of its solutions**;
  existing counts stay displayed, the like buttons render disabled with the tooltip
  *"Likes are closed for this challenge"*, and the API refuses a toggle (like or
  unlike) with **409** and a message that names no particular status. The challenge
  detail payload carries a **`likesFrozen`** flag, which drives both the challenge's
  and its solutions' buttons. If an admin moves the challenge back to an open status,
  likes reopen.

  > **⚠ GAP-21 · code fix:** the freeze covers `solved` only: `areLikesFrozen`
  > (`shared/src/social.ts`) returns `challengeStatus === "solved"` — add `rejected`
  > and `withdrawn`. `LIKES_FROZEN_HINT` (`web/src/lib/challenge-detail.ts`) reads
  > "Likes are closed because this challenge is solved." and both 409s in
  > `api/likes/route.ts` say "likes are closed on a solved challenge" — use the wording
  > above. Extend `likes-frozen.dbtest.ts` to `rejected`/`withdrawn` and the reopen.
- **If the `implemented` solution is later deleted** by a platform admin (§10.3), the
  auto-close is *not* replayed in reverse: the challenge reverts `solved → valid` with
  `resolved_at` cleared, while siblings closed as `not_selected` stay closed. The
  single-winner slot is free again for a new proposal; the challenge reopens with its
  existing solutions terminal.

---

## §9 Anonymity

- Challenges and solutions can be submitted anonymously. **The true author is always
  stored**; the flag controls exposure only.
- **Masking is total by default** (invariant 3): every list, card, detail page,
  search result, leaderboard, KPI, CSV export, e-mail, in-app notification, and
  outbound webhook (§12.4, which carries no person field at all) shows
  **"Anonymous"** with a neutral avatar — for all users **including admins and
  committee**. The neutral avatar is a **generic anonymous bubble** (§13.6): no
  photo, no initials, no per-user color — any of those would fingerprint the author.
- **Reveal:** namespace admins (own namespace) and platform admins can execute a
  per-item **"Reveal author"** action. The reveal is **transient** (shown in the UI
  for that admin, not persisted as unmasked) and **every execution is audited**
  (who revealed whom, on which item, when). The reveal dialog shows the author's
  real avatar bubble (§3.1) alongside the revealed name, transiently. Committee
  members and assignees cannot reveal.
- **Self-reveal:** the author can remove their own anonymity at any time (one-way);
  audited.
- Notifications must be anonymity-safe: mails/inbox items about an anonymous item
  never contain the author's identity. The anonymous author still receives their own
  notifications normally.
- **Comments and likes are never anonymous** — they always show the real user,
  **including the real avatar bubble** (even in comment threads on anonymous items,
  and even for the anonymous author's own comments). The UI warns an author before
  they comment on their own anonymous item ("commenting will not reveal you as the
  author, but your comment shows your name").
- **Leaderboard exclusion:** contributions made anonymously do not count toward any
  leaderboard (challenges submitted, solutions proposed/implemented, likes received
  on anonymous items). After self-reveal, they count.

*Implementation note:* the §13.1 Challenges page ships full masking — anonymous items
always show "Anonymous" to every viewer, no exceptions. Both the audited admin
**reveal** (transient, reveal-to-you-only) and author **self-reveal** (one-way) live on
the challenge detail page — for the challenge **and for each listed solution**. The
admin reveal opens a **modal dialog** (one for challenges and solutions alike): an
eyebrow naming the item (*"Author of CH-12"* / *"Author of SOL-7"*), the author's
**large** avatar bubble (§13.6), their name and e-mail, a *"Revealed to you only"*
pill and a note that everyone else still sees the item as anonymous and that the
reveal was recorded in the audit log. Closing it (Close, Escape, or a backdrop click)
drops the identity from the page state; nothing else on the page changes. A
self-reveal and its audit row commit in **one transaction**.

> **⚠ GAP-22 · code fix:** `selfRevealSolution` (`api/challenges/store.ts`) runs the
> update and the audit insert on the pool without a transaction; wrap both in
> `inTransaction` like the challenge version.

---

## §10 Editing, withdrawal, deletion

### §10.1 Challenges & solutions

- **Author edit windows:** a challenge is editable by its **author** while
  `awaiting_triage`; a solution while `proposed`. The **`needs_improvement`** status
  re-unlocks editing for the author on either entity. Editing is **author-only** —
  admins moderate via status override + comment deletion, not content edits.
  - **Editable fields** — challenge: title, description, impact area (the §5
    Client↔client-name pairing is re-validated); solution: description, cost vs
    benefits. **Not** editable here: `visibility` (namespace/platform-admin only,
    §4.3), anonymity (removed only via one-way self-reveal, §9), and namespace.
  - Every edit stamps `edited_at` and writes an audit row carrying a **field-level
    diff** (only the changed fields, before → after). Edits fire no notification.
  - Endpoints: `PUT /api/challenges/:number` · `PUT /api/solutions/:number`.
- **Resubmit:** while `needs_improvement`, the author's explicit **"Resubmit"**
  action moves the item to `in_review` and notifies the reviewers (§12.1 event 9).
  Author-only; refused from any other status. The action locks the item's author
  controls while in flight (§6.4). Audited as a `status_changed` row with
  `override:false` and `trigger:"author_resubmit"`. Endpoints:
  `POST /api/challenges/:number/resubmit` and the solution twin.
- **Withdraw:** the author may withdraw their own challenge or solution from any
  **non-terminal** status → `withdrawn` (terminal, soft; content hidden per §4.3).
  Author-only (admins still reach `withdrawn` via their free-set override). Audited as
  a `status_changed` row with `trigger:"author_withdrawn"`; the assignee and existing
  followers are notified (§12.1 event 10). Because a withdrawn item is hidden (§4.3),
  these recipients are delivered directly rather than re-filtered by the item's
  now-restricted visibility — they already had access as followers/assignee, so this
  leaks nothing.
- The §13.1 detail page shows the author an **Edit** form (pre-filled, within the
  edit window), a **Resubmit** button (while `needs_improvement`), and a **Withdraw**
  button (any non-terminal); the detail response carries `canEdit`/`canResubmit`/
  `canWithdraw` so each control renders only when permitted.
- **Authors never delete.** An author's only removal path is **Withdraw** (above) —
  soft and terminal. Permanent removal does exist, but it is a **platform-admin-only**
  action with its own rules (§10.3). Routine cleanup of spam remains admin override to
  `rejected`/`withdrawn` + comment-delete as needed; personal-data erasure remains the
  GDPR scrub (§3).

### §10.2 Comments

- Owner may **edit or delete** their comment within **15 minutes** of posting
  (`edited_at` stamped; delete is soft).
- Namespace/platform admins may soft-delete any comment at any time (audited);
  deleted comments render as "Comment removed by a moderator", preserving thread
  continuity.
- Comment deletion is **soft in every standalone path** — no control anywhere
  hard-deletes a single comment. Comment rows disappear only as part of the §10.3
  parent-delete cascade.

### §10.3 Admin delete (platform admin)

A **platform admin** — and nobody else — may **permanently delete** a challenge or a
solution. This is a **hard delete**: the row is physically removed together with every
child row, and the object-store objects behind it are purged. It is **not** reversible —
no restore, no undelete window, no trash, no tombstone; the item ceases to exist. It
exists for the one case the soft paths cannot serve — content that must actually be gone
(confidential material posted by mistake, a legal takedown) — and not for routine
cleanup, which stays with admin override to `rejected`/`withdrawn` (§7.2, §8.2) plus
comment deletion (§10.2).

**Who.** Platform admins only. Namespace admins do **not** get delete inside their
namespaces, committee members and assignees never do, and an author's only removal path
remains Withdraw (§10.1). Delete is deliberately the one moderation power that is not
delegated per namespace (contrast §14.2).

**When.** Deletable from **any** status, terminal or not — including `solved`,
`implemented`, `rejected`, and `withdrawn`. There is no status gate.

**Cascade.** Deleting a **challenge** removes, in **one transaction**: the challenge
row; **all** of its solutions regardless of status; every comment, like, and follow on
the challenge and on those solutions; every `attachments` row of the challenge and of
those solutions — tombstones included; and every `notifications` inbox row and unsent
`notification_outbox` row targeting any of them; and every `webhook_deliveries` row
(§12.4) targeting any of them. Before the row goes, if the challenge was featured, the
same transaction writes `challenge.unfeatured` (`trigger: "deleted"`, §13.2). Deleting
a **solution** removes the same subtree rooted at that solution and leaves the parent
challenge standing. Any
in-flight chunked-upload session (`attachment_uploads`, §11) for the deleted subtree is
aborted and dropped. The transaction is all-or-nothing: a failure anywhere leaves the
item exactly as it was. "Unsent" means every outbox row not yet `sent` — `pending`, and
`failed` rows still eligible for retry — so no e-mail about the deleted item can go out
afterwards. Notification rows are matched by the **target they carry** (entity type +
id in the payload), not by their link text; every notification payload about a
challenge or solution carries that target.

> **⚠ GAP-23 · code fix:** only comment notifications carry target fields
> (`parentType`/`parentId`/`challengeId`, written by `dispatchCoalescedComment` in
> `web/src/lib/notify.ts`); `dispatchEvent`/`dispatchToUser` (same file) and the
> scan-failure writer in `shared/src/attachments.ts` write `{ message, link }` only, so
> `deleteNotifications` (`api/challenges/delete.ts`) still falls back to the link for
> them. On a solution delete the "solution proposed" row — linked to its challenge,
> without `#SOL-n` (GAP-33) — therefore survives. Add the target type and id to every
> notification payload through those writers and match on them, keeping the link match
> for rows written before.

**Object-store purge.** Once the transaction commits, the MinIO objects of every deleted
attachment are purged — `clean`, `pending`, and author-removed rows alike (an `infected`
row's object was already purged at scan time) — and the parts of any aborted multipart
session are freed. A ClamAV verdict arriving for a row that no longer exists **no-ops**
rather than erroring (the verdict handler is shared, §11).

**Effect on the parent when a solution is deleted.**
- If the deleted solution was **`implemented`** *and* its challenge is currently
  **`solved`**, the challenge reverts to **`valid`** and `resolved_at` is cleared, in the
  same transaction. If an admin has since moved the challenge elsewhere (say to
  `rejected`), its status is left alone — nothing is force-set.
- Siblings closed as `not_selected` by the §8.3 auto-close **stay** `not_selected`. The
  challenge reopens with its existing solutions terminal, and the single-winner slot
  (invariant 7) is free for a new proposal.
- Deleting a solution at any **pre-`implemented`** advanced status
  (`accepted_internally`, `waiting_for_resources`, `in_implementation`,
  `external_acceptance`) changes **nothing** on the challenge — it was still `valid` —
  and simply frees the single-winner slot.
- Nothing else about the parent changes, in any case, beyond the cascade itself.
- The revert is written as a `status_changed` audit row inside the same transaction,
  `override: true`, `trigger: "solution_deleted"`, actor = the deleting admin.

**Notifications: none.** A delete fires no e-mail and no in-app item — not to the
author, not to the assignee, not to followers, not to other admins (§12.1) — and no
channel webhook post (§12.4). The audit
row is the only record. Inbox items for the deleted subtree are removed by the cascade,
so no notification survives pointing at a dead entity.

**Derived state.** Because the rows are gone, the item disappears everywhere by
construction: lists, search vectors, solution and like counts, KPIs, dashboard
spotlights, the Home featured section (§13.2), the triage queue and its attention badge
(§14.4), CSV exports. **Leaderboards recompute without it** — deleting an implemented
solution retroactively removes its author's credit and can change historical ranks
(§13.3). That is accepted.

**Audit.** The delete writes `challenge.deleted` / `solution.deleted` carrying: the
number, entity type, author id, status at deletion, namespace, the per-type counts of
cascaded child rows (including `webhookDeliveries`), and the **mandatory reason** the
admin supplied (free text, required, ≤ 500 chars). It carries **no content** — no title, no description, no client
name, no comment bodies, no attachment filenames. That omission is deliberate: the
action exists to destroy sensitive content, and `audit_log` is exempt from GDPR erasure
(§3, §15), so a content snapshot there would defeat the purpose. Audit rows written
*before* the delete are untouched — `audit_log` is append-only (invariant 5) and its
`target_id` carries no foreign key — and the §15 audit browser renders a target that no
longer resolves as plain text rather than a link.

**Surface.** A **danger zone** on the §13.1 detail page, rendered only for platform
admins — one for the challenge, one per listed solution. The confirm dialog requires the
admin to **type the item's number back** (`CH-42` / `SOL-17`) to enable the button and
to enter the reason; it states plainly that the item, its solutions, comments, and files
are removed permanently and cannot be restored. This mirrors the deliberate friction of
the §14.3 impact-area delete. There is **no bulk delete** — the §14.1 triage queue keeps
bulk assign and bulk status only.

**API.** `DELETE /api/challenges/:number` and `DELETE /api/solutions/:number` (§16),
each taking the reason in the request body and refusing a missing or blank one (422).
The detail response carries **`canDelete`** beside `canEdit`/`canResubmit`/`canWithdraw`
so the control renders only where permitted. A caller who is not a platform admin — and
any caller asking about an item they cannot see — gets **404, not 403**, so the endpoint
cannot be used as an existence oracle (invariant 2). That check runs **first**: the
reason is validated (422) only for a platform admin who can see the item. Anonymity is
unaffected: the audit row records the real author of an anonymous item (audit
legitimately retains PII, §15) while no listing or admin screen surfaces that identity
outside the audited reveal path (invariant 3).

**Database.** A migration grants the app role **DELETE** on `challenges`, `solutions`,
`comments`, `attachments`, `notifications`, and `notification_outbox` (`likes` and
`follows` already have it; `audit_log` never will). Those grants exist to serve this
cascade and nothing else — **no other code path may hard-delete these rows**, and the
soft-delete rules of §10.2 and §11 remain in force everywhere else. The cascade also
removes `webhook_deliveries` rows (§12.4); that table holds DELETE for its own 30-day
trim too, so it is not cascade-only.

**Out of scope.** The GDPR "Delete user info" action (§3) gains no "and delete all their
challenges and solutions" option; it continues to de-identify. `audit_log` rows are
never deleted, by anyone, for any reason (invariant 5).

---

## §11 Attachments

- Allowed on challenges and solutions; uploadable at submission and during any
  author-edit window (§10.1).
- **Limits (platform settings, §14.3):** max attachments per item — default **5**;
  max size per upload — default **10 MB** (its floor is raised to **5 MB** — see
  chunking). Only an **allowlist** of safe content types is accepted (documents,
  images, plain text/CSV, zip); everything else — including executables and
  scripts — is refused outright. The type is judged by the file's **content**, not
  only by the name and type the browser claims (see *content check* below). The
  per-item count cap holds under concurrency: two uploads racing for the last slot
  cannot both succeed.
- **Chunked upload:** a file **larger than the configured chunk size** (platform
  setting, default **5 MB**, §14.3) is sliced by the browser and uploaded **one
  chunk at a time through the server**, which reassembles the chunks into the single
  immutable object — never direct-to-store (invariant 4). Files **at or below** the
  chunk size upload in one request as before.
- Authors may **remove** their own attachment while the parent is within an
  author-edit window (§10.1); removal is a soft-remove (row retained, object
  purged) and audited.
- Objects are stored immutably in MinIO; DB rows carry metadata + `scan_status`.
- **Scan pipeline:** uploads enter `pending` (visible only to the uploader as
  "scanning…"). When ClamAV is reachable, an upload is **scanned on-demand as soon
  as its bytes are complete**, so the verdict is known within moments; a
  leader-elected **worker sweep** remains the fallback for rows left `pending`. The
  verdict moves the row to `clean` (visible per parent visibility) or `infected`
  (blocked, uploader notified, audited). A file the scanner keeps **failing on** — not
  an outage, but clamd answering with an error for that particular file — is retried
  with backoff and, after a bounded number of attempts, moves to a terminal
  **`unscannable`** state, treated exactly like `infected` for serving (never
  downloadable, uploader notified, audited). A file is therefore never `pending`
  forever, and never served without a clean verdict. The uploader notification
  (§12.1 event 11) is for files **bound** to a challenge or solution; a **staged** file's
  failure is shown in the submission form's upload control instead, which is where the
  author acts on it, and creates no inbox item or e-mail.
- **Submission blocks on the scan when a scanner is available:** a challenge or
  solution cannot be submitted while any of its files is `pending`, `infected`, or
  `unscannable` —
  the author waits for the (fast) clean verdict or removes the file, so a submitted
  item is only ever born with `clean` attachments. **If ClamAV is unavailable** (a
  live health probe fails) the platform **fails open**: submission proceeds with
  files left `pending`; the worker scans them later and they stay undownloadable
  until `clean`. Enforcement is decided server-side (§6.1/§6.2).
- Download exclusively via the authenticated gateway route enforcing parent
  visibility (invariant 4). Presigned/direct URLs are never exposed.

*Implementation design (this change concretizes the bullets above):*

- **Schema** (`attachments`, §5): `id` uuid, `parent_type` (challenge|solution),
  `parent_id`, `filename`, `size_bytes`, `mime`, `object_key` (unique), `scan_status`
  (`pending`|`clean`|`infected`|`unscannable`, default `pending`), `scanned_at`,
  `scan_attempts` int (default 0), `next_scan_at` timestamptz (nullable — the earliest
  time the sweep may retry), `removed_at`, `uploaded_by`, `created_at`. Indexes on
  `(parent_type, parent_id)` and `(scan_status, next_scan_at)`; the app DB role gets
  INSERT/SELECT/UPDATE (no DELETE — infected, unscannable, and author-removed rows stay
  as tombstones; the MinIO object is purged in all three cases).
- **Upload-session schema** (`attachment_uploads`, new) — tracks one in-flight chunked
  upload between *initiate* and *complete*: `id` uuid (the client-facing upload id),
  `attachment_id` uuid (pre-allocated at initiate, forms the eventual `object_key`),
  `parent_type`, `parent_id` (nullable), `draft_key` (nullable; same
  one-of-{`parent_id`,`draft_key`} CHECK as `attachments`), `filename`, `mime`,
  `declared_size_bytes` bigint, `object_key`, `s3_upload_id` text (the MinIO
  multipart-upload id), `chunk_size_bytes` bigint, `uploaded_by` uuid, `created_at`. A
  DB CHECK enforces the same one-of-{`parent_id`,`draft_key`}. Index on
  `(uploaded_by, created_at)` for the stale-session sweep. Unlike `attachments`, this is **deletable working state** — the
  app DB role gets DELETE here; a row is dropped on complete (its `attachments` row
  takes over) or on abort. Single-shot uploads never create one.
- **Single-shot upload (files ≤ chunk size)** — `POST /api/attachments` (multipart: `parentType`, `file`, and **either**
  `parentId` for a **bound** upload **or** `draftKey` for a **staged** upload — see
  *Staged upload* below). A **bound** upload is allowed **only** to the parent's author
  and **only while the parent is in an author-edit window** (§10.1: challenge
  `awaiting_triage`/`needs_improvement`, solution `proposed`/`needs_improvement`). The
  parent's visibility is checked **first** (§2.4): a caller who cannot see the parent
  gets 404, and only then does a non-author get 403. The same order applies to a bound
  chunked-upload initiate.

  Either
  path enforces the §14.3 limits (reject over-count 409, over-size 413) and validates the
  type against an **allowlist** — the file's extension **and** its declared MIME must
  both be in the set, else 415:
  - **Documents** — `.pdf`, `.doc`/`.docx`, `.xls`/`.xlsx`, `.ppt`/`.pptx`,
    `.odt`/`.ods`/`.odp`, `.rtf`
  - **Text** — `.txt`, `.csv`, `.md`
  - **Images** — `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp` (SVG is excluded — it can
    carry script)
  - **Archives** — `.zip` (ClamAV recurses into it during the scan)

  **Content check.** The extension and the claimed MIME come from the client, so the
  server also checks the file's **leading bytes** against its extension, and rejects a
  mismatch with **415** ("The file's contents don't match its type."):
  - `.pdf` starts `%PDF-`; `.png` the PNG signature; `.jpg`/`.jpeg` `FF D8 FF`;
    `.gif` `GIF87a`/`GIF89a`; `.webp` `RIFF…WEBP`; `.rtf` `{\rtf`.
  - `.docx`/`.xlsx`/`.pptx`/`.odt`/`.ods`/`.odp`/`.zip` start with a ZIP local-file
    header (`PK\x03\x04`).
  - `.doc`/`.xls`/`.ppt` start with the OLE2 compound-file signature
    (`D0 CF 11 E0 A1 B1 1A E1`).
  - `.txt`/`.csv`/`.md` contain **no NUL byte** in their first 8 KB.

  A single-shot upload is checked at upload; a chunked upload is checked on **part 1**
  (the part carrying the file's first bytes), so a mismatched file fails fast.

  On success the bytes are written to MinIO — **bound** rows under
  `object_key = <parentType>/<parentId>/<attachmentId>`, **staged** rows under
  `object_key = drafts/<draftKey>/<attachmentId>` (the key is **never rewritten when a
  staged row is bound**) — the row is inserted `pending`, `attachment.uploaded` is
  audited, and the **on-demand scan** (below) runs. A file **larger than the chunk
  size** instead uses the chunked protocol below, which reuses this bullet's cap /
  size / type validation.
- **Staged upload (submission, §6.1/§6.2)** — the submission forms attach files **before
  the parent exists**, so their uploads carry a client-generated **`draftKey`** (UUID)
  instead of a `parentId`. A staged row has `parent_id = null`, `draft_key = <key>`,
  `parent_type` = the eventual type (`challenge`|`solution`), `uploaded_by` = the caller;
  a DB CHECK enforces that **exactly one** of `parent_id`/`draft_key` is set. Any
  authenticated user may stage. The §14.3 cap and size/type limits apply to the caller's
  own non-removed rows for that `draftKey`. Staged rows are scanned **on-demand at upload**
  (sweep as fallback), are **listable only to their uploader** via `GET /api/attachments?draftKey=<key>`
  (status only — bytes are never served for an unbound row), and are removable by their
  uploader via `DELETE /api/attachments/:id` **with no edit-window requirement** (there
  is no parent yet). They are invisible to everyone else and have no visibility of their
  own until bound.
- **Chunked upload (files > chunk size)** — larger files never post as one request; the
  browser slices them into `chunkSizeMb`-sized parts and drives a three-step,
  **server-proxied** protocol (no presigned/direct-store URLs — invariant 4). It targets
  a **bound** parent (`parentId`) or a **staged** draft (`draftKey`) exactly like the
  single-shot path:
  - **Initiate** — `POST /api/attachments/uploads` (`parentType`, one of
    `parentId`/`draftKey`, `filename`, `mime`, declared `size`). The server validates the
    §14.3 cap, `size` ≤ max-upload, and the extension+MIME allowlist **up front —
    fail-fast** (same 409/413/415 as single-shot), pre-allocates the `attachmentId` and
    its `object_key`, opens a **MinIO multipart upload**, writes an `attachment_uploads`
    session row, and returns `{ uploadId, chunkSizeBytes }`. Before opening the new session it
    **aborts the caller's own stale sessions** (see *Upload-session GC*).
  - **Send parts** — `PUT /api/attachments/uploads/:uploadId/parts/:n` streams one chunk;
    the server relays it to MinIO `UploadPart` (part `n`). Every non-final part is exactly
    `chunkSizeMb` (≥ 5 MB — the S3 multipart part floor, which is why the setting's minimum
    is 5 MB); the final part may be smaller. Only the session's `uploaded_by` may send parts.
    **The declared size is binding.** With `N = ceil(declared size / chunk size)` parts,
    the server rejects (400, nothing relayed to MinIO) a part whose number is outside
    `1…N`, a non-final part (`n < N`) that is not exactly the chunk size, and a final part
    (`n = N`) that is not exactly `declared size − (N − 1) × chunk size`. Re-sending a part
    number already sent (a retry) replaces it. Together these bound the stored object to
    the declared size, which was checked against max-upload at initiate.
  - **Complete** — `POST /api/attachments/uploads/:uploadId/complete` first **verifies the
    assembly**: the store must hold exactly parts `1…N`, each the size the rule above
    requires, so their sum equals the declared size. On any mismatch (a missing part, or
    sizes that don't add up) the upload is **aborted** — `AbortMultipartUpload`, session row
    dropped, `attachment.upload_aborted` audited with reason `size_mismatch` — and the
    request fails with 400 `upload_incomplete`; no `attachments` row is created and the
    client must start a new upload. On success it runs `CompleteMultipartUpload`, inserts
    the `pending` `attachments` row (bound or staged, exactly as single-shot) with
    `size_bytes` = the verified size, deletes the session row, audits `attachment.uploaded`,
    runs the **on-demand scan**, and returns the `AttachmentView`. **Every** path on which
    `complete` aborts the session audits `attachment.upload_aborted` with its reason:
    `size_mismatch` (above); `parent_not_found` (the bound parent has vanished or the
    caller can no longer see it); `forbidden` (the caller is not the parent's author);
    `not_editable` (the parent has left its author-edit window); and `too_many` (the
    §14.3 cap was reached in the meantime — whether found before reassembly or by the
    locked re-count after it, in which case the reassembled object is deleted).

    > **⚠ GAP-26 · code fix:** in `completeChunkedUpload` (`api/attachments/store.ts`),
    > the `abortAnd` paths for `not_found` / `forbidden` / `not_editable` / `too_many`,
    > and the post-assembly `too_many` refusal (`dropAssembled`), drop the session
    > without an audit row. Audit each with the reason above.
  - **Failure** — a failed part is **retried by the browser** when the failure is a
    network error, a 5xx or a 429: up to **3** attempts in all for that part, waiting
    **1 s** before the second and **2 s** before the third (re-sending a part number
    replaces it, above). Any other 4xx is never retried, and nothing is retried once the
    user has cancelled. Only when a part still fails after its attempts, or the user
    cancels, is the session aborted and the file abandoned. An **abort**
    (`POST …/abort`, or the GC) runs `AbortMultipartUpload`, frees the orphaned MinIO parts,
    drops the session row, and audits `attachment.upload_aborted`. No partial object is ever
    exposed (no `attachments` row exists until complete).

    > **⚠ GAP-27 · code fix:** `uploadFileInChunks` in `web/src/lib/chunked-upload.ts` aborts
    > the whole session on the first failed part (its header comment calls this the
    > approved design; this spec supersedes it). Retry each part as above before
    > aborting, with unit tests for the retry classification.
- **Binding at submit** — `POST /api/challenges` and the solution-create endpoint accept
  an optional `draftKey`. Inside the create transaction the server takes the caller's
  staged rows for that key (`uploaded_by = caller`, `parent_id is null`, `removed_at is
  null`, matching `parent_type`), re-checks the §14.3 cap, sets `parent_id = <new id>`,
  clears `draft_key`, and audits `attachment.bound` per row; `object_key` is left as-is
  (no MinIO move). **Scan gate:** when a scanner is available the create is **rejected**
  (409 `attachments_not_clean`) if any staged row for that key is still `pending`,
  `infected`, or `unscannable` — the author must let the (on-demand) scan finish or remove the file, so a
  submitted item is only ever born with `clean` attachments. When ClamAV is unavailable
  (the health probe fails) the gate is **skipped** and `pending` rows bind as before,
  scanning later. A caller can only bind rows they uploaded, so a foreign `draftKey`
  binds nothing. Anonymity is unaffected:
  `uploaded_by` is retained but never sent to the client (invariant 3). The gate and the
  cap re-check run **inside** the create transaction, on the staged rows locked
  `FOR UPDATE`, so a file staged or still scanning at that moment cannot slip through.
  Either refusal rolls the whole create back and answers **409** with a `code` beside
  its message: an unclean staged row → `code: "attachments_not_clean"`; more staged rows
  than the cap allows → `code: "attachments_over_limit"` (rather than binding some and
  silently dropping the rest).

  > **⚠ GAP-28 · code fix:** `hasUncleanStagedAttachments` (`api/attachments/store.ts`)
  > runs on the pool before `inTransaction` in `createChallenge`/`createSolution`
  > (`api/challenges/store.ts`), so a row staged in between can bind while `pending`;
  > `bindStagedAttachments` skips rows over the cap (`limit $5` = `maxPerItem`) instead
  > of refusing; and the 409s in `api/challenges/route.ts` and
  > `api/challenges/[number]/solutions/route.ts` carry no `code`. Lock the staged rows
  > `FOR UPDATE` inside the transaction, run both checks there, and return the two codes.
- **Author removal** — `DELETE /api/attachments/:id`: allowed **only** to the
  uploader (who is the parent's author) and **only while the parent is in an
  author-edit window** (§10.1); **unbound staged rows are removable by their uploader at
  any time** (no parent, no window). Soft-remove: `removed_at` is stamped, the MinIO
  object is purged, the row is retained as a tombstone, and `attachment.removed` is
  audited. A removed attachment no longer counts toward the §14.3 per-item cap.
- **On-demand scan (web tier)** — immediately after an upload's bytes are complete
  (single-shot, or a chunked `complete`), the web tier streams the freshly stored object
  to `clamd` (INSTREAM on `CLAMAV_HOST:CLAMAV_PORT`, via the shared framing helpers) and
  applies the verdict inline through the **same verdict handler the sweep uses** (below).
  This is best-effort: if clamd is unreachable or the scan errors transiently, the row is
  left `pending` for the sweep. A **short-TTL-cached clamd health probe** yields the
  `scanAvailable` signal consumed by the §6.1/§6.2 submit gate and surfaced to the UI.
- **Scan sweep (worker, fallback)** — a leader-elected sweep (mirrors the notification
  sweep; ~15 s) selects `pending` rows, streams each object from MinIO to ClamAV, then
  applies the verdict + `scanned_at`. On both paths "streams" is literal: the object is
  piped from MinIO into clamd's INSTREAM in chunks and is **never buffered whole in
  memory** — uploads may be up to 200 MB (§14.3).

  The verdict: **Infected** → the object is deleted from MinIO (the
  row stays as an `infected` tombstone), the uploader is notified (§12.1 event 11), and
  `attachment.scan_infected` is audited; **clean** → `attachment.scan_clean` audited.
  Removed rows (staged or bound) are excluded from scanning. The verdict handler is
  **shared** with the on-demand path, so behaviour is identical whichever fires first
  (and the sweep is idempotent for a row the web tier already resolved).
- **Scan retries** — two kinds of failure are told apart:
  - **Engine unavailable** (clamd unreachable, connection refused or reset, the health
    probe failing): the row stays `pending`, `scan_attempts` is **not** incremented, and
    the next sweep tries again. An outage never condemns a file.
  - **Per-file error** (clamd answered, but with an error for this stream, or the
    object could not be read from MinIO): `scan_attempts` is incremented and
    `next_scan_at` is pushed out with exponential backoff (1 min, 2, 4, 8 … capped at
    1 h). At **8** attempts the row moves to **`unscannable`**: the object is purged, the
    uploader is notified (§12.1 event 11), and `attachment.scan_unscannable` is audited
    with the last error class (never file content).

  The sweep selects `pending` rows whose `next_scan_at` is null or past, oldest first, so
  a file that keeps failing cannot hold back newer uploads.
- **Scanner limits** — the shipped clamd configuration keeps its stream and scan limits
  **at or above** the platform's maximum upload size (§14.3 allows up to 200 MB), so a
  permitted upload is never rejected for size. It also turns **on** the alerts for
  content the engine cannot inspect — limits exceeded inside an archive, and encrypted
  archives or documents — which clamd then reports as a detection. Such a file is
  therefore **`infected`** (failed scan), not silently passed: content the scanner cannot
  see is not served.
- **Draft GC sweep (worker)** — a second leader-elected sweep purges **abandoned staged
  uploads**: unbound rows (`parent_id is null`, `removed_at is null`) older than **24
  hours** have their MinIO object deleted and `removed_at` stamped — the row survives as
  a tombstone (the app DB role has no DELETE) and `attachment.draft_expired` is audited.
- **Upload-session GC** — abandoned **chunked-upload sessions** are reaped two ways:
  (1) at **initiate**, the caller's own `attachment_uploads` rows older than **2 hours**
  are `AbortMultipartUpload`ed and dropped before the new session opens; (2) the worker's
  housekeeping sweep does the same across **all** stale sessions (> 2 h) as a backstop.
  Each abort frees the orphaned MinIO parts and audits `attachment.upload_aborted`. No
  `attachments` row exists for these, so nothing was ever visible or downloadable.
- **Parent delete (platform admin, §10.3)** — the one path that removes `attachments`
  rows outright. When a challenge or solution is hard-deleted, its attachment rows go
  with it — `clean`, `pending`, `infected`, and author-removed tombstones alike — and
  their MinIO objects are purged once the transaction commits; any open chunked session
  for the subtree is aborted. A scan verdict arriving for a vanished row no-ops. This is
  the **sole** carve-out from the retention rule above; no other code path may DELETE
  from `attachments`.
- **Attachment visibility** (§4.3): an attachment inherits its parent's visibility.
  Author-**removed** rows (`removed_at` set) are never listed to anyone. `pending`,
  `infected`, and `unscannable` rows are listed **only to the uploader** (as
  "scanning…" / "removed — failed scan" / "removed — couldn't be scanned"); `clean` rows
  are listed to anyone who can see the parent. The list
  never exposes the uploader's identity, preserving anonymity (invariant 3) — the
  per-status affordance is decided server-side by comparing the viewer to
  `uploaded_by`, which is never sent to the client. Bytes are never served for
  `pending`/`infected`/`unscannable`/removed rows.
- **Download gateway** (invariant 4) — `GET /api/attachments/:id`: auth-required,
  re-checks parent visibility, and streams the object **only when `scan_status=clean`
  and `removed_at is null`** (Content-Disposition: attachment). Any denial (not
  visible / not clean / removed) returns the same 404 and is audited
  `attachment.download_denied`. No presigned/direct MinIO URLs are ever emitted.
  The bytes are **streamed** from MinIO to the client, never buffered whole in memory.
  A served attachment always carries `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox; default-src 'none'`, on top of the §2.4 baseline.
  So even if a file were opened in place, or pulled in by a `<script>`/`<link>` tag on
  another page, it could not run as script or style in the app's origin.
- **UI** — one upload control is used identically on **all three surfaces**: the §6.1
  challenge form, the §6.2 solution form, and the §13.1 detail-page author-edit section.
  Each file moves through **two visually distinct phases**: **Uploading** — a **progress
  bar** (bytes sent / total) for a chunked file, or a **spinner** for a single-shot file
  ≤ the chunk size — then **Scanning…** — an indeterminate indicator until the verdict —
  then **Ready** (clean), **Failed scan** (infected, removable), or **Couldn't be
  scanned** (unscannable, removable — the author may try again with a different file).
  A file may be removed at any phase. On the two **submission forms** (backed by a per-form `draftKey`) the
  **Submit button is disabled while any file is Uploading, Scanning…, Failed, or
  Couldn't be scanned**
  whenever scanning is enforced (`scanAvailable`); when a scanner is unavailable the gate
  lifts and still-`pending` files may be submitted. The detail-page control has no submit
  to block — a bound file simply isn't downloadable until `clean` (unchanged gateway
  rule). Abandoned staged files are GC'd after 24 h; abandoned chunk sessions after 2 h.
  The §12.1 matrix keeps **event 11 — Attachment failed its scan → the uploader**.
  "Removed at any phase" includes **Uploading**: while a file is in flight its control
  is labelled **Cancel** and aborts the in-flight request (and, for a chunked file, the
  session); once the file has landed (Scanning…, Ready, Failed scan, Couldn't be
  scanned) the control is labelled **Remove**. While a file is **Scanning…** the
  control polls its status so the phase advances without a page reload, and the
  progress bar carries `role="progressbar"` with its value.

  > **⚠ GAP-30 · code fix:** `components/AttachmentControl.tsx` labels the in-flight
  > row's cancel button "Remove"; label it "Cancel".

---

## §12 Notifications & follows

### §12.1 Event matrix

Every event produces **an e-mail and an in-app inbox item**, both fed from the same
outbox table and dispatched by the worker (at-least-once, retry with backoff). A failed
send is retried on an exponential schedule — 1 min after the first failure, then 2, 4,
8 … minutes, capped at 60 — for at most **5** attempts in all, after which the row
stays `failed`; the next attempt time is recorded per row in the outbox's
`next_attempt_at`. A Graph `429` ends
the current batch and schedules that row's retry no earlier than its `Retry-After`:
the next attempt is the later of the backoff and the `Retry-After`.

> **⚠ GAP-31 · code fix:** `worker/src/notifications/dispatch.ts` applies only
> `emailRetryDelayMinutes` on a 429; `GraphSendError.retryAfterSeconds`
> (`shared/src/email-graph.ts`) is never read. Set `next_attempt_at` to
> max(backoff, Retry-After) for a 429.
E-mail is sent via **Microsoft Graph `sendMail`** from a dedicated service mailbox
(e.g. `innobox@example.com`) that a platform admin connects on the Administration page
through a delegated consent flow (`Mail.Send` + `offline_access`, admin-consented).
The consent flow uses a **separate Entra app registration** ("InnoBox Email",
`ENTRA_EMAIL_CLIENT_ID` / `ENTRA_EMAIL_CLIENT_SECRET`) that carries only
`Mail.Send` + `offline_access` delegated permissions and has "Assignment required = Yes"
with only the service mailbox account assigned — keeping `Mail.Send` entirely off the
OIDC app so it cannot be exercised on behalf of regular users.
The OAuth tokens are stored encrypted at rest (`EMAIL_TOKEN_ENC_KEY`) with automatic
renewal, and an env-configured SMTP transport serves as the optional plain-text
fallback. All Graph mails render inside one branded HTML wrapper template, so the
Graph transport is used only once the service mailbox is connected **and** a wrapper
has been saved (§14.3); until then mail goes through the SMTP fallback when it is
configured, and is not sent otherwise (the in-app item is unaffected). The per-user
e-mail opt-out (§13.5) is honored at dispatch (in-app items are always delivered):

| # | Event | Recipients |
|---|---|---|
| 1 | Challenge submitted | Namespace admins of the target namespace |
| 2 | Solution proposed | Namespace admins + committee, challenge author, challenge followers |
| 3 | Status changed (challenge or solution) | Item author, assignee, followers |
| 4 | Rejected | Item author (distinct template) |
| 5 | Needs improvement | Item author (call-to-action: edit & resubmit) |
| 6 | Comment posted | Item author, other commenters on the item, followers — **never the commenter** |
| 7 | Challenge assigned / unassigned | The assignee; on a reassignment also the previous assignee (unassigned, §7.3) |
| 8 | Solution implemented (auto-close) | Challenge author, authors of `not_selected` siblings, followers of the challenge and its solutions |
| 9 | Resubmitted (`needs_improvement` → `in_review` by the author, §10.1) | Namespace admins + committee, the assignee, followers |
| 10 | Withdrawn (by the author, §10.1) | Namespace + platform admins, the assignee, and existing followers — delivered directly (a withdrawn item is hidden per §4.3, but admins retain access and the assignee/followers already had it) |
| 11 | Attachment failed its scan, or couldn't be scanned (§11) | The uploader — bound files only; a staged file's failure shows in the form (§11) |
| 12 | Open assignments transferred on erasure (§3) | The successor — **one** summary item per erasure |

"Assignee" in events 3 and 9 means the **challenge's** assignee, including for an
event on one of its solutions. "Challenge author" in event 8 is a recipient in its own
right, not only through an auto-follow.

Rules: recipients are deduplicated per event; actors never notify themselves;
recipients outside the item's visibility are dropped (invariant 2); anonymity-safe
rendering (§9). Deep links point to the canonical routes under `PUBLIC_BASE_URL`:
`<PUBLIC_BASE_URL>/challenges/:number` for a challenge, and
`<PUBLIC_BASE_URL>/challenges/:number#SOL-<n>` for **anything about a solution** —
its status, a comment on it, its proposal (there is no standalone solution page,
§13.1).

> **⚠ GAP-33 · code fix:** the "solution proposed" notification
> (`api/challenges/[number]/solutions/route.ts`) links to `/challenges/N` without the
> `#SOL-<n>` anchor; build it with `itemHref` (`lib/deep-link.ts`) as comment
> notifications already do.
Delivery is immediate — there is no scheduled digest (§19); the one batching
mechanism is the per-item coalescing of comment notifications below.

**Per-event preferences (follower-derived events).** Three profile toggles (§13.5),
all default **on**, stored on `users` as `notify_followed_comments`,
`notify_followed_status`, `notify_followed_solutions` (boolean, not null, default
true; existing users backfilled on):

- *Comments on items I follow* — gates **event 6** for **every** recipient route
  (item author, other commenters, followers). A mute is a mute: an author who turns
  it off hears no comments on their own item either.
- *Status changes on items I follow* — gates **event 3** for followers **and**
  authors. It does **not** touch the actionable author/assignee events — 4 (rejected),
  5 (needs improvement), 7 (assigned), 8 (implemented), 11 (scan failed), 12
  (assignments transferred) — which stay non-mutable.
- *New solutions on challenges I follow* — gates **event 2** for the challenge author
  and followers; the admin/committee recipients of event 2 are unaffected.

These are **row-level, applied at insert time**: an opted-out recipient is removed
from the recipient set before either the inbox row or the outbox row is written — no
bell, no e-mail, nothing to deliver. The e-mail switch (§13.5) stays **channel-level**
and orthogonal: it suppresses e-mail for rows that *do* exist. The four **admin
attention events** (1, 2, 9, 10 to namespace/platform admins) are **never mutable** —
triage is a duty, and the §14.4 badge is not a substitute for a muted mail. Toggling is
silent (not audited, like the e-mail switch) and forward-only: flipping off deletes
nothing already delivered, flipping on backfills nothing missed.

**Coalesced comment notifications (event 6).** Comment notifications are **one inbox
row per recipient per item**, not one per comment. The first comment inserts the row
(`type = comment_posted`, payload: parent, `count: 1`, `latestBy`, `latestAt`); every
further comment on the same item **while that row is unread** updates it in place
(an atomic upsert against the §5 partial unique index): `count` incremented,
`latestBy`/`latestAt` refreshed, `created_at` bumped so it re-sorts to the top. The
update **preserves the row's outbox/delivery bookkeeping** — the e-mail went out with
the first comment and is **not re-sent** on refresh — so a recipient receives **at most
one e-mail per item until they read it**; once read, the next comment starts a fresh
row (and a fresh e-mail). Copy: *"3 new comments on CH-412 — latest by Alice"*
(comments carry no anonymity option, so the commenter's name is safe; the item's own
author stays masked per §9). **Read actions:** opening the inbox row, mark-all-read,
**or opening the item's detail page** all mark that item's row read. **Only event 6
coalesces**; every other event remains one row per occurrence.

**Event 12 (assignments transferred)** replaces event 7 for the moves an erasure makes
(§3): one item, not one per challenge. Message: *"N challenges were reassigned to you
from a removed account: CH-12, CH-40, …"* (at most 10 numbers, then *"and K more"*); it
never names the erased person. Link: the lowest-numbered moved challenge. Every listed
challenge is visible to the recipient by construction, because the move was gated on
it.

**E-mail content safety.** A notification e-mail comes from the organization's trusted
service mailbox, so it must not lend that trust to links a user wrote:
- **Only links to the app itself are clickable.** In the HTML body, a URL is turned into
  a link **only** when its origin equals `PUBLIC_BASE_URL`'s. Any other URL that appears
  in user-written text (a challenge title, a comment excerpt) is rendered as plain,
  escaped text: still readable and copyable, but never an anchor. The plain-text (SMTP)
  body is unchanged; it has no anchors.
- **The admin-authored HTML wrapper is sanitized by a real HTML parser** against an
  explicit allowlist of e-mail-safe elements and attributes (layout tables, text
  formatting, images, links), not by pattern matching. Anything off the list is dropped:
  script, style, `<meta>`, `<base>`, `<link>`, forms, frames, every `on*` attribute,
  and any URL whose scheme isn't `https`, `mailto`, or `cid`. The sanitizer runs when the
  wrapper is saved **and** again when it is rendered, so a row stored before a sanitizer
  change is still cleaned on use. HTML comments, including the conditional comments
  that HTML e-mail layouts depend on, are kept as-is: browsers treat them as inert.

**Admin notifications.** Wherever **namespace admins** appear as recipients
(events 1, 2, 9, 10), **all platform admins are included too** for global oversight;
the dispatch helper resolves both from SCIM-synced membership + `role_mappings`
(invariant 1), never from token claims. These four are the *attention* events — an
item that enters or returns to the triage/review court (submitted, proposed,
resubmitted, withdrawn). Routine forward transitions driven by committee/assignees
(events 3–5, 8) deliberately do **not** notify admins; the §14.4 attention badge, not
a per-transition mail, is how admins track the standing queue.

**Admin delete fires nothing.** A platform-admin delete (§10.3) produces no e-mail and
no in-app item for anyone — the audit row is the only record — and the cascade removes
the inbox and unsent-outbox rows of the deleted subtree. The matrix above therefore has
no delete event, by design.

**Curation is silent.** Featuring/unfeaturing (§13.2) notifies no one.

**Channel webhooks** (§12.4) are a separate, namespace-level channel with their own
outbox; they are not rows of this matrix and are not affected by any user preference.

### §12.2 In-app inbox

Bell icon with unread count; inbox lists notifications newest-first with read/unread
state, mark-read and mark-all-read. In-app notifications are always on; the per-user
opt-out (§13.5 profile) affects e-mail only, and the §12.1 per-event preferences
remove a recipient before any row exists. A coalesced comment row (§12.1) renders its
count and latest commenter; the platform admins' `system.error` alert (§14.7) is an
ordinary inbox row that is never e-mailed. The 30-second unread poll also carries the
active §14.6 system banner, so no second poll exists for it.

### §12.3 Follows

Any user may follow/unfollow any challenge or solution they can see. Authors and
assignees are auto-followed to their items (can unfollow). Followers receive events
3, 6, 8 (and 2 for challenge followers).

### §12.4 Channel webhooks

A **platform admin** may attach **channel webhooks** to a namespace. Each one posts a
short announcement to a team channel when a milestone happens on an **org-visible**
item of that namespace: a Microsoft Teams channel through a Teams Workflows webhook, or
any receiver that accepts generic JSON.

Webhooks are deliberately **not** part of the §12.1 notification pipeline. They have
their own outbox, never create inbox rows or e-mails, and have no per-user variant
(per-user webhooks are out of scope, §19).

**Events.** Exactly three. Each is enqueued on the real transition that causes it,
enforced or override, from the detail page, the triage bulk-status action, or the §8.3
auto-close:

| Event | Fires when | Item posted |
|---|---|---|
| `challenge.validated` | a challenge enters `valid` **for the first time** (new challenge open for solutions after triage) | the challenge |
| `solution.implemented` | a solution enters `implemented` | the solution |
| `challenge.solved` | a challenge enters `solved` (by §8.3 auto-close or by admin override) | the challenge |

- "First time" is pinned by `challenges.first_valid_at` (§5). It is set on the first
  transition into `valid` and never cleared. A challenge that leaves `valid` and
  returns, including the §10.3 `solved → valid` revert, never posts
  `challenge.validated` again.
- `solution.implemented` and `challenge.solved` post on every real transition into
  those statuses. Both are terminal, so re-entry needs a deliberate admin override.
- The §8.3 auto-close therefore posts **both** `solution.implemented` and
  `challenge.solved`, enqueued in that order. Both are kept by design; a JSON receiver
  can filter on `event`, and there is no per-webhook event selection.
- A platform-admin delete (§10.3) posts nothing.

**Routing.** An item goes **only to its own namespace's** enabled webhooks. The
`global` namespace's webhooks post org-visible items of `global` only. There is no
fan-out to other namespaces, and no all-namespaces webhook. Archived namespaces keep
posting; archiving blocks new submissions, not milestones.

**Leak guard (invariants 2–3).** A delivery is sent only if the item passes the §13.5
**org-visible test** (the test an arbitrary authenticated viewer would pass):
- the challenge, or a solution's parent challenge, is `org`-visible and is not
  `awaiting_triage` or `withdrawn`;
- a solution is additionally not `proposed` or `withdrawn`.

The test runs **twice**:
- **At enqueue.** An item failing it enqueues nothing.
- **Again in the worker immediately before sending.** An item that has since become
  `namespace`-visible, been withdrawn, or been deleted is **skipped**. That is not a
  failure and writes no system-log row.

A namespace-restricted item is never posted, and becoming `org`-visible later does not
post it retroactively.

**Anonymity** is structural: the payload carries **no author, assignee or any other
person field**, so there is nothing to mask. Comments, descriptions and attachments are
never included.

**Payload, generic JSON format** (`Content-Type: application/json; charset=utf-8`).
Exactly these fields:

```json
{
  "schema": "innobox.webhook.v1",
  "event": "challenge.validated",
  "occurredAt": "2026-10-08T12:34:56Z",
  "namespace": "global",
  "item": {
    "type": "challenge",
    "number": "CH-42",
    "title": "Reduce onboarding time for new joiners",
    "status": "valid",
    "url": "<PUBLIC_BASE_URL>/challenges/42"
  }
}
```

- `occurredAt` is the transition time (UTC, second precision).
- `namespace` is the namespace's current **slug**.
- `status` is the canonical status the event is about (`valid`, `implemented`,
  `solved`).
- `url` is built server-side from `PUBLIC_BASE_URL` (§12.1 deep-link convention).
- For a solution: `number` is `SOL-<n>`, `title` is the **parent challenge's** title
  (solutions have none), and `url` is `…/challenges/<n>#SOL-<m>`.
- `title` is read at send time. `status` and `occurredAt` are snapshotted at enqueue.

**Payload, Teams Workflows format.** This targets the Teams **Workflows** template
"Post to a channel when a webhook request is received". That template expects a
`message` envelope wrapping one Adaptive Card attachment:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "contentUrl": null,
      "content": {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "body": [
          { "type": "TextBlock", "text": "New challenge open for solutions", "weight": "Bolder", "size": "Medium", "wrap": true },
          { "type": "RichTextBlock", "inlines": [ { "type": "TextRun", "text": "CH-42 · Reduce onboarding time for new joiners" } ] },
          { "type": "FactSet", "facts": [
              { "title": "Status", "value": "Valid — open for solutions" },
              { "title": "Namespace", "value": "global" } ] },
          { "type": "TextBlock", "text": "{{DATE(2026-10-08T12:34:56Z,SHORT)}} {{TIME(2026-10-08T12:34:56Z)}}", "isSubtle": true, "size": "Small", "wrap": true }
        ],
        "actions": [
          { "type": "Action.OpenUrl", "title": "Open in InnoBox", "url": "<PUBLIC_BASE_URL>/challenges/42" }
        ]
      }
    }
  ]
}
```

- **Headings:**
  - `challenge.validated`: *"New challenge open for solutions"*
  - `solution.implemented`: *"Solution implemented"*
  - `challenge.solved`: *"Challenge solved"*
  - the test send: *"Test message — this channel is connected to InnoBox"*
- The status fact uses the §7.1/§8.1 **display** label.
- The time line uses the Adaptive Card `DATE`/`TIME` functions, so Teams renders it in
  each reader's local time ("store UTC, convert at display", §2).
- **User text is never formatted.** The title travels only as a `TextRun` inside a
  `RichTextBlock`, which Adaptive Cards render as plain text, with no link or emphasis
  syntax interpreted. A title containing `[text](https://…)` cannot become a link.
- The only actionable element is the `Action.OpenUrl`, whose URL is always under
  `PUBLIC_BASE_URL`. This is the card analogue of §12.1 *E-mail content safety*.

**Request.**
- `POST`, body ≤ 16 KB.
- Headers:
  - `User-Agent: InnoBox-Webhook/<APP_VERSION>`;
  - `X-InnoBox-Event: <event>`;
  - `X-InnoBox-Delivery: <delivery id>`. The delivery id is stable across retries, so
    a JSON receiver can deduplicate. Delivery is at-least-once.
- There is no HMAC payload signature: the secret URL is the credential, the same model
  as Teams.
- Any **2xx** response is success. Teams Workflows answers `202 Accepted`.
- The response body is read up to 64 KB and discarded.

**URL rules and the SSRF guard** (§2.4 *Outbound requests*). These are enforced when a
webhook is saved, and again at **every** send, the send-time check being the
authoritative one.
- **Scheme and form:** `https:` only. Port 443 (implicit or explicit). No userinfo
  (`user:pass@`). ≤ 2 048 characters. A syntactically valid absolute URL.
- **Address check after DNS resolution:** the host is resolved (A and AAAA), and the
  request is refused if **any** resolved address is not public. Refused ranges:
  - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`,
    `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`,
    `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`;
  - IPv6: `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`;
  - IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses are judged by
    their embedded IPv4 address.

  IP-literal hosts get the same check. Compose service names (`postgres`, `minio`, …)
  resolve to private addresses and are therefore refused.
- **Pinned connection:** the connection is made **to the vetted address** (no second
  lookup, closing DNS rebinding). The original host name is used for SNI, `Host` and
  certificate verification. TLS verification is always on. Proxy environment variables
  are not honoured (a proxy would defeat the pinned-address guard).
- **No redirects.** A 3xx response is a **failure**; the `Location` is never followed.
- **Timeout:** **10 s** for the whole exchange (connect, TLS, response headers).
- **Save-time checks:** a URL failing the scheme or form rules is refused at save
  (**422**), as is one that does not resolve, or resolves to a refused address. The
  message is plain, e.g. *"Webhook URLs must use https on port 443"*, *"This address
  is on a private or internal network"*.

**Secret handling.** A webhook URL is a bearer secret: a Teams Workflows URL carries its
signature in the query string.
- It is stored **encrypted at rest** with AES-256-GCM. This is the same `v1:iv:tag:ct`
  format and helper as the §12.1 e-mail tokens, under a **dedicated key,
  `WEBHOOK_ENC_KEY`** (32 bytes, base64, §2.3).
- **Why not reuse `EMAIL_TOKEN_ENC_KEY`?**
  - *Independent rotation.* Rotating the e-mail key costs one mailbox reconnect. If
    webhook URLs shared that key, the same rotation would also break every webhook
    without warning.
  - *Feature independence.* A deployment that sends mail only through SMTP never sets
    the e-mail key, and its webhooks should not depend on it.
  - *Blast radius.* A leaked key exposes one class of secret, not two.

  The cost is one more variable in `deploy/.env`.
- **The full URL is never returned** by any API, never written to the audit log, the
  system log, structured logs or delivery errors. Error text is built from fixed
  reason codes, never from a library message that might echo the URL.
- At save the server derives a plaintext **hint**: the host plus the URL's last 4
  characters (`prod-12.westeurope.logic.azure.com …x9Zq`). The hint is stored next to
  the ciphertext and is the only form the UI ever shows. Editing a webhook leaves the
  URL field empty. Leaving it empty keeps the stored URL; entering a value replaces it.
- With `WEBHOOK_ENC_KEY` unset or invalid:
  - the admin card shows *"Webhooks are not configured on this server"*;
  - create, update and test are refused (**409**);
  - no delivery is enqueued.
- A stored URL that no longer decrypts (key rotated) fails its delivery permanently
  with reason "stored URL can't be decrypted — re-enter it".

**Delivery (worker).**
- At enqueue, the web tier writes one `webhook_deliveries` row (§5) per enabled
  webhook of the item's namespace. This happens right after the transition commits,
  alongside the §12.1 rows.
- A leader-only worker sweep runs every **30 s**, batch 50, oldest `next_attempt_at`
  first. It re-runs the leak guard, renders the payload, and sends.
- **Retryable failures:** network error, timeout, `408`, `429`, any `5xx`. The next
  attempt follows after **1 min, 5 min, 15 min, 1 h, 4 h**: up to **6 attempts** in
  about 5½ hours. A `429`'s `Retry-After` is honoured when it is longer than the
  scheduled step, capped at 4 h.
- **Permanent failures (no retry):** any other `4xx`, any `3xx`, a refused address,
  DNS failure on the final attempt, an undecryptable URL, or a missing key.
- A webhook that is **disabled** when its row comes due is **skipped**. A **deleted**
  webhook takes its pending rows with it.
- An edited URL applies to rows not yet sent.
- **Final failure:** when a delivery fails for good (permanent, or the 6th retryable
  failure), it is marked `failed` and **recorded in the system log** (§14.7,
  `source = worker`), which also raises the platform admins' system-log alert.
- Terminal rows (`sent`, `failed`, `skipped`) are deleted **30 days** after they
  finish, by the worker's hourly housekeeping sweep.
- The sweep adds `innobox_webhook_deliveries_total{outcome="sent|failed|skipped"}` to
  the worker's `/metrics`.

**Send test.** Each webhook has a **Send test** action.
- It POSTs a fixed synthetic payload **synchronously from the web tier**:
  - event `test`;
  - item `{ type: "challenge", number: "CH-0", title: "Test message from InnoBox", status: "valid" }`;
  - `url` = `PUBLIC_BASE_URL`;
  - no real item data.
- It goes through the same guard, timeout and no-redirect rules: one attempt, no retry.
- The result is shown inline (*"Delivered — HTTP 202 in 840 ms"* /
  *"Failed — receiver answered HTTP 404"*).
- It works on a disabled webhook, so a channel can be checked before it is switched on.
- A failed test is **not** written to the system log, because the admin sees it
  inline. It is audited.

**Administration card.** A collapsible **"Channel webhooks"** card in the
Administration console's platform-admin section (§14), beside the system banner card.
It is hidden from namespace admins, and its API answers **403** to anyone but a
platform admin.
- **Namespace list:** every namespace, `global` first then alphabetical, archived ones
  labelled. Under each namespace are its webhooks.
- **Per-webhook row:** name, format (*JSON* / *Teams Workflows*), URL hint, an
  enabled/disabled §2.2 preference pill switch, and the latest delivery outcome
  (*"Delivered 5 min ago"*, *"Failed 2 h ago — receiver answered HTTP 404"*, *"No
  deliveries yet"*). Actions: **Send test**, **Edit**, **Delete**.
- **Add webhook** (name ≤ 80, format, URL, enabled) is available up to **5 webhooks
  per namespace**. A 6th is refused with **409**.
- **Delete** confirms with *"Delete webhook <name>? Undelivered posts are discarded."*

**API (§16).**
- `GET /api/admin/webhooks` returns `{ configured, namespaces: [{ id, slug, displayName, archived, webhooks: [{ id, name, format, urlHint, enabled, lastDelivery: { outcome, at, httpStatus, reason } | null, createdAt, updatedAt }] }] }`.
- `POST /api/admin/webhooks { namespaceId, name, format, url, enabled }`.
- `PATCH /api/admin/webhooks/:id { name?, format?, url?, enabled? }`.
- `DELETE /api/admin/webhooks/:id`.
- `POST /api/admin/webhooks/:id/test` returns
  `{ ok, httpStatus?, reason?, durationMs }`.

All of these are platform admin only.

**Audit (§15).** Never the URL.
- `webhook.created` (namespace, name, format, URL hint, enabled);
- `webhook.updated` (before/after of name, format, enabled, URL hint, plus
  `urlChanged: boolean`);
- `webhook.deleted` (before);
- `webhook.tested` (outcome, HTTP status, reason).

Deliveries themselves are operational, not audited. Their trace is the delivery row,
plus the system log on final failure.

---

## §13 Discovery: dashboard, search, profile

### §13.1 Challenges page (browse & detail)

A dedicated **`/challenges`** page (own app-shell nav item, separate from Home).

**List (gallery):**
- Tabs **Open** (non-terminal statuses; excludes `awaiting_triage` per §4.3),
  **Mine** (own items incl. `awaiting_triage`), **Completed** (`solved` +
  `rejected`). Filters: status, impact area, namespace, author name; sort: newest
  (default), most liked, most solutions.
- Cards show number (`CH-<n>`), title, author (masked if anonymous, §9), created
  date, impact area, status, like count, and a solution count that excludes
  `rejected`/`not_selected`/`withdrawn`/`proposed`.
- **Cards / List view toggle.** A two-option segmented control (**Cards** | **List**,
  the existing `.sort-toggle` look, each option `aria-pressed`, §2.2) at the end of the
  filter row switches the gallery's presentation. It is a **pure presentation choice**:
  the same tabs, filters, sort, API call and payload. Switching never refetches and
  never resets a filter.
  - **Persisted per browser** in `localStorage` under `innobox:challenges-view`
    (`cards` | `list`). There is no server preference, no URL parameter and no audit.
    It is read after mount, before the first result render, so no hydration mismatch
    and no visible flash. A missing, invalid or unreadable value (private mode)
    falls back to **Cards**, and a failed write is silently ignored. The choice applies
    to all three tabs and only to `/challenges`. Search, profile and dashboard lists
    are unaffected.
  - **List columns**, in order: **number** (`CH-<n>`, mono) · **title** (a real link,
    ellipsized to one line with the full title as `title`) · **status** (the status
    pill) · **namespace** (`/<slug>`) · **author** (small avatar bubble + name, or
    **"Anonymous"** with the neutral bubble — masked exactly as on the card, invariant 3,
    §9; real-user bubbles carry the §13.8 card, anonymous ones never do) · **likes**
    (count only — no like toggle) · **solutions** (the same filtered count as the card)
    · **date** (created, date only, via the shared formatter). Impact area stays a filter and a card chip but is
    not a list column.
  - **Rows** reuse the §14.1 list pattern: a `.rows` table with a mono uppercase header
    row. The **whole row opens the challenge** in place (text selection never
    navigates), and the title stays the keyboard/screen-reader target.
  - **"New" marker:** a challenge that is new to the viewer carries the same **"new"
    tag** as its card — same tooltip and `aria-label` — drawn as a full-height tab
    flush to the row's right edge, with the row reserving right padding so content
    never slides under it. The tagged rows are exactly the ones the nav count refers to.
  - **Card badges carry over:** every badge or marker a card shows renders in the list
    too, with the same wording, condition and masking. The list never shows less state
    than the card.
  - **Mobile (≤ 880 px):** the header row hides and each row stacks: number + status;
    title; then a muted meta line (namespace · author · date · likes · solutions). The
    "new" tab stays pinned to the right edge.
  - Visibility and counts are those of the shared payload (invariant 2). The list adds
    no data.
- Strictly visibility-filtered, including counts (invariant 2, §4.3).

**New since your last visit.** Each user carries `users.challenges_seen_at` (§5;
the migration **backfills it to its run time**, so nobody lands on a bubble at
roll-out). A challenge is **new to the viewer** when `created_at >
challenges_seen_at` **and** it is visible to them (invariant 2). A new solution or
comment on an existing challenge does **not** make it new, and the viewer's own
just-submitted items count like anyone else's. The **Challenges** nav item shows a
superscript `1`–`9` / `9+` count of new items (hidden at zero; the §14.4 bubble
style), polled on the 30-second bell cadence via `GET /api/challenges/new-count →
{ count }` — a bare integer, no titles or namespaces. Each matching card, on **any**
tab and in either view, carries a small **"new" corner tag**, so the tagged cards are
exactly the ones the count refers to. The marker **advances when the user leaves the Challenges
surface** — `/challenges` and its `/challenges/:number` detail pages share it — via
`POST /api/me/challenges-seen`, never on entry: the count and tags stay stable for the
whole visit, and the next visit flags only genuinely newer items.

**Detail page (`/challenges/:number`):**
- Full fields: number, title, description, impact area, client name (if
  applicable), namespace, visibility, author (masked/anonymous per §9), status,
  assignee (if any), created/updated/edited dates.
- Like button (toggle) with live count — disabled while the challenge is closed
  (§8.3).
- The challenge's solutions, listed inline, honoring §4.3's solution-visibility rule
  (a `proposed` solution is hidden except to its author, the challenge's assignee,
  and the namespace's committee/admins), with `rejected`/`not_selected` ones in the
  collapsed "Closed solutions" section (§4.3). Each solution shows its own like button.
- **Propose a solution** (§6.2): visible to anyone who can see the challenge,
  enabled only while status = `valid`; opens the solution form (description, cost
  vs benefits, "Submit anonymously"). While disabled it carries a hint that depends on
  the status:
  - `solved` — *"This challenge is solved, so it no longer accepts solutions."*
  - `rejected` or `withdrawn` — *"This challenge is closed, so it does not accept
    solutions."*
  - any other status — *"Solutions can be proposed once the challenge has been
    validated."*

  No standalone `/solutions/:number` page — the §12.1 deep-link convention resolves to
  the parent challenge page, scrolled to the solution.
- **Status transitions** — two role-scoped controls, on the challenge and on each
  solution:
  - **Admin override** (namespace admin of this namespace, or platform admin): a
    plain dropdown offering *any* status, set directly (invariant 6), audited
    `from → to` with `override: true`.
  - **Enforced transition** (committee member of this namespace, or the challenge's
    assignee): a control offering **only the legal next statuses** per §7.2/§8.2 for
    the current status, audited `override: false`. Hidden when there is no legal
    move (e.g. a terminal status, or `awaiting_triage` for a committee member — see
    §7.2). The challenge detail response carries each viewer's allowed transitions
    so the control renders exactly the permitted moves.
  - A viewer who is both admin and committee sees the admin override (the superset).
- **Feature on Home** (platform admin only, §13.2 *Featured challenges*): pins or unpins
  the challenge on the Home dashboard. It is rendered from `canFeature` and offered only
  while the status is `valid` or `solved`.
- **Danger zone — Delete** (platform admin only, §10.3): a permanent, cascading,
  irreversible delete — one control for the challenge, one per listed solution.
  Rendered from `canDelete`; the confirm dialog demands the item's number typed back
  plus a reason, and spells out that solutions, comments, and files go with it.

*(Historical note — the detail page began as a first slice; the following have since
all shipped and are described in their own sections:)* attachments (§11), comments
(§10.2), full-text search (§13.4), assignment (§7.3), self/admin anonymity reveal
(§9), notification dispatch with in-app + e-mail (§12), and author edit/withdraw/
resubmit (§10.1) all live on this detail page. Every action is audited (§15).

### §13.2 Home dashboard

The Home route (`/`) is the landing for **both** authenticated and unauthenticated
visitors — it is the app's only public page (§2.1 invariant 2, §2.2).

**Authenticated** — the dashboard:
- **Featured** (*Featured challenges*, below): the challenges a platform admin has
  pinned, newest pin first, filtered per viewer. A viewer who can see none of them gets
  no section at all, with no heading and no empty state.
- **KPI tiles** (visibility-filtered, correctly labeled — the legacy app's
  swapped/mislabeled counters are not reproduced): challenges by status
  (in review / valid / solved / rejected) and solutions by status
  (in review / valid / in implementation / implemented).
- **Spotlight cards:** most recently `implemented` solution; most recent
  `in_implementation` solution.
- Both apply the **full** §4.3 predicate per viewer: a solution counts, or can be a
  spotlight, only if its parent challenge is visible to the viewer — namespace rule
  **and** state rule (not `awaiting_triage`/`withdrawn` unless the viewer is its author
  or an admin of its namespace).

  > **⚠ GAP-35 · code fix:** `api/dashboard/store.ts` uses its own namespace-only
  > `visibilityClause` (its header comment claiming no carve-out is needed is wrong), so
  > a solution under a `withdrawn` or re-triaged challenge is counted and can be a
  > spotlight — showing that challenge's title — to viewers who cannot see it
  > (invariant 2). Replace it with `pushChallengeVisibilityConditions` for the parent
  > plus the SQL form of `canSeeSolution` (see GAP-38) for the solution KPIs and both
  > spotlights.
- Links out to `/challenges` (§13.1) for browsing and `/leaderboard` (§13.3) for
  rankings; neither is duplicated here.

**Unauthenticated** — a static welcome only: the brand lede ("Ideas worth building
start here") with **no** KPI tiles, spotlight cards, `/api/dashboard` fetch, or
outbound links (those would only bounce to sign-in). The welcome card invites the
visitor to **"Sign in with your Entra ID account"** — the identity provider is named,
never the organization (§2.2 attribution rule). Sign-in itself is offered by the app
shell's "Sign in with Entra ID" control (§2.2). An Auth.js error handed back on the
URL — e.g. `?error=AccessDenied` for a deactivated account (§5 of
`ENTRA_AUTH_SPEC.md`) — is surfaced here as a short message.

#### Featured challenges

A **platform admin** may pin a challenge to the top of every viewer's authenticated Home
dashboard. This is a hand-picked editorial spotlight. It is **separate from the automatic
spotlight cards** (the most recent `implemented` / `in_implementation` solutions), which
are unchanged and keep their own place below the KPI tiles.

- **Who.** Platform admins only. Namespace admins, committee members, assignees, and
  authors cannot feature or unfeature.
- **Eligible statuses.** A challenge can be featured only while its status is **`valid`**
  or **`solved`**. A `valid → solved` move (the §8.3 auto-close, or an override) and a
  `solved → valid` move (the §10.3 revert) keep the pin.
- **Automatic unpin.** Any other status change clears the pin in the **same transaction**
  as the transition. That covers an override to `rejected`, `withdrawn`, or any other
  status, bulk status set (§14.1), and the author's Withdraw (§10.1). The unpin writes a
  `challenge.unfeatured` audit row with
  `after: { trigger: "status_changed", status: <new status> }`. Its actor is the actor of
  the transition: the admin, the committee member, the assignee, or the withdrawing author.
  If a transition ever runs with no user actor, the actor is the system (null).
  A platform-admin **hard delete** (§10.3) of a featured challenge writes
  `challenge.unfeatured` with `after: { trigger: "deleted" }`, actor = the deleting admin.
  It is written inside the delete transaction, before the row is removed. A pin cleared
  this way is **not restored** if the challenge later returns to `valid`/`solved`. An admin
  has to feature it again.
- **Cap.** At most **N** challenges are featured at once. N is the §14.3 *Featured
  challenges* setting (default **3**, range **1–6**). Featuring a challenge when N are
  already pinned is refused with **409**: *"N challenges are already featured. Unfeature
  one first."* (N is the configured number). Nothing is evicted automatically. The count
  check and the pin run in one transaction, serialized (a transaction-scoped advisory
  lock), so two concurrent requests can never both take the last slot. **Lowering** the
  setting below the current count unpins nothing. The existing pins stay and new features
  are refused until the count drops below the new cap. The section shows every current pin,
  never more than 6.
- **Idempotence.** Featuring an already-featured challenge is a **200 no-op**: no audit
  row, and the original `featured_at` is kept, so the order is unchanged. Unfeaturing a
  challenge that is not featured is also a 200 no-op.
- **Ordering.** Newest pin first (`featured_at DESC`).
- **Visibility (invariant 2).** The section applies the **full §4.3 challenge predicate**
  per viewer, the same one the gallery uses. A pinned `namespace`-visible challenge
  appears only to that namespace's members and to platform admins. A pin survives a
  visibility change (`org ↔ namespace`, §4.3). The per-viewer filter does the rest.
  `/api/dashboard` returns only the visible pins. The response never includes a count of
  hidden pins, the cap, or "N more".
- **Cards.** Each featured card uses the §13.1 gallery-card fields: number, title,
  author (**masked per §9**, since anonymity is unchanged), impact area, status, like
  count, and solution count (same exclusions as §13.1). The whole card links to
  `/challenges/:number`. The section heading is **"Featured"**. Cards sit in the
  existing `card-grid` above the KPI card.
- **Control.** It is on the §13.1 detail page and is rendered only for platform admins
  while the status is eligible. It reads **"Feature on Home"** when unpinned. When pinned,
  it reads **"Unfeature"**, with the sub-text *"Featured by <name> on <date>"* (date
  through the shared formatter). When the challenge is not eligible, the control is
  hidden. A 409 at the cap shows its message inline under the control. The detail response
  carries `featured: boolean` and `canFeature: boolean` for every viewer. `canFeature` is
  true only for a platform admin on an eligible status. `featuredBy` / `featuredAt` are
  included only when `canFeature` is true. Non-admins see **no** featured indicator
  outside the Home section.
- **Curation is not an edit.** Feature and unfeature stamp only `featured_at` /
  `featured_by`. They do **not** bump `updated_at`, `edited_at`, or `status_changed_at`,
  and they fire **no notification**.
- **API.** `PUT /api/challenges/:number/featured` (feature) and
  `DELETE /api/challenges/:number/featured` (unfeature). Neither takes a body. Order of
  checks (§2.4): **404** if the caller cannot see the challenge or the number is
  malformed; then **403** for a caller who is not a platform admin (*"Only platform admins
  can feature challenges."*); then **409** for an ineligible status on `PUT` (*"Only
  challenges that are valid or solved can be featured."*); then **409** at the cap. The
  success response is `{ featured: boolean, featuredAt: string | null }`.
- **Audit.** `challenge.featured` with `after: { featuredAt }`. A manual
  `challenge.unfeatured` uses `after: { trigger: "manual" }`. The automatic triggers are
  listed above.

### §13.3 Leaderboard

A dedicated **`/leaderboard`** page (own app-shell nav
item). **Top 10**, two windows — **last 30 days** and **all time** — across four
metrics: **solutions implemented (default)**, challenges submitted, solutions
proposed, likes received. Ranked by count descending; ties go to the user whose
**earliest counted contribution** in the window is oldest. A contribution's time is its
creation (a submitted challenge, a proposed solution, a like), except for a solution
implemented, which counts from the moment it became `implemented` — its
`status_changed_at` — for both the 30-day window and the tie-break.
Computed over org-visible, non-anonymous, non-rejected contributions (§4.3, §9).
"Org-visible" is the same test as the public profile's (§13.5): a challenge counts only
if it is `org`-visible and not `awaiting_triage`/`withdrawn`; a solution only if it is
not `proposed`/`withdrawn` and its parent passes the challenge test. Likes count only
on items that pass. The test is **viewer-independent**: every viewer sees the same
board, so it is not the per-viewer §4.3 predicate.

### §13.4 Search

Postgres `tsvector` full-text search over challenge
title/description/client name and solution description/cost-vs-benefits, plus exact
lookup by number (`CH-123`, `SOL-456`). Strictly visibility-filtered including
autocomplete and result counts (invariant 2). §13.1's gallery filters
(status/impact area/namespace/author) narrow the list alongside it: the `/search`
results page shows the same filter controls as the gallery, and `GET /api/search`
accepts them as query parameters beside `q`. Autocomplete stays query-only. Visibility
is applied **inside** the ranked query, before any result limit, so the viewer's top
results are never displaced by items they cannot see.

> **⚠ GAP-38 · code fix:** `solutionCandidates` (`api/search/store.ts`) applies the
> parent's predicate in SQL (`pushChallengeVisibilityConditions`), but the solution's
> own `proposed` rule runs only in JS (`canSeeSolution` in `toSolutionResults`), after
> the `limit ${CANDIDATE_LIMIT}`, so hidden `proposed` matches can still fill the cut
> and displace visible ones. Add a SQL form of `canSeeSolution` (status not `proposed`,
> or the viewer is its author, the challenge's assignee, or committee/admin of its
> namespace) beside `pushChallengeVisibilityConditions` and apply it before the limit;
> GAP-35 and GAP-39 reuse it.

**Keyboard shortcut:** `Ctrl+K` (`Cmd+K` on macOS) focuses the topbar search
input from anywhere in the app while authenticated — it's a global `keydown`
listener in `AppShell`, not scoped to a single page. The browser/OS default for
the combo is suppressed (`preventDefault`) so it doesn't fight the address bar
or other native bindings. Firing selects any existing text in the field (so
typing immediately replaces it) and opens the autocomplete dropdown if there's
already a query. The listener is a no-op while unauthenticated (the topbar
search isn't rendered then) and does not steal the combo while focus is inside
another text input/textarea/contenteditable *other than* the search field
itself, so it can't clobber an in-progress edit elsewhere on the page (e.g. a
comment box).

**Shortcut hint:** the topbar search box carries a small grey keycap pill at its
right edge advertising the combo, so the shortcut is discoverable and not hidden
knowledge. It renders `Ctrl+K` by default and `⌘K` on macOS — the platform is
detected client-side *after* mount, so the server-rendered default and the first
client render agree and there is no hydration mismatch (the label flips to `⌘K`
post-hydration on Macs). The pill is purely decorative for assistive tech
(`aria-hidden`; the input itself carries `aria-keyshortcuts` so screen-reader
users are told about the combo), it hides while the search field is focused
(`.search:focus-within` — once you're in the field the hint has served its
purpose), and it is suppressed on the mobile layout where there is no physical
keyboard. It reuses the pre-built `.search kbd` style already in the app-shell
CSS (mono, faint, `--line` border, `--paper` fill) — no new visual token.

**Clear button:** while the topbar search field holds any text (from the very
first character — `query.length > 0`, whitespace included), a small stylized
**✕ inside a semi-transparent circle** appears at the right edge of the bar.
Clicking it clears the field, keeps focus in the input (so the user can retype
immediately), and does not navigate; because the field is now empty the
autocomplete dropdown collapses on its own (it requires ≥2 characters). The
button occupies the same right-edge slot as the shortcut hint pill, and the two
never collide: the pill is already hidden whenever the field is focused
(`.search:focus-within`), and the clear button only shows once there is text —
which only happens while the field is focused. It is **suppressed on the mobile
layout** (like the pill). For assistive tech it is a real `<button
type="button">` with `aria-label="Clear search"` but is removed from the tab
order (`tabindex="-1"`) — an extra tab stop is unwarranted because the keyboard
path to clearing is `Escape` (below). It reuses existing brand tokens for the
icon (`--muted` at rest → `--ink`/`--accent` on hover) and a faint translation
of `--surface`/`--line` for the circle; no new visual token.

**Escape:** repurposed from "close the dropdown" to a progressive clear. With
text in the field, `Escape` clears the query (and the dropdown collapses as a
side effect, being empty) while **keeping focus in the input**, mirroring the
clear button. On an **already-empty** field, `Escape` blurs the input (exits the
field). This supersedes the prior behavior where `Escape` only closed the
autocomplete dropdown.

**Dropdown motion:** the autocomplete dropdown uses the shared popover treatment
(§2.2), including its chrome (`--line-strong` border, `--shadow`). It fades and scales
in when it first appears (≥2 characters), never replays while results refresh, and
closes instantly.

### §13.5 Profile

Own profile shows: identity (from Entra — display name, e-mail, department, job
title, **office location**); **my challenges by
status** (incl. awaiting triage); **my solutions by status**; **likes received**;
items I follow — **only those the owner can currently see** (§4.3); a follow on an item
that has since become hidden is kept, not deleted, and the item reappears if it becomes
visible again; latest activity (newest first, any status — fixing the legacy
"oldest in-review only" bug); notification preferences (the e-mail opt-out
**switch**, below, followed by the three §12.1 per-event toggles — *Comments on items
I follow*, *Status changes on items I follow*, *New solutions on challenges I
follow* — rendered as the same pill switch with the same on-left travel, optimistic
flip and inline-error revert).
Other users' profiles show display name, department, job title, **office location**,
photo, and their **non-anonymous** org-visible contributions. "Org-visible" is the full
§4.3 test that an arbitrary authenticated viewer would pass, applied to **both** the item
and, for a solution, its parent challenge:
- a challenge is listed only if it is `org`-visible and not `awaiting_triage` or
  `withdrawn`;
- a solution is listed only if it is not `proposed` or `withdrawn` **and** its parent
  challenge passes the challenge test above — so a solution whose challenge was later
  withdrawn, or moved back to `awaiting_triage` by an admin, drops off the public profile
  (it inherits the parent's visibility, §4.3). It reappears if the challenge becomes
  visible again.

The owner's own profile is unaffected: it lists all of their own contributions, as above.

A **deactivated** user's profile still renders — the greyed bubble (§13.6), a muted
**"Deactivated"** notice, their directory fields and their contributions by the rules
above — so the §13.8 card's "View profile" link always lands somewhere. Only a
**scrubbed** user has no profile (404, below), which is why the card offers no link
for one.

A scrubbed user's `/profile/<id>` renders the same generic not-found state as an
unknown id — *"That profile doesn't exist."* — never a "Deleted User" page.

> **⚠ GAP-39 · code fix:** the two "items I follow" queries in `getOwnProfile`
> (`api/profile/store.ts`) join `follows` to challenges/solutions with no visibility
> predicate, so they list titles and statuses of items the owner can no longer see.
> Pass the owner's `Viewer` (the function takes only `userId` today) and apply
> `pushChallengeVisibilityConditions` and the SQL `canSeeSolution` (GAP-38) in the
> SQL, before the `limit 50`.

> **⚠ GAP-40 · code fix:** `getPublicProfile` (`api/profile/store.ts`) returns null
> for `!active`, so `/profile/<id>` is a 404 for every deactivated user while the
> hover card still links there. Return null only for scrubbed rows, return the
> `active` state, and render the muted "Deactivated" notice and greyed bubble in
> `app/profile/[userId]/page.tsx`.

The **e-mail notifications** control is a §2.2 pill switch rather than a labelled
button: an `On`/`Off` word, then the pill — 📧 in the knob and an `--accent` track when
on, 🔇 in the knob and the plain `--surface-2` track when off. The knob rests **left
when on** and slides **right when off** (§2.2): the opposite travel from the theme
toggle, so that in the on state the knob sits next to the `On` word. The 📧 glyph is
used in preference to a lighter envelope, which does not read at the knob's 12 px.
In-app notifications are unaffected and always delivered; the switch governs **e-mail
dispatch only** (§12). Clicking it flips the knob **optimistically** and PATCHes the
profile endpoint. If that request fails the knob slides back to where it was and a
short inline error appears under the row's sub-text — a rejected change is never
silently swallowed. The switch stays clickable while the request is in flight (no
disabled/dimmed interval).

The profile page is the **canonical** view of the directory profile: the hover card
(§13.8) is a shortcut to the same three fields and never discloses more than the
public profile page it links to (notably **no e-mail**, which the public profile
withholds too). Each field is simply omitted when empty.

### §13.6 Avatar bubbles

Every surface that names a user renders an **avatar bubble** next to the name —
photo per §3.1, sourced exclusively through `GET /api/users/:id/photo`.

- **Surfaces:** challenge/solution cards and detail headers (author), comment
  threads, assignee chips, **assignee-search result rows** (§7.3 — the assignment
  and triage-assign popovers), leaderboard rows, profile pages (large), the account
  menu/sidebar (self), triage queue rows, the admin users list, search results, and
  the reveal dialog (§9). **Not** in notification e-mails (no embedded images), CSV
  exports, or the notification **inbox** rows — the outbox payload carries only a
  rendered `{message, link}` with no structured actor id, so an inbox bubble would
  require reworking the whole event matrix and re-checking anonymity for every event
  (anonymous actors, system notifications); that is deferred as its own change.
- **Fallback (no photo):** an **initials bubble** — first + last initial of the
  display name on a deterministic background chosen from a fixed brand-palette set
  keyed by user id (stable across sessions), correct in both light and dark themes
  (§2.2). Single-word names use the first two characters; "Deleted User" renders
  the neutral bubble.
- **Anonymous:** the generic anonymous bubble (§9) — identical for every anonymous
  author; never a photo, initials, or per-user color.
- **Deactivated users:** greyed initials bubble (photo dropped at deactivation,
  §3.1) — on **every** surface, not only admin screens. To make that possible, every
  payload that names a real user (the masked-author shape, assignees, comment authors,
  leaderboard rows) carries an `active` flag and a `scrubbed` flag beside the user id;
  a scrubbed user renders the neutral "Deleted User" bubble even though the id is
  present.

  The `scrubbed` flag is **explicit** on every such payload — author, assignee,
  commenter, leaderboard row, card, profile, triage row, the reveal — and the bubble
  decides "Deleted User" from it, never from the display name. Like `active`, it is
  absent for an anonymous author.

  > **⚠ GAP-41 · code fix:** `active` now flows through the payloads, but no payload
  > carries `scrubbed` (`MaskedAuthor` in `shared/src/challenges.ts` has `active` only),
  > and `avatarVariant` (`shared/src/avatars.ts`) infers a scrubbed user from
  > `displayName === "Deleted User"`. Add `scrubbed` beside `active` in `MaskedAuthor`
  > and every person payload, pass it through `AvatarBubble`, and drop the name-based
  > inference. Also pass `deactivated`/`scrubbed` to the bubbles in
  > `app/profile/[userId]/page.tsx` and in the reveal dialog
  > (`challenges/[number]/page.tsx` `RevealDialog`), which pass neither.
- **Sizing:** one stored image (§3.1), scaled by context — small (~24–40 px) in
  lists, chips, comments and rows — the **directory hover card (§13.8)** reuses the
  existing **medium** bubble of that band; large (~96 px) on profile pages and in the
  **reveal dialog** (§9). Bubbles are circular, with initials sized proportionally.
- **Hover card (§13.8):** a bubble that carries a real user id becomes the trigger for
  the directory hover card. Two consequences land here: such a bubble becomes
  **focusable**, and its native `title` tooltip is **dropped** (a browser tooltip
  would race and overlap the card on the very same element) — the `aria-label` stays,
  and the card itself shows the name. Bubbles with **no** user id — anonymous authors,
  deleted/unknown actors — keep their `title`, gain no tab stop, and open no card.
- **Loading/perf:** list rows lazy-load bubble images; the browser cache +
  `ETag` revalidation (§3.1) means each distinct user's photo is fetched at most
  once per session in practice. No base64 inlining in list payloads.

### §13.7 Quick start (onboarding)

A dedicated **`/quick-start`** page: one generic walkthrough for every
authenticated user regardless of role, covering the common flows — submitting a
challenge, proposing a solution on a `valid` challenge, commenting/liking/
following, and where to find the dashboard, leaderboard, and search — each
illustrated with a theme-aware SVG mockup of the relevant screen (drawn on the §2.2
tokens, so it follows light/dark and never goes stale the way a screenshot does).
Always reachable afterward
via the account menu (§2.2), positioned above **What's new**.

- **Auto-open on first sign-in:** `users` (§3) gains a nullable
  `quick_start_seen_at timestamptz` column. The migration backfills it to the
  migration's run time for all existing rows, so only users who sign in for the
  **first time after this ships** are treated as unseen — current users are not
  surprised by a redirect they never asked for. While the signed-in user's
  `quick_start_seen_at IS NULL`, the app shell redirects any authenticated route to
  `/quick-start` as soon as the `me` resource has loaded on first page load — taking
  priority over a deep-link `callbackUrl`. The target route may begin rendering for a
  moment before the redirect; that is accepted. A **"Continue to InnoBox"** action on the page sets
  `quick_start_seen_at = now()` (via the `me` resource, §16) and navigates to `/`
  (Home dashboard, §13.2); the redirect never fires again for that user afterward.
- **Manual re-access:** the account-menu link navigates to `/quick-start` as an
  ordinary page — no redirect logic, and visiting it this way never touches
  `quick_start_seen_at` (already set).
- **No visibility/anonymity surface:** the page shows no challenge/solution/user
  data, only static instructional content and mockups, so §2.1 invariants 2–3
  don't apply.

### §13.8 Directory hover card

Hovering an **avatar bubble** (§13.6) opens a small floating card with that person's
Entra directory profile — **display name, job title, department, office location** —
plus a link to their full profile. It is **read-only and display-only**: nothing it
shows participates in authorization, and nothing it exposes changes state.

Of the three directory fields, department and job title already exist (§3, §5);
**office location is new** and is added by this change.

#### Where it appears

- **Every avatar bubble that carries a real user id**, across the app: challenge and
  solution cards and detail headers, comment threads, assignee chips, the leaderboard,
  triage-queue rows, the admin users list, search results and profile pages.
- **Excluded, deliberately:**
  - the **sidebar account-menu trigger** (your own bubble) — that element already opens
    the account menu on click, and a hover card fighting a menu on the same target is
    hostile;
  - bubbles **inside an already-open popover** — the §7.3 assignee-search result rows
    and the §14.1 inline assignee editor — where a card would nest a popover in a
    popover;
  - the **reveal dialog** (§9) — it already names the revealed person, so the
    card adds nothing to the one surface where anonymity is deliberately lifted, and
    the reveal flow stays untouched.

  The read-only assignee text on **terminal-status** triage rows (§14.1) is *not* one of
  these exclusions — it sits in no popover — so its bubble opens the card.

  Like the editable assignee cell, the read-only assignee on a terminal row stops click
  propagation, so opening its card never also opens the row (§14.1).

  > **⚠ GAP-42 · code fix:** `admin/triage/page.tsx` passes `noCard` to the assignee
  > bubble on terminal-status rows (the `TERMINAL_STATUSES` branch of the assignee
  > cell). Remove it, and give that read-only span the same
  > `onClick={(e) => e.stopPropagation()}` the editable cell has.
- **No user id → no card.** An **anonymous** author's bubble (invariant 3: the client
  never learns the real id — the payload carries `null`, §13.6), a deleted/unknown
  actor, or a bubble whose caller marks it anonymous shows **no card, issues no
  request, and gains no tab stop**. Both conditions are checked independently: an
  explicitly-anonymous bubble opens no card even if a user id were somehow present.
  Every anonymous bubble therefore behaves identically to every other one — nothing
  in the DOM, the tab order or the network log distinguishes two anonymous authors.
- Photo bubbles and initials-fallback bubbles behave identically.

#### Card contents

Top to bottom, in a fixed max-width (~280 px) card:

1. The **avatar bubble** (the existing medium size, §13.6) beside the **display name**.
2. **Job title**.
3. **Department**.
4. **Office location**.
5. **"View profile"** — a link to `/profile/<id>` (to `/profile` for your own bubble,
   decided by comparing the bubble's user id to the signed-in user — no caller has to
   mark a bubble as "self").

> **⚠ GAP-43 · code fix:** `DirectoryCard.tsx` links to `/profile` only when the caller
> passes `self`, and only `app/profile/page.tsx` does, so your own bubble on cards,
> comments and the leaderboard links to `/profile/<yourId>`. Compare the bubble's user
> id with the session user inside `DirectoryCard`/`AvatarBubble` and drop the prop.

- Lines 2–4 are **omitted individually** when the field is empty. When **all three**
  are empty the block collapses to a single muted line — **"No directory
  information."** — which is also what a **scrubbed** ("Deleted User") row shows. The
  card never becomes an error state.
- A **deactivated** user (greyed bubble, §13.6) additionally shows a muted
  **"Deactivated"** line. That status is already visible in the bubble itself, so
  naming it discloses nothing new; their directory fields are retained (only the photo
  is dropped at deactivation, §3.1).
- A **scrubbed** row gets **no "View profile" link** — there is nothing to show.
- **Long values wrap** onto further lines rather than ellipsing: Entra job titles are
  routinely long ("Senior Manager, Regional Delivery Excellence — EMEA") and a
  truncated title is useless.
- **Deliberately absent:** e-mail (the public profile withholds it too, §13.5),
  presence/last-seen (**tracked since §14.5, but deliberately not surfaced here or on
  the public profile — presence is a platform-admin-only signal, never an ambient one
  every colleague can read off a hover card**), contribution counts, and any role or
  namespace badge. The last two are excluded **because of invariant 2** — per-namespace
  roles and per-viewer contribution counts would leak the existence of namespaces and
  restricted items through a surface that renders for every viewer identically. The
  card carries **no** challenge, solution or namespace data of any kind.

#### Interaction — pointer (mouse only)

- **Opens** after **300 ms** of continuous hover, and only for a **mouse** pointer
  (`pointerType === "mouse"`); **closes** ~150 ms after the pointer leaves **both** the
  bubble and the card, so the pointer can travel from one into the other.
- **The card is hoverable and interactive** — that grace period exists precisely so the
  "View profile" link is clickable.
- Rendered in a **portal at the top of the stacking context**, then clamped and flipped
  (side, above/below) to stay inside the viewport, so it is never clipped by a
  scrolling table, a dropdown or the sidebar.
- **One card at a time** — opening a second closes the first.
- **Animation** reuses the app's shared popover treatment (§2.2): a ~120 ms
  fade-and-scale on open and an instant close — the same as every other popover in the
  app — and nothing at all under `prefers-reduced-motion: reduce`.

#### Interaction — touch

- **There is no card on touch or pen** — the pointer-type gate above is the whole
  mechanism. No long-press affordance, and therefore **no** `-webkit-touch-callout` /
  `contextmenu` suppression on avatars: they stay long-pressable ("Save image") on
  mobile and right-clickable on desktop exactly as today, and a touch on an avatar
  inside a clickable triage row still opens the row (§14.1).
- On touch, the directory profile is reached through the **profile page** (§13.5) — the
  same destination the card's link points at.

#### Keyboard & accessibility

- Card-bearing bubbles become **focusable** (`tabindex="0"`, `role="button"`) so the
  card is reachable without a pointer. **Accepted cost, explicitly:** one extra tab
  stop per such avatar — dozens on the leaderboard, the triage queue and long comment
  threads.
- **Focus opens** the card with **no delay** (hover-intent is a pointer concept);
  **blur closes** it; **Escape** closes it and leaves focus on the bubble.
- The card is a **non-modal `role="dialog"`** labelled with the person's name — not
  `role="tooltip"`, because it contains an interactive link. Focus is **not trapped**:
  Tab moves from the bubble into the card, then out and on through the page. Because
  the card is portalled (above), Tab order does not reach it naturally, so it is routed
  explicitly:
  - **Tab** on the bubble while the card is open moves focus to "View profile".
  - **Tab** from inside the card continues to the element **after** the bubble in the
    page order, and **Shift+Tab** from inside the card to the element **before** the
    bubble; either way focus has left both, so the card closes.
  - A card with **no link** (a scrubbed row) has nothing to focus: Tab on the bubble
    moves on to the next element as usual and the card closes.
  - Blur closes the card only when focus has left **both** the bubble and the card.

  > **⚠ GAP-44 · code fix:** focus inside the card now keeps it open and Escape returns
  > focus, but nothing routes Tab: `DirectoryCard.tsx` portals the card to the end of
  > `document.body`, so Tab from the bubble skips it and keyboard users can never reach
  > "View profile", and Tab out of the card lands at the end of the page. Add the
  > routing above (a `keydown` handler on the trigger and the card).

#### Data & delivery

- **`GET /api/users/:id/card`** → `{ userId, displayName, jobTitle, officeLocation,
  department, deactivated, scrubbed }`. **Any authenticated user** may call it for
  **any** user id — InnoBox has no per-user visibility model (invariant 2 governs
  *challenges*), and `/api/profile/:userId` already exposes the same fields to any
  signed-in caller. **401** unauthenticated; **404** for an unknown **or malformed**
  id (validated as a UUID before it reaches Postgres). Server-side this is a single
  indexed primary-key lookup — no aggregate, no new cache layer.
- **Lazy, never on mount.** The fetch fires on the **same 300 ms hover-intent
  threshold that opens the card** (or immediately on focus), so a leaderboard with 100
  bubbles issues **zero** card requests until someone actually hovers one.
- **Deduped and cached client-side** per user id for the page session: two bubbles for
  the same person share one request, and re-hovering is instant with no flicker.
- **Never blocks on the network.** The card opens immediately with the name (already a
  bubble prop) and a muted placeholder where the directory block will land; a slow,
  failed or 404 response resolves to "No directory information".
- **Not audited** — opening a card is a read, like the avatar gateway (§3.1); it writes
  no `audit_log` row.

#### Privacy

- **No self-service opt-out in v1**, deliberately: all three fields are org-directory
  data that the profile page (§13.5) already shows to every signed-in user, so the card
  discloses nothing new and an opt-out that hid them only here would be theatre. If
  hiding the directory profile is ever wanted, it must apply to the profile page and the
  card together — recorded here so the decision can be revisited rather than
  rediscovered.
- **Anonymity (invariant 3) is unchanged and reinforced:** the card is keyed
  exclusively on a user id, and an anonymous author's id never reaches the client.
- **Visibility (invariant 2) is untouched:** the card carries no challenge, solution,
  namespace, role or count data, so it cannot leak restricted items — which is why
  those were excluded from its contents above.

---

## §14 Administration

The **Administration console** (`/admin`) is the hub: namespace admins and platform
admins land here (platform-admin-only cards — settings, audit, system banner §14.6,
system log §14.7, channel webhooks §12.4, identity sync §14.10 — are hidden from
namespace admins, §4). Its sub-pages — the triage queue (§14.1), platform settings
(§14.3), the audit browser (§15), and the system log (§14.7) — each render a
**breadcrumb** above the page title, via a shared component: **Administration** (a link back to `/admin`) › *current
page* (the trailing crumb is plain text, not a link). Every present and future
`/admin/*` sub-page carries it, so the way back to the console is consistent. The
breadcrumb occupies the slot the static "Administration" eyebrow holds on those
sub-pages today — the eyebrow is superseded by the breadcrumb's leading crumb (no
duplicate "Administration" label). It appears **only once the viewer has passed that
page's access gate** (`gate === "ok"`) — never on the loading or restricted
(forbidden) states, where the page title alone remains. The crumb link is styled on
the existing brand link tokens; the separator is a `›` glyph.

### §14.1 Namespace triage queue (namespace admins; platform admins everywhere)

A filterable queue of the namespace's challenges: columns number, title, author
(masked when anonymous until revealed §9), status, impact area, assignee, created.
Filters: author name (matches non-anonymous items only), **assignee — Any,
"Unassigned", "Assigned to me", or a specific person (searchable)**, status, number.

**Row interaction — the whole row opens the item.** Clicking anywhere on a row
navigates to the item exactly as its title link does (a challenge's detail page here;
the parent challenge's detail on the Solutions tab), **in place** (no new tab). The
title stays a real link so keyboard and screen-reader users keep a focusable target,
and a click that is part of a text selection does not navigate. The only zones that do
**not** navigate are the row's select checkbox and — on the Challenges tab — the inline
assignee field (its input, its clear control, and its results list).

**Inline assign (§7.3) — an inline editable assignee field**, not a separate dropdown
toggle: on a **non-terminal** challenge the Assignee column is a text field showing the
current assignee (name + avatar) or a grey **"Unassigned"** placeholder when none.
Focusing it selects the current name so typing immediately searches people (≥2 chars,
the same user search used elsewhere); picking a result assigns or reassigns; a clear
(**✕**) control in the field unassigns. Blur or Escape without a selection reverts the
visible text to the current assignee and changes nothing — the field never unassigns on
its own (no accidental unassign). Assigning, reassigning, and unassigning use identical
RBAC (namespace admins within their namespace(s), platform admins everywhere),
notifications, assignee auto-follow, and audit as the detail-page assignment. On
**terminal** statuses assignment is unavailable (§7.3 `canAssignAtStatus`): the column
renders the assignee (or "Unassigned") as **read-only text**, with no field.

**Search results overlay above the queue.** Every user-search results list on this page
— the inline row assignee, the specific-person assignee filter, and bulk-assign —
renders in an overlay layer positioned to its field and stacked above the queue, so
results are never clipped by, nor pushed under the edge of, the surrounding list/card.

**Bulk actions** over a selection: bulk assign,
bulk status set (admin override semantics, each item audited individually, and each
item firing exactly the §12.1 notifications its single-item equivalent fires — events
3–5 for a status change, event 7 for an assignment — one per item, after commit).

Permanent
delete (§10.3) is deliberately **not** a bulk action — it is one item at a time, from
the detail page. **CSV
export** of the current filtered view — identities of anonymous authors are masked in
the export; every export is audited (who, filter, row count).

**CSV formula neutralization.** Every exported cell is user- or directory-supplied text
(titles, names, impact areas), and spreadsheet applications run a cell that begins with
a formula trigger. So any cell whose value begins with `=`, `+`, `-`, `@`, a tab, or a
carriage return is prefixed with a single quote (`'`) **before** the usual RFC 4180
quoting. The rule applies to **every** cell, header row included, with no per-column
exceptions, so a new column cannot be forgotten. The visible cost is that such a value
shows a leading `'` in tools that don't hide it (e.g. a title `- Reduce costs` exports
as `'- Reduce costs`); the export is for people to read in a spreadsheet, not for
machine round-tripping, so that trade-off is accepted.

**Tabs — Challenges & Solutions.** The default **Challenges** tab is the queue
described above. A second **Solutions** tab lists the namespace's **`proposed`**
solutions — the state awaiting committee/assignee attention (§8.2) and counted by the
§14.4 badge: columns number (`SOL-<n>`), parent challenge (`CH-<n>` + title), author
(masked when anonymous until revealed §9), impact area, namespace, proposed date;
clicking anywhere on the row (the whole-row behavior above) opens the solution detail,
where status changes live (§8.2 — no admin-only triage step for solutions, so the tab
is navigational, not a transition surface). Solution rows have no checkbox or assignee
field, so the entire row is a navigation target.
Identical RBAC and visibility filtering to the Challenges tab (namespace admins within
their namespace(s), platform admins everywhere; invariants 2–3). Bulk actions and CSV
export remain challenge-only in v1. Dates on both tabs render through the shared
formatter (EU/US, §14.3).

> **⚠ GAP-46 · code fix:** both tabs of `admin/triage/page.tsx` — the Challenges
> queue's created date and the Solutions tab's proposed date — render with
> `new Date(r.createdAt).toLocaleDateString()` instead of `useDateFmt()`.

### §14.2 Moderation

Comment soft-delete (§10.2), anonymity reveal (§9), admin status override (§7.2/§8.2),
visibility change (§4.3) — all namespace-admin powers, all audited. **Permanent delete
of a challenge or solution (§10.3) is the exception: platform admin only, never
delegated per namespace.**

### §14.3 Platform settings (platform admin)

- Attachment limits (one card): max per item (default **5**, range 1–50); max upload
  size (default **10 MB**, range **5–200 MB** — floor raised from 1 so chunking stays
  coherent); **chunk size (default 5 MB, `5 MB ≤ chunk ≤ max upload size`)** — the
  frontend slices any file larger than this and uploads it chunk-by-chunk through the
  server (§11). All three are integers (MB); the 5 MB chunk floor is the S3-multipart
  part minimum.
- Impact areas: add / rename / retire / **delete** (seeded Client, Internal,
  Accelerator). Retire is a soft flip of `active` — a retired area stays on
  historical challenges but leaves the submission form (§5). **Delete** permanently
  removes the row and is available **only for a retired area** (an active area's
  Delete control is hidden); platform-admin only, and — like every write here —
  audited. Behavior:
  - A retired row that **still has challenges** shows a **reassignment-target
    dropdown** next to its **Delete** control (a retired row with none shows just
    Delete). The dropdown lists **active** areas only, excluding the area being
    deleted and excluding **Client** (challenges can't be bulk-moved *into* Client —
    each would need a `client_name` that a bulk move can't supply).
  - **No challenge references the area** → Delete is enabled with no target needed;
    confirm dialog *"Permanently delete <Area>?"*.
  - **N challenges reference it, no target chosen** → Delete is **disabled**, tooltip
    *"N challenges still use this area — choose an area to move them to"*; the API
    enforces this too (a no-target delete of a referenced area is **rejected**, not a
    silent partial action).
  - **N challenges reference it, a target chosen** → on confirm (*"Move N challenges
    to <Target> and permanently delete <Area>?"*) all N challenges are reassigned to
    the target and the area row is deleted, **in one transaction** (all-or-nothing).
  - Solutions have **no** impact area of their own (§5) — they inherit it from their
    parent challenge, so reassigning a challenge carries its solutions along; nothing
    on a solution row changes.
  - The destination is never Client, so every reassigned challenge's `client_name` is
    **cleared** to `null` as part of the move — a client name is meaningless on a
    non-Client challenge (§5).
  - Reassignment is **admin maintenance, not an author content edit** (§10.1): it
    bumps `updated_at` only, does **not** stamp `edited_at`, and fires no
    notification.
  - Safe against races: a retired area can never gain a new reference (submission
    requires an **active** area, §5/§6.1), so its reference count only decreases; the
    zero-reference delete runs as a single guarded statement.
  - **Audit** (§15): the deletion writes an `impact_area.deleted` event
    (`before: { name, active }`, plus the reassignment target and moved-challenge
    count when challenges were transferred); each reassigned challenge additionally
    gets its own `challenge.edited` diff (`impactAreaId`, and `clientName` when it is
    cleared).
- Date display format: EU (dd/mm/yyyy, 24-hour) or US (mm/dd/yyyy, AM/PM).
- Namespace management: create / rename / archive; role mappings (Entra group →
  namespace role / platform admin).
- Notification sender: connect/disconnect the Microsoft 365 service mailbox
  (delegated Graph consent flow via the dedicated "InnoBox Email" app registration,
  §12.1), author the branded HTML wrapper, test-send.
- **Channel webhooks** — per-namespace Teams Workflows / JSON webhooks, managed on their
  own Administration console card (§12.4).
- **Featured challenges** — the maximum number of challenges pinned to the Home
  dashboard at once (§13.2): integer, default **3**, range **1–6**. Lowering it unpins
  nothing; new pins are refused until the count is below the new limit. Audited as
  `settings.featured_limit_changed` (`after: { limit }`), following the existing
  `settings.<name>_changed` pattern.

All settings changes are audited.

### §14.4 Triage attention badge

Admins carry an at-a-glance **attention bubble** on the **Triage** and
**Administration** nav items (§2.2). It shows the count of **unseen actionable
items** — challenges in `awaiting_triage` plus solutions in `proposed` (§14.1) —
whose `status_changed_at` is later than the viewer's `users.triage_seen_at`, scoped
to the viewer's namespaces (platform admins: all), as **one shared count** shown
identically on both nav items. It renders `1`–`9`, then **`9+`** for ten or more, and
is hidden at zero. Committee members and other non-admins never see it (triage is a
namespace-admin function, §7.2).

- **Meaning.** The badge tracks *what an admin has not yet looked at*, not the
  backlog size. A first-ever view (null `triage_seen_at`) counts everything currently
  actionable; using `status_changed_at` means an item that returns to an actionable
  state (e.g. an admin override back to `awaiting_triage`) re-surfaces.
- **Clearing.** Opening the triage queue (`/admin/triage`, either tab) issues
  `POST /api/admin/triage/seen`, stamping `triage_seen_at = now()` for the actor; the
  count then reads 0 on both nav items until a **new** actionable item arrives.
  Merely opening the queue clears it — acting on the items is not required.
- **Freshness.** Polled on the same 30-second cadence as the notification bell
  (§12.2) via `GET /api/admin/triage/attention → { count }`.
- **Safety.** The value is a bare integer — no title, author, or namespace leaks —
  and obeys the same namespace scoping and visibility filtering as the queue
  (invariant 2).

### §14.5 Currently online (platform admin)

A collapsible **"Currently online"** card in the Administration console's
platform-admin section (alongside Namespaces, Role mappings and Delete user info),
answering *who is using InnoBox right now* and *how adoption is trending*. **Platform
admins only** — namespace admins and committee members never see it, and there is no
non-admin surface for presence anywhere in the app (§13.8).

#### What counts as activity

- **User-initiated requests only.** Page navigations and mutations stamp
  `users.last_seen_at`; **background pollers never do** — the notification bell (§12.2)
  and the triage attention badge (§14.4) both poll every 30 s, so counting them would
  make "online" mean "has a tab open somewhere" and every user who ever left InnoBox
  open would read as permanently active. Reading counts as using: a challenge detail
  `GET` is activity, `GET /api/notifications` is not.
- **Explicit allowlist, not a denylist.** Routes that stamp presence are enumerated;
  anything unlisted is silent by default. A new polling widget can therefore never
  quietly pollute presence by being forgotten — the failure mode is an under-count,
  which is the safe direction.
- **Write path.** Stamped in the node layer (`getSessionUser()`), **fire-and-forget**
  and **throttled to one write per user per 60 s** — it must never add latency to, nor
  fail, the request that triggered it. Middleware is edge-runtime and does no DB work
  (§5 of `ENTRA_AUTH_SPEC.md`), so it is not the hook. The 60 s throttle caps timestamp
  precision at a minute, which the relative "active 48m ago" copy tolerates.

#### Card contents

Four blocks, top to bottom:

1. **Active-users chart.** A line chart of **daily distinct active users** with a
   **7d / 30d / 90d / All** range toggle, read from `presence_daily`. Hand-rolled inline
   SVG on the brand tokens — **no charting dependency**. Days are **UTC** buckets
   (the store-UTC-convert-at-display rule, §2): a point labelled `07-13` is a UTC day,
   not the viewer's local day, and
   the axis is labelled to say so.
   - **Cold start is explicit.** There is **no backfill** — the series begins the day
     tracking ships and grows one point per day. Under **7 days** of history the chart
     is replaced by a muted **"Not enough history yet — the chart starts filling from
     the day presence tracking shipped."** The range toggles stay visible and simply
     resolve to the same short series (`90d` and `All` are identical for the first three
     months); they are not hidden, so the control never changes shape under the admin.
2. **DAU / WAU / MAU tiles** — distinct users active in the **last 24 h / 7 d / 30 d**,
   as rolling windows labelled with those windows. Computed **directly from
   `users.last_seen_at`** (`last_seen_at > now() - interval`), needing no history table:
   a user last active three days ago counts in WAU and MAU but not DAU.
3. **Window selector** — **5m / 1h / 8h / 24h / 30d** for the list below. **Default 5m**,
   and the chosen window is **persisted to localStorage** per browser, like the console's
   card collapse state. Copy states the window in words ("Users active within the last 5
   minutes.").
4. **The list** — one row per user active inside the window, **most recently active
   first**: avatar bubble (§13.6), display name, e-mail, **current location** (below),
   and a relative **"active just now" / "active 48m ago"** pill. Above it, a
   **client-side search** filtering the fetched set by name or e-mail.
   - **No "Reach out" action.** Deliberately: the panel answers *who is around*, and
     InnoBox has no direct-message channel to hand off to.
   - **Cap 200** users per window, most-recent-first, with a muted **"showing 200 of
     412"** when truncated. No pagination — a longer list is a metrics question, and the
     tiles already answer it.

#### Current location (and its anonymity carve-out)

Each row shows where that user last was: a **route category** (`Challenges`, `Triage`,
`Administration`, `Leaderboard`, `Profile`, …) and, for entity routes, the entity —
`Challenge: CH-412 — Warehouse pick-path rework`. Platform admins see every namespace
(invariant 2 is satisfied by the gate alone), but **invariant 3 is not**, so:

- **Anonymous targets are masked to the bare category.** A row pointing at an anonymous
  challenge or solution renders plain `Challenges` — never the number or title. Pairing
  a named person with an anonymous item outside the audited reveal path (§9) is exactly
  the correlation channel §9 exists to close, and "who is looking at it" is one hop from
  "who wrote it".
- **Compose and edit routes are masked too** — `/challenges/new` and `/solutions/new`
  render `Challenges`, because "Emiliyan is on the new-challenge form" plus an anonymous
  challenge appearing minutes later is the same correlation with extra steps.
- **Current value only, never a history.** `users.last_route` is overwritten in place on
  the same throttled write. InnoBox stores no per-user browsing log, and this section is
  the reason that is a deliberate choice rather than an accident.

#### Freshness, retention & privacy

- **No auto-refresh.** The panel is a snapshot: it carries a **manual "Refresh"** button
  and a muted **"as of 10:04"** stamp, so a 5-minute window opened half an hour ago is
  visibly stale instead of silently wrong. Nothing polls; the admin's own refresh does
  not count as anyone else's activity.
- **Deactivated users** render **greyed** (the §13.6 deactivated bubble) with the same
  muted treatment as elsewhere. In practice they surface only in the longer windows —
  `getSessionUser()` cuts a deactivated account off, so they can generate no new
  activity. **Scrubbed users never appear at all** (§3 — the erasure wipes presence).
- **Service accounts are excluded** — the e-mail service mailbox (§12) is not a person
  and would sit permanently at the top of the list.
- **Retention.** `user_activity_days` — the only per-person presence history — is
  **purged beyond 3 days** by the worker's hourly housekeeping sweep, which first rolls
  each closed UTC day into `presence_daily`. What survives long-term is a **count per
  day with no user ids**. `users.last_seen_at` / `last_route` are single overwritten
  values, not a log.
- **Audited.** Each successful fetch of the **online list** writes one **`presence.view`**
  row (actor + window). Reads are normally unaudited in InnoBox (§13.8), but "an admin
  looked at who is online" is precisely the access a DPO asks about, and with
  auto-refresh off this is one row per deliberate load rather than a flood. The **chart
  series is not audited** — it is a count per day carrying no user ids, so it discloses
  nothing about any individual.
- **Disclosed in-panel.** A muted line states that presence is recorded from app
  activity, that per-person history is kept for 3 days, and that only platform admins
  can see it. Covert monitoring is not on the table; the wider DPIA / works-council
  position is an organizational decision outside this spec.

### §14.6 System banner (platform admin)

A single, platform-wide announcement a platform admin posts, shown to **every
authenticated user** as a pill in the topbar between the search box and the bell
(§2.2). Deliberately **not** built on the notifications/outbox pipeline — it never
creates an inbox row and never sends e-mail, so "excluded from notifications" is
structural rather than a filter.

- **Storage:** one `settings` key, `system_banner` → `{ message, tone, url, expiresAt }`;
  the row's `updated_by`/`updated_at` record who set it and when. `message` is plain
  UTF-8, **≤ 120 characters**, escaped on render, no markup. `tone` ∈ `info | warning`
  (accent pill vs the warn token). `url` is **optional** — `https:` only, or a path
  relative to `PUBLIC_BASE_URL` — validated server-side and rendered as a trailing
  **"Learn more →"** link.
- **Set / replace** — `PUT /api/admin/system-banner`, platform admin only: an
  unconditional upsert. Text, tone, link and duration replace whatever is active and
  the countdown **always restarts from the save** (`expiresAt = now() + duration`),
  whether the new duration is longer or shorter than the time that was left.
  **Duration** is exactly one of **1h / 4h / 8h / 1d (24 h) / 1w (168 h) / 30d (720 h)**
  — fixed options, no custom value. Audited `system_banner.set` (actor, message, tone,
  url, duration).
- **Clear** — `DELETE /api/admin/system-banner`, platform admin only: removes the
  banner immediately. Audited `system_banner.cleared`.
- **Expiry is lazy** — the banner is active iff `expiresAt > now()`, computed at read
  time by every reader; no worker sweep. **Singleton**: at most one banner; saving over
  an active one replaces it; there is no queue and no history beyond the audit rows.
- **Audience & scope:** every authenticated user, org-wide. No namespace scoping
  (namespace admins have no authority here), **no per-user dismiss**, and the
  unauthenticated Home (§13.2) never shows it.
- **Delivery:** folded into the existing 30-second bell poll — the unread-count
  response gains `banner: { message, tone, url, expiresAt } | null` (§12.2) — so an
  open tab picks up a new, replaced or cleared banner within one poll and no second
  transport exists.
- **Rendering:** desktop — a width-capped pill that truncates on one line with an
  ellipsis (full text via `title`) and **never** grows under the bell/theme controls;
  mobile (the §2.2 narrow topbar) — its own full-width line below the search row,
  **wrapping** the full text, because touch has no hover and an ellipsis would hide the
  announcement. Hidden entirely when nothing is active (never an empty row).
- **Administration card:** a collapsible platform-admin card — text input with a live
  character counter, tone selector, optional link field, duration selector, **Save**;
  while a banner is active it also shows the live message, the remaining time and a
  **Clear now** button, and reverts to the empty state on its own once expired.

### §14.7 System log (platform admin)

An operational view of the **user-facing HTTP errors** the platform returned — the
issues users hit, and who hit them. This is **not the audit log**: it is high-volume,
**mutable** operational telemetry with retention, no append-only trigger and no
provenance guarantee. **Platform admins only** — linked from the Administration
console directly under Audit, never shown to namespace admins, and the API answers
**403** to anyone else.

- **What is recorded.** Every **5xx**; of 4xx only **403 / 409 / 413 / 422 / 429**
  (a 429 from the §2.4 rate limiter included). **401 never** (expired-session poll
  noise) and `/api/*` **404 never**. The web tier, plus one worker carve-out: the SCIM
  endpoints' **401 / 403** (`source = worker`) — a wrong provisioning token or SCIM URL
  is the first symptom of an Entra misconfiguration and is worth surfacing. Scan-
  pipeline failures are **not** recorded here (already audited, §11). Two further
  carve-outs: the §3 **sign-in relink refusal** (`409`, `error_code =
  signin_upn_conflict`, no user, candidate user ids only in the message), and
  **channel-webhook final failures** (§12.4, `source = worker`). The webhook rows have
  `method = POST`; `route = /webhooks/[namespace]`, `path = /webhooks/<namespace slug>`;
  no user; `status` = the receiver's HTTP status when one came back, otherwise **504**
  for a timeout and **502** for every other no-response failure (refused address, DNS,
  connect, TLS, undecryptable URL, missing key); `error_code` ∈ `webhook_http_error |
  webhook_redirect | webhook_timeout | webhook_network | webhook_blocked_address |
  webhook_undecryptable | webhook_key_missing`; and a one-line `message` naming the
  webhook name, the event and the item number, **never the URL**. Skipped deliveries
  and failed *test* sends are not recorded; webhook rows get no chip of their own and
  appear under *All* (and *5xx* when ≥ 500). The public CSP report sink
  (`/api/csp-report`, §2.4) is **excluded entirely** — none of its responses, 413 and
  429 included, is ever recorded. It is unauthenticated, and recording it would give
  anyone who can reach the proxy a write path into this table.
- **Capture.** A `withSystemLog(routeTemplate, handler)` wrapper records, in the
  route's own context, both the error responses a handler returns and the errors it
  throws (stack to stdout, a JSON 500 to the client, a 500 row here). Next's
  `instrumentation.ts` `onRequestError` catches uncaught 500s on unwrapped routes (no
  overlap: a wrapped handler's throw never reaches it). **Fire-and-forget** — the
  insert is never awaited, a logging failure can never turn a response into a 500,
  and the 2xx path pays nothing.
- **Data** — `system_events` (§5): `status`, `method`, `route` (matched template),
  `path` (concrete, **no query string**), `user_id` (null = anonymous) plus a
  point-in-time `actor_name` / `actor_email` snapshot, `error_code`, a one-line
  sanitized `message` (**no stack trace**), `request_id`, `duration_ms`, `source`.
  Never the body, the headers or the query string.
- **Anonymity (invariant 3 — the §14.5 rule).** When the request targeted an
  anonymous challenge or solution, `path` stores the **route template only**
  (`/challenges/[number]`), never the concrete number: a named user paired with an
  anonymous item outside the audited reveal is exactly the correlation §9 closes. The
  wrapper resolves this at insert from the route's already-loaded entity and
  **defaults to masking when it cannot tell**.
- **GDPR erasure (§3)** scrubs `actor_name`/`actor_email` and nulls `user_id` on the
  erased user's rows — the table is mutable, so unlike `audit_log` it is not exempt.
- **Surface — `/admin/system-log`.** Status chips (All / 5xx / 403 / 413 / 422 /
  429; 409 and the worker 401s have no chip and appear under All), a debounced search
  box (trigram substring over path, error code, message, actor name/e-mail), a
  **From/To** date range (local day → UTC; To is inclusive end-of-day), a **`✕ clear
  filters`** control shown while any filter is active, and infinite scroll in pages
  of 100. Rows show a colour-coded status pill, `METHOD path`, the error code, the
  user (click to filter by them) and a relative time; clicking a row expands the full
  record. `GET /api/admin/system-log?q&status&from&to&limit&offset`.
- **CSV export** — `GET /api/admin/system-log/export`, same gate: honours the active
  filters (exports what is on screen), capped at **50 000** rows newest-first;
  `X-Total-Matching` / `X-Exported-Count` headers drive an in-app *"exported N of M —
  narrow the range"* notice when the filtered set exceeds the cap. RFC 4180 quoting,
  UTF-8 BOM. Audited `system_log.exported` (actor, filters, row count).
- **Retention.** The worker's hourly housekeeping sweep (§14.5) deletes rows older
  than **90 days**, so the date range only ever spans that window.
- **Nav badge & alert.** The System log entry shows a `1`–`9` / `9+` superscript of
  events recorded since the admin last opened the page (`users.system_log_seen_at`,
  stamped on visit — the §14.4 mechanism). A leader-only worker sweep (every 5 min)
  posts a **coalesced** `system.error` inbox row to each platform admin — one unread
  item whose count accumulates until read, watermarked in `settings.system_log_notify_at`
  so nothing double-counts. **In-app only, never e-mailed**, and exempt from the §12.1
  preferences.

### §14.10 Identity sync diagnostics (platform admin)

A collapsible **"Identity sync"** card in the Administration console's
platform-admin section. It answers *is Entra provisioning reaching InnoBox, and is it
sending what roles need?* — the first stop when a user reports "I signed in but I'm
not an admin". **Platform admins only** (hidden from namespace admins; the API
answers **403** to anyone else). Read-only and **not audited**: it shows counts and
group object ids, no personal data (unlike the §14.5 presence read).

- **Provisioned users** — rows with `scim_synced = true`, shown as *active* and
  *deactivated* counts. Reconciliation-created rows and JIT stubs (`scim_synced =
  false`) are excluded: they prove sign-in or the safety net works, not SCIM.
  Scrubbed rows are excluded (erasure clears `scim_synced`, §3).
- **Provisioned groups** — rows with `groups.scim_synced = true` (§5: set by every
  SCIM group write). Reconciliation's mirroring of a mapped group leaves it `false`,
  so a working safety net cannot mask missing group provisioning.
- **Mapped groups that never arrived** — every distinct
  `role_mappings.group_external_id` with **no `groups` row at all**, i.e. neither
  SCIM nor reconciliation has mirrored it (the same test as the role-mapping card's
  "Dead" flag). Each is listed with the mapped role and namespace and the fixed hint
  *"Assign this group to the enterprise application, or remove the mapping."* Nobody
  can hold that role until the group arrives (invariant 1). The bootstrap admin group
  (`INNOBOX_BOOTSTRAP_ADMIN_GROUP`) is not a role mapping and is not listed.
- **Last SCIM request** — `settings.scim_last_request_at` (§5). The worker stamps it
  on every SCIM request that **passes the bearer-token check** (any method, any
  outcome), at most **one write per 60 s** per worker process, fire-and-forget (a
  failed stamp never touches the SCIM response). Shown as a relative time with the
  absolute instant in a tooltip (shared formatter), or *"Never"*. Beside it, **last
  rejected SCIM request** — the newest worker 401/403 in the system log (§14.7;
  *"None in the last 90 days"* when absent). A wrong token shows up here while the
  accepted-request time stays stale.
- **Fixed explanations** — at most one, chosen by the counts:
  - **Nothing synced yet** (provisioned users = 0 and provisioned groups = 0):
    *"Nothing has been provisioned yet. In the enterprise application's
    Provisioning settings, check that the Tenant URL is this site's address followed
    by /scim/v2, that the Secret Token matches the deployment's SCIM token, and that
    provisioning has been started (status On). Then use Provision on demand for one
    user to test."*
  - **Users but no groups** (provisioned users > 0, provisioned groups = 0):
    *"Users are arriving but groups are not, and roles come only from groups. In the
    enterprise application, assign the groups themselves (not only their members)
    under Users and groups, keep the scope at 'Sync only assigned users and
    groups', and make sure the group mapping is enabled. The next provisioning
    cycle brings them in."*
  - Otherwise no explanation is shown. A stale last-request time is **not** flagged
    on its own: Entra calls InnoBox only when something in scope changes, so a quiet
    tenant can legitimately go hours without a request.
- **Card summary** (collapsed header): *"N users · M groups"*, or *"Not synced"*
  when both are zero.
- No Entra tenant change is involved: the card only *explains* the existing runbook
  steps of `ENTRA_AUTH_SPEC.md` §3.1.
- **API:** `GET /api/admin/identity-sync` →
  `{ users: { active, deactivated }, groups, unarrivedMappedGroups: [{
  groupExternalId, role, namespaceId, namespaceName }], lastScimRequestAt,
  lastRejectedScimRequestAt, state: "ok" | "nothing_synced" | "users_no_groups" }`
  (timestamps UTC ISO or `null`).

---

## §15 Audit

Append-only `audit_log` (invariant 5): actor, action, entity, timestamp, structured
payload. Audited events at minimum: challenge/solution created, edited (diff),
withdrawn, **deleted** (the platform-admin hard delete, §10.3 — metadata, cascade
counts and the mandatory reason only, never content); every status transition
(enforced vs override, from → to); assignment
changes; visibility changes; anonymity reveals (admin and self); comment posted,
edited, deleted (incl. moderator deletes); like/unlike; attachment uploaded, bound
(staged → parent), draft-expired and **chunk-upload-aborted** (§11, with its reason —
`stale`, `client_abort`, or `size_mismatch`), scan verdict (clean, infected, or
**unscannable**), download denials; CSV exports; settings, namespace,
impact-area create/rename/retire/delete (a delete carries `before: { name, active }` plus any reassignment target and
per-challenge diffs), and role-mapping changes; **`presence.view`** — a platform admin
loading the Currently online panel, with the selected window (§14.5; one of only two
audited *reads* in the app, with `audit.verified` below, and deliberately so); SCIM sync
anomalies. Since v0.10 also:
- **identity** — `user.relinked` (§3 sign-in relink, before/after external id);
  `user.scrubbed` gains `reassignedTo`, `reassignedCount` and `skippedCount` (§3); each
  challenge an erasure moves writes an ordinary `challenge.assigned` row;
- **audit integrity** — `audit.chain_started` (the genesis row, written once by the
  migration; actor system) and `audit.verified` (every integrity run, with its result —
  the second audited *read*, deliberately);
- **curation** — `challenge.featured` / `challenge.unfeatured` (manual, or automatic with
  `trigger: "status_changed" | "deleted"`, actor = the transition's actor or the deleting
  admin, null if system-driven, §13.2); `settings.featured_limit_changed` (§14.3);
- **channel webhooks** — created, updated, deleted, tested (`webhook.*`, never the URL,
  §12.4).

**Deliberately not audited:** the worker's scheduled sweeps, webhook deliveries (their
trace is the delivery row and, on final failure, the system log), identity-sync reads
(§14.10), CSP reports (§2.4), and the purely presentational view toggle and submission
lock.

Platform admins get a read-only,
filterable audit browser. A target that resolves — a challenge or solution that still
exists — renders as a **link** to it (a solution to its parent challenge's
`#SOL-<n>`); a target that no longer resolves (a deleted challenge or solution, §10.3)
renders as plain text. Audit retains actor PII for provenance and is exempt from GDPR
erasure (§3).

**Append-only covers TRUNCATE too.** The mutation-blocking trigger is a row trigger
(UPDATE, DELETE). `TRUNCATE` bypasses row triggers, so `audit_log` also carries a
statement-level `BEFORE TRUNCATE` trigger that raises. The app role holds no TRUNCATE
grant in any case; the trigger closes the path for the owner role too, so emptying the
table requires deliberately dropping the trigger first (itself a DDL change visible in
migrations), never an accidental `TRUNCATE`.

**Hash chain (tamper evidence).** Append-only guards stop the app role and an
accidental owner-level statement. They cannot stop someone who first drops the
triggers. Every audit row written from the chain migration onward is therefore
**hash-chained**, so any later edit, deletion or insertion inside the chain is
detectable:
- **Columns** (§5): `chain_seq` (bigint — the row's position in the chain, 1-based,
  unique), `prev_hash` (the previous chained row's `row_hash`), and `row_hash`
  (lowercase hex SHA-256, 64 characters). All three are `NULL` on rows written
  before the chain migration. A CHECK requires them to be either all null or all
  set, with both hashes matching `^[0-9a-f]{64}$`. `chain_seq` exists because `id`
  (identity) and `created_at` are both assigned before the trigger takes its lock, so
  neither reliably reflects chain order under concurrency; its uniqueness also makes a
  fork impossible.
- **Computed in the database, never by the caller.** A `BEFORE INSERT … FOR EACH
  ROW` trigger (`audit_log_chain`) does the following:
  1. It takes a transaction-scoped advisory lock: `pg_advisory_xact_lock` on the
     fixed key `hashtextextended('innobox:audit_log_chain', 0)`, which is distinct
     from the worker's leader key.
  2. It reads the head, which is the row with the highest `chain_seq`.
  3. It sets `chain_seq = head + 1`, `prev_hash = head.row_hash`, and `row_hash`
     over the canonical form below, **overwriting** any value an `INSERT` supplied.

  The lock is held until commit, so concurrent audit writes from web and worker
  **serialize** and each one reads a committed head. A rolled-back insert releases
  the lock and leaves no gap: the next writer reuses its position, which is why
  `chain_seq` is not a sequence. The cost is accepted at v1's scale (one web, one
  worker): a long audited transaction (bulk triage, the §10.3 cascade, an impact-area
  delete with per-challenge diffs, an erasure with many moves) blocks other audited
  writes until it commits, and crossing this lock with row locks in a different order
  can surface as a detected deadlock (`40P01`, one transaction aborted). Where cheap,
  code writes its audit rows last in a transaction; no retry logic is specified.

  The trigger **raises unless the transaction is `READ COMMITTED`**. That is the
  platform default, and no code path uses another level. Under a fixed snapshot the
  head read could be stale, and the unique `chain_seq` index would then reject the
  insert anyway, so a fork is impossible either way. `db/migrations/README.md` records
  that the chain trigger must never be dropped or bypassed and that `audit_log` inserts
  run under `READ COMMITTED`.

  Chain order is `chain_seq` order. It can differ from `id` and `created_at` order,
  and nothing relies on the three agreeing.
- **Canonical form (v1).** `row_hash = sha256(utf8(C))` as lowercase hex. `C` is the
  line `innobox-audit-v1\n` followed by ten fields in this fixed order: `chain_seq`,
  `id`, `created_at`, `actor_user_id`, `action`, `target_type`, `target_id`,
  `before`, `after`, `prev_hash`.

  Each field is encoded as `~\n` when it is SQL `NULL`. Otherwise it is encoded as
  `<n>:<value>\n`, where `<n>` is the value's length in UTF-8 **bytes**, written in
  base 10. The length prefix makes the encoding unambiguous for any value, newlines
  included. An empty string is `0:\n`, which is distinct from `NULL`.

  Values:
  - `chain_seq`, `id` — base-10, no sign, no leading zeros.
  - `created_at` — UTC, `YYYY-MM-DDTHH:MM:SS.ffffffZ`, always six fractional digits
    (`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`).
  - `actor_user_id` — the canonical lowercase hyphenated UUID text.
  - `action`, `target_type`, `target_id` — the stored text verbatim.
  - `before`, `after` — PostgreSQL's own `jsonb` text output (`before::text`). It is
    deterministic for a stored value: keys are de-duplicated and ordered, and the
    separators are fixed. A verifier obtains it by selecting `::text`, **never** by
    re-serializing a parsed object. SQL `NULL` is `~`; a JSON `null` value is the
    four-byte string `null`.
  - `prev_hash` — 64 lowercase hex characters.
- **Genesis.** The chain migration runs in **one transaction**, and its
  `ALTER TABLE` lock blocks concurrent audit writes until it commits. It does three
  things:
  1. It adds the columns. This changes metadata only: no existing row is rewritten,
     so the immutability trigger never fires and **existing rows stay unchained**.
     Back-filling them would require the very `UPDATE` invariant 5 forbids.
  2. It installs the trigger.
  3. It inserts one **genesis row** — `action = audit.chain_started`,
     `target_type = audit_log`, actor `NULL` (system), and
     `after: { unchainedCount: <rows with chain_seq NULL>, lastUnchainedId: <their
     max id, or null> }`. The trigger chains it as `chain_seq = 1` with `prev_hash`
     set to 64 zeros; it is the only row whose head read finds nothing.

  The migration is idempotent: the genesis row is inserted only when no chained row
  exists.
- **Interaction with the existing guards.** The chain trigger fires on `INSERT`
  only. `audit_log_no_mutation` (row, `UPDATE`/`DELETE`) and `audit_log_no_truncate`
  (statement, `TRUNCATE`) are unchanged and still refuse every mutation, so a hash
  can never be "corrected" in place. The app role's grants stay `SELECT, INSERT`.
  The chain adds detection *behind* those guards; it does not replace them.
- **What it proves.** Verification proves the chain is **internally consistent**:
  no chained row was edited, removed or slipped in unless every later hash was
  recomputed too. Someone with owner rights who drops the guards *and* recomputes
  the whole tail cannot be detected from inside the database alone. An operator who
  records the reported head (`chain_seq` + `row_hash`) outside the system can later
  prove that nothing up to that point was rewritten; external anchoring is not a v1
  feature (§19).

**"Verify integrity"** (audit browser, platform admin only). A **Verify integrity**
button on `/admin/audit` runs `POST /api/admin/audit/verify`:
- **Streamed both ways.** The server walks the chain in `chain_seq` order, in keyset
  pages of 5 000, up to the head captured when the run starts. Rows are immutable,
  so no long transaction is needed. The response is streamed as
  `application/x-ndjson`: a `{ "type": "start", "head": <chain_seq> }` line, then a
  `{ "type": "progress", "checked": n }` line every 10 000 rows, then one final
  `{ "type": "result", … }` line. The page shows *"Checked n of N rows…"* while it
  runs.
- **Independent recomputation.** The web process recomputes each row's hash from the
  fields read as text (as defined above) instead of calling the trigger's function.
  A defect or tampering in that function therefore shows up as a break instead of
  being reproduced.
- **Checks, stopping at the first failure:**
  - The genesis row has `chain_seq = 1`, action `audit.chain_started`, and an
    all-zero `prev_hash`.
  - Each next row has `chain_seq = previous + 1`. Otherwise the break is
    **`sequence`**: a row is missing or extra.
  - Each row's `prev_hash` equals the previous row's `row_hash`. Otherwise the break
    is **`link`**.
  - The recomputed hash equals the stored `row_hash`. Otherwise the break is
    **`content`**.
  - Finally, the count of unchained rows must still equal the genesis row's
    `unchainedCount`, and no unchained row may have an id above `lastUnchainedId`.
    Otherwise the break is **`unchained`**: a row was written with the trigger
    disabled, or a pre-chain row vanished.
- **Result:** `{ result: "intact" | "broken", checked, head: { chainSeq, rowHash },
  firstBreak: null | { id, chainSeq, check, expected, actual } }`. For `link` and
  `content`, `expected` and `actual` are the two hashes. For `sequence` they are the
  two sequence numbers, and for `unchained` the two counts (or the offending id).
  The page shows *"Audit log intact — n entries verified (chain head #<seq>)"* or
  *"Audit log broken at entry #<id>: expected …, found …"*.
- **Every run is audited** as `audit.verified`, with actor = the admin and
  `after: { result, checked, headChainSeq, firstBreak }`. A run the client abandons
  mid-stream stops and is audited with `result: "aborted"`. The `audit.verified` row
  joins the chain after the head it verified. Only one run may be active per web
  process; a second request answers **409** *"A verification is already running."*
  The request counts against the ordinary state-changing rate limit (§2.4).

**No trim.** A retention trim of old audit rows was considered and **rejected**.
Deleting audit rows is exactly what invariant 5 forbids, and it would also cut the
chain's anchor. The audit log grows for the life of the deployment (§19).

**Audit browser (`/admin/audit`, platform admin).** The default view is the newest
100 rows, infinite scroll in pages of 100 over all history. Layered on top, all
optional and composable (each an additional `AND`):

- **Category chips** by action prefix — All / Challenges (`challenge.*`) / Solutions
  (`solution.*`) / Comments (`comment.*`) / Attachments (`attachment.*`) / Identity
  (`user.*`, `scim.*`, `role_mapping.*`, `recon.*`) / Admin (`settings.*`,
  `namespace.*`, `impact_area.*`, `system_banner.*`, `presence.*`, `email.*`,
  `audit.*`, `webhook.*`, every `*.exported`) / **Anonymity** (`anonymity.*` — admin
  reveals and self-reveals, the most sensitive reads to review). The curation events (`challenge.featured` /
  `challenge.unfeatured`) fall under Challenges by prefix; `like.*` rows appear under
  All only. The triage CSV export (§14.1) is audited as **`triage.exported`**, so it
  matches `*.exported`; rows written earlier under `admin.triage_exported` stay as they
  are (invariant 5) and the Admin chip matches that legacy name explicitly.
- **Search box** (debounced) — a plain `ILIKE` over the human-meaningful fields:
  action, target type, target number, actor name, actor e-mail (joined live). The
  JSON payload is deliberately **not** searched and there is no trigram index — the
  query is bounded by `ORDER BY id DESC LIMIT 100` on the primary key (newest first;
  `id` is unique, so paging never skips or repeats a row with a shared timestamp).

> **⚠ GAP-48 · code fix:** there is no Anonymity chip: `AUDIT_CATEGORIES` and
> `AUDIT_CATEGORY_PATTERNS` (`shared/src/audit-browser.ts`) stop at Admin, so
> `anonymity.*` rows show only under All. Add the chip (pattern `anonymity.%`) to the
> shared lists and the `/admin/audit` page, and correct the comment on
> `AUDIT_CATEGORY_PATTERNS` that says anonymity reveals appear under All.
- **Date range** — two native date inputs; the picked **local** day resolves to UTC
  instants, From = start of day, To = **inclusive** end of day.
- **`✕ clear filters`** — shown only while any filter is active; resets to the default
  view.

`GET /api/admin/audit` gains `q`, `category`, `from`, `to` beside `limit`/`offset`.

**CSV export** — `GET /api/admin/audit/export`, platform admin only (the only role
that sees the browser at all): honours the same active filters, so it downloads
exactly what is on screen; capped at **50 000** rows newest-first, with
`X-Total-Matching` / `X-Exported-Count` headers driving the in-app *"exported N of M —
narrow the range"* notice; every column of the row — `chain_seq`, `prev_hash` and
`row_hash` included, appended after `after` — with `before`/`after` as their raw JSON
strings, i.e. PostgreSQL's own `::text` output (the bytes the hash chain covers, so an
exported row can be re-verified offline); RFC 4180 quoting, UTF-8 BOM. **Rows are
not anonymity-masked.** The audit log is the provenance record: it already shows the
true actor of an anonymous submission to platform admins in the browser, and those
same admins hold the §9 reveal power — a masked export would be lossy while leaving the
browser as the unmasked path. The compensating control is that **every export is
itself audited** — `audit.exported` with actor, active filters and row count — so a
bulk download of identities is never silent.

> **⚠ GAP-49 · code fix:** `api/admin/audit/csv.ts` re-serializes the parsed objects
> with `JSON.stringify`, which differs from the stored jsonb text in spacing; the
> export query in `api/admin/audit/store.ts` selects `a.before, a.after` as jsonb.
> Select `before::text` / `after::text` for the export and write them verbatim.

---

## §16 API surface (contract level)

REST under `/api`, session-authenticated, JSON, UTC ISO timestamps. Resource groups:

- `challenges` (list/search/detail/create/edit/withdraw/transition/assign/visibility/
  **delete**; `challenges/similar` — the §6.1 duplicate check; `challenges/new-count`
  — the §13.1 bare integer; `challenges/:number/featured` `PUT`/`DELETE` — platform
  admin, §13.2, 409 at the cap or on an ineligible status; the detail payload carries
  `featured`/`canFeature`)
- `challenges/:number/solutions` (create — `POST` only; solutions are **read** inside
  the challenge detail payload, there is no standalone solution `GET`, matching the
  page model of §13.1), `solutions/:number` (edit/withdraw/resubmit/transition/reveal/
  self-reveal/**delete**) — `DELETE` on a challenge or solution is the platform-admin
  hard delete (§10.3): reason required in the body, cascading, irreversible, **404 (not
  403)** to anyone else
- `comments` (list/create/edit/delete on either parent type); `likes`, `follows` (one
  **toggle** `POST` each, on either parent type — the response carries the new state;
  a like toggle on a closed challenge is **409**, §8.3)
- `attachments` (single-shot upload — bound or **staged via `draftKey`**; **chunked upload** via `attachments/uploads` — initiate → parts → complete/abort — for files over the chunk size; list own staged by `draftKey`; gateway download; `challenges`/`solutions` create accept a `draftKey` to bind staged files, **gated on a clean scan when a scanner is available**)
- `notifications` (inbox, mark read; the unread poll carries the §14.6 banner), `me`
  (`GET` identity, roles and flags; `PATCH` sets the §13.7 quick-start flag;
  `me/challenges-seen` advances the §13.1 marker), `profile` (own and other users'
  profiles, §13.5; `PATCH` carries the e-mail switch and the three §12.1 per-event
  toggles)
- `users/:id/photo` (authenticated avatar image gateway, §3.1),
  `users/:id/card` (directory hover card — any authenticated user; 404 on unknown or
  malformed id, §13.8)
- `leaderboards`, `dashboard` (KPIs, spotlights, **featured** — visibility-filtered
  pins, §13.2)
- `admin/*` (queue incl. proposed-solutions tab, bulk, export, settings, namespaces, role-mappings, audit; **triage attention count + mark-seen**, §14.4;
  **`admin/presence?window=5m|1h|8h|24h|30d` → `{ asOf, dau, wau, mau, total, users[] }`
  and `admin/presence/history?range=7d|30d|90d|all` → `{ points[] }`** — platform admin
  only (**403** for namespace admins), anonymity-masked locations, §14.5;
  **`admin/audit` with `q`/`category`/`from`/`to` + `admin/audit/export`** (§15);
  **`admin/system-banner` `PUT`/`DELETE`** (§14.6); **`admin/system-log` +
  `admin/system-log/export` + mark-seen** (§14.7) — all platform admin only;
  since v0.10: **`admin/audit/verify`** (`POST`, NDJSON stream, one run at a time —
  **409** otherwise, §15); **`admin/identity-sync`** (`GET`, §14.10);
  **`admin/users/:userId/scrub`** (`POST`, the §3 erasure — body `{ reassignTo?: uuid |
  null }`, an empty body or `{}` keeping the no-successor behaviour; **400** when
  `reassignTo` is not a uuid, is not an active non-scrubbed user, or equals `:userId`;
  **404** for an unknown user; **409** when already scrubbed, checked before anything
  changes; **200** returns `{ ok: true, reassignment: null }` or `{ ok: true,
  reassignment: { successorId, moved: [{ number, title }], skipped: [{ number, title,
  reason: "not_visible" }] } }` — titles are safe here: the caller is a platform admin,
  who sees every item, and titles carry no author identity); **`admin/webhooks`
  `GET`/`POST`, `admin/webhooks/:id` `PATCH`/`DELETE`, `admin/webhooks/:id/test`
  `POST`** (§12.4 — the URL is write-only: responses carry `urlHint`, never the URL) —
  all platform admin only)
- **The one unauthenticated API route:** `POST /api/csp-report` — the CSP report sink
  (§2.4): `application/csp-report` or `application/reports+json`, 64 KB cap, per-IP
  rate limit, **204** with no body; exempt from the `Origin` check; never stored, not
  system-logged, not audited.

Exact shapes are defined during implementation and documented alongside the code;
any change to a shipped shape is a spec change first (§17). Responses apply
visibility and anonymity masking server-side without exception (invariants 2–3).
Every route also follows the §2.4 baseline: the `Origin` check on state-changing
requests, the body-size limits, rate limiting (**429** with `Retry-After`), 404 for
anything the caller can't see, and a 4xx (never 500) for malformed or invalid input —
400 for an unparseable body, 400 or 422 for invalid fields as each route documents
(§2.4). The v0.10
mutation endpoints above use the `mutation` bucket unless stated otherwise, and their
error messages carry no `§` references (§21.9).

---

## §17 Engineering process (mandatory)

1. **Gated, spec-first workflow:** grill → update this spec only → **stop for
   user approval** → implement to match → release ritual. Never code before the
   approved spec.
2. **Tests ship with the change:** unit (state machines, RBAC, validation,
   anonymity masking), integration (API + DB + SCIM conformance vs Entra payloads),
   e2e (submit → triage → propose → validate → implement → auto-close; notification
   fan-out; anonymity masking end-to-end).
3. **Release ritual per commit:** spec ✓ → implementation + tests ✓ (`pnpm
   typecheck` + touched packages' tests pass) → `APP_VERSION` bump → changelog entry
   (`{version, date, summary}`, newest first, date UTC `YYYY-MM-DD`) → commit
   `type(scope): summary (vX.Y.Z)`. Bump rules: **patch** = bug fixes, styling,
   copy, refactors; **minor** = new features, endpoints, pages, behaviors, DB
   migrations; **major** = breaking changes (API shapes, required config). One bump
   per commit at the highest applicable level; the new version must be strictly
   greater than the highest already in branch history.
4. Doc-only/infra-only changes skip version/changelog.

---

## §18 Build order

- **Phase 0 — foundations:** repo scaffold (pnpm workspaces, shared/web/worker),
  compose stack, migrations pipeline, version/changelog plumbing, CI.
- **Phase 1 — identity:** OIDC sign-in, SCIM + reconciliation, namespaces,
  role_mappings, RBAC resolution.
- **Phase 2 — core domain:**
  - *First slice:* challenge submission (§6.1), solution proposal (§6.2), the
    dedicated Challenges page — browse + detail (§13.1), the admin status-override
    control only (§7.2/§8.2 implementation notes), full anonymity masking (§9,
    reveal excluded), and a minimal likes slice (challenge/solution like toggle,
    pulled forward from Phase 3) — all visibility-enforced and audited.
  - *Remainder:* the enforced committee/assignee state machines and their triage
    UI, assignment (§7.3), attachments + scan gateway (§11), FTS search (§13.4),
    editing/withdrawal (§10.1).
- **Phase 3 — social & notifications:** comments, follows, outbox, e-mail + in-app
  inbox, anonymity reveal (admin + self, §9). (Likes ship early, in Phase 2's first
  slice.)
- **Phase 4 — discovery & admin:** Home dashboard (KPIs, spotlights, §13.2),
  leaderboard (§13.3), profile (§13.5), triage queue + bulk + CSV, platform
  settings, polish.

## §19 Non-goals (v1)

No data migration from SharePoint; no Power Apps/old-link compatibility; no links to
the legacy SharePoint site; no campaigns/challenge deadlines; no reward points; no
comment threading; no scheduled digest e-mails (the per-item coalescing of comment
notifications, §12.1, is in scope and is not a digest); no undelete, trash, or restore for a deleted
challenge or solution (§10.3 is permanent by design); no i18n;
no Kubernetes/Helm, HA, or SAML; no mobile app; no audit-log trim or retention window (considered and rejected: deleting audit rows violates
invariant 5 and would sever the hash chain's anchor, §15); no external anchoring of the
audit chain (timestamping service, transparency log — recording the reported head
out-of-band is an operator practice, not a feature); no stored CSP reports (violations
are a counter, never a table, §2.4); no Entra front-channel logout (§3); for channel
webhooks (§12.4): no per-user webhooks, no per-webhook event selection, no HMAC payload
signing, no egress proxy, and no port other than 443.

Two further non-goals are settled by the open-source release (§21) and were
explicitly considered and rejected rather than merely deferred:

- **No demo/evaluation mode.** A self-hosted deployment requires a Microsoft Entra
  tenant; there is no way to run InnoBox without one, and the README says so plainly
  (§21.8). The only mechanism available for a credential-based demo is the dev-auth
  bypass, whose `NODE_ENV !== "production"` guard (§2.3) is exactly what makes it
  safe; a shipped demo mode would require weakening it. Lowering the barrier to
  evaluation does not justify that trade.
- **No IdP abstraction.** Entra is a hard dependency, not one provider among several.
  Generic-OIDC or Keycloak/Okta support would reach into invariant 1 (roles resolve
  from SCIM-synced group membership, never from token claims) and is a separate spec
  if it is ever wanted.

## §20 Decisions log (from the requirements interview, 2026-07-08)

Clean start, no migration · terminology Challenge/Solution · distinct per-namespace
Committee with enforced-transition power · namespaces with per-challenge
org|namespace visibility · assignee can transition/request-improvements/comment · authors see own
awaiting-triage items, as do namespace admins · admins transition freely, others via
the state machine · genesis renamed "awaiting triage" · needs-improvement unlocks
author editing · solutions only on `valid` challenges · single winning solution,
challenge auto-solved on `implemented`, siblings → `not_selected` · anonymity option
(b): stored identity, masked everywhere, audited admin reveal, no identity in e-mails
· anonymous contributions excluded from leaderboards · one-way self-reveal ·
corporate "Anonymous" branding · likes on challenges & solutions with unlike, used
for ranking · flat comments on both entities, instant post, admin delete ·
follows in v1 · Graph service-account e-mail with per-user opt-out + confirmed
event matrix · in-app bell
inbox in v1 · top-10 leaderboards, last-month/all-time, four metrics · spotlight
cards kept · tabs + filters kept + FTS added · triage queue kept + bulk actions +
CSV export · attachments default 5 × 10 MB, admin-configurable · client name
required iff impact = Client · impact areas admin-managed — add/rename/retire/delete,
delete reassigns or requires zero references (seeded with the legacy three) · unused legacy fields dropped · version-nag/beta-gate/legacy screens dropped.

---

## §21 Open-source release

InnoBox is published as open source. This section is the complete definition of that
release: what the licence is, what ships, what does not, and what must be true before
the first public push. It changes **no application behavior** — every item below is
licensing, documentation, CI, or repository hygiene. No runtime code path is added,
removed, or altered by §21.

### §21.1 Licence

- **Apache-2.0.** Chosen over MIT for its explicit patent grant and, decisively, its
  §6 trademark clause: the brand ships as the default look (§2.2) and Apache-2.0
  already withholds any right to the organization's marks, so the "keep it, but a
  fork may strip it" position needs no bespoke licence text and no non-OSI
  attribution clause.
- **`LICENSE`** at the repository root: the unmodified Apache-2.0 text including the
  appendix, naming the organization as copyright holder for the current year.
- **`NOTICE`** at the repository root: the copyright line, per Apache-2.0 §4(d).
- **Manifests.** All four `package.json` files keep `"private": true` — it is the
  guard against an accidental `npm publish`, and nothing here is intended for the
  registry — and gain `"license": "Apache-2.0"`. Their `"version"` fields stay at
  `0.0.0` **deliberately**: `APP_VERSION` in `packages/shared/src/version.ts` is the
  single source of truth for the product version (§17.3), and introducing a second
  version to keep in step would add a bump to every commit for no benefit. The README
  states this so the mismatch does not read as an oversight.
- **Dependency licences.** Before publication, `pnpm licenses list --prod` is
  reviewed across the workspace and the result recorded in the publication checklist
  (§21.9). The production tree must contain no copyleft licence. `NOTICE` carries
  nothing beyond the project's own copyright unless that review surfaces a dependency
  whose licence requires attribution. Fonts are **not** an issue: Montserrat, Open
  Sans, and JetBrains Mono arrive as `@fontsource-variable/*` npm dependencies, so no
  font binaries are vendored into the repository and their licences travel with the
  packages.
- **Review outcome (pre-publication).** The production tree is MIT, Apache-2.0, ISC,
  BSD-3-Clause, 0BSD, MIT-0, OFL-1.1 (the fonts) and CC-BY-4.0 (`caniuse-lite`, whose
  attribution travels in its own package) — no copyleft, so `NOTICE` is unchanged. The
  one copyleft hit was **`sharp`**, an optional dependency of `next` whose prebuilt
  libvips binary is LGPL-3.0. It is **excluded, not accepted**: the root `package.json`
  lists it under `pnpm.ignoredOptionalDependencies`, and `next.config.ts` sets
  `images.unoptimized` so Next never looks for it. Nothing is lost — InnoBox renders no
  `next/image`. Re-run the review after any upgrade of `next`, since a new optional
  dependency would arrive the same way.

### §21.2 Brand, trademark & rebranding

The brand stays as the shipped default and is **removable, not required**. A fork
that strips it is exercising a right Apache-2.0 §6 already gives it.

- **`README.md` carries a TRADEMARK section**, not licence text: the organization's
  name, logo, and the InnoBox wordmark are not covered by the Apache-2.0 grant; forks
  may use the software freely but must not present themselves as the original.
- **Rebranding checklist** — the README documents the complete set of files a fork
  edits to remove the organization's identity. The §2.2 removability rule exists to
  keep this list short and exhaustive:
  1. `packages/web/src/components/AppShell.tsx` — the colophon line.
  2. `packages/web/e2e/discovery.spec.ts` — its e2e assertion.
  3. `packages/web/src/lib/attribution.test.ts` — the hygiene test itself, which
     becomes meaningless downstream and should simply be deleted.
  4. `packages/web/public/brand/` and `packages/web/src/app/icon.svg` — wordmark,
     theme variants, OG card, browser icon.
  5. `packages/web/src/app/globals.css` — the §2.2 token table, if the palette is
     also being replaced.
- The **"Powered by the community"** colophon line is not attribution and is not part
  of the rebranding list.

### §21.3 What ships, and what does not

| Item | Ships | Rationale |
|---|---|---|
| `INNOBOX_SPEC.md` | ✅ | The authoritative design document. Without it the public repository has no design documentation at all. |
| `ENTRA_AUTH_SPEC.md` | ✅ | Cited **37 times across 32 shipped files** — `rbac.ts`, `authOptions.ts`, every admin/namespace/role-mapping route, `AppShell.tsx`, two migrations, `docker-compose.yml`, `.env.example`. Dropping it would leave dangling references throughout published code. Contains no secrets and no deployment specifics. |
| `CLAUDE.md` | ✅ | The working context and the gated workflow. Transparent about how the project is built. |
| `START_PROMPT.md` | ❌ | A bootstrap prompt for seeding a *new* repository from the starter kit. Meaningless once the repository exists; deleted, not merely unshipped. |
| `.claude/skills/**` | ❌ | `scalify-ui` **is** the organization's brand book; `scale-entra` is an internal playbook. Added to `.gitignore` and `git rm --cached`, so they keep working on disk for local development but never reach the public repository. |
| `.gitlab-ci.yml` | ❌ | Superseded by GitHub Actions (§2.3). |

Removing the skills leaves **dangling references in three places, not one**, and all
three must be rewritten:

1. **The docs** — `CLAUDE.md` (the "Bundled skills" section, two key-file rows, the
   attribution invariant's carve-out, the Phase 4 instruction), this spec (§2.2 ×3,
   §3), `ENTRA_AUTH_SPEC.md` (×4), and `README.md`.
2. **Code comments** — the SCIM implementation cites `scale-entra`'s provisioning
   reference throughout (`scim/router.ts`, `filter.ts`, `patch.ts`, `patch.test.ts`,
   `resources.ts`, `scim.dbtest.ts`, `leader.ts`), and `globals.css` cites
   `scalify-ui` as its token authority. These are easy to miss because they are not in
   any document; a repository-wide search, not a docs search, is what finds them.
3. **Configuration** — `deploy/.env.example` points an operator at `scale-entra` for
   the Entra setup, and the `Jenkinsfile` header references `.gitlab-ci.yml`.

Each is repointed at the in-repo authority: `ENTRA_AUTH_SPEC.md` §5 for the SCIM
provisioning contract, and §2.2 of this document for the brand tokens. §2.2's "where
the skill and this table disagree, the skill wins" rule is **inverted**: this
document's token table is the sole brand authority.

### §21.4 Repository & history

- **Home:** the public GitHub repository under the organization's GitHub org. Not a
  mirror — development happens there. The switch-over date is an operational decision;
  this document prescribes nothing about the internal repository it replaces.
- **History: squashed to a single initial commit.** The pre-release history exposes
  contributors' work e-mail addresses permanently and the internal evolution of this
  spec. The public repository starts from **one orphan commit** whose tree is exactly the
  frozen `main`; only `main` is pushed — never other branches, tags, `--all`, or
  `--mirror`, any of which would carry the old history back.
- **No work e-mail address in the public commit.** The initial commit is authored and
  committed by the releasing maintainer under their **GitHub noreply address**
  (`<id>+<login>@users.noreply.github.com`) and carries **no `Co-Authored-By:` trailer
  for a person**. Other maintainers are credited by their own commits going forward.
  Maintainers commit to the public repository under their noreply addresses and enable
  GitHub's "block command line pushes that expose my email". Copyright is corporate
  (§21.1) regardless.
- **Consequence for §17.3.** `CLAUDE.md`'s changelog-backfill rule names
  `git log --first-parent` on `main` as the source of truth for past versions. After
  the squash there is one commit; **`packages/web/src/app/whats-new/changelog.ts`
  becomes the sole record** of version history and that rule is rewritten accordingly.
  Existing entries are preserved verbatim through the squash.
- **Deploy is reconfigured by the operator at switch-over.** The pipeline no longer
  authenticates the deploy-host clone (the Gitea token credential is gone; clone and
  fetch are anonymous against the public repository), so the operator repoints the
  `innobox-repo-url` credential at the GitHub clone URL **after** the repository is
  public, and may delete the old token credential. Jenkins builds **`main` only** and
  never builds pull requests from forks — its agent holds the production credentials,
  and a public repository accepts fork pull requests from anyone. The Deploy stage also
  refuses any change-request build, and its manual `DEPLOY` parameter defaults to off.
- **Secret scan is a hard gate.** A clean `gitleaks` (or equivalent) run over the
  published tree **and** the full pre-squash history precedes the first public push
  (§21.10). Manual inspection is not sufficient evidence. A deliberate test-only fixture
  that trips the scanner is marked inline with `gitleaks:allow`, never by weakening the
  scan.

### §21.5 Governance & security disclosure

- **Contributions: issues open, pull requests closed.** The organization makes no
  commitment to review external code. GitHub cannot disable pull requests, so the
  posture is stated in three places: `CONTRIBUTING.md`, a pull-request template, and a
  small Actions workflow that **auto-closes incoming pull requests** with a courteous
  pointer to the issue tracker. `CONTRIBUTING.md` explains what *is* welcome — bug
  reports, questions, and feature discussion in issues. No CLA and no DCO, since no
  external code is accepted.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1. Issues are open, so public
  interaction happens and needs a stated standard.
- **`SECURITY.md`** — vulnerability reports go through **GitHub private security
  advisories**. Deliberately **no e-mail address**: an address would be a
  deployment-specific value in the repository, which §2.3 forbids, and advisories give
  a private channel with none of that cost. The file states the supported version
  (`main` only), the expected response posture, and a short scope statement: InnoBox is
  self-hosted software; reports concern the code, not any particular deployment.

### §21.6 New and rewritten files

New: `LICENSE`, `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
`.github/workflows/ci.yml`, `.github/workflows/close-prs.yml`,
`.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/` (bug report, feature
request, and a `config.yml` that disables blank issues), `.github/dependabot.yml`
(weekly grouped npm and Actions updates), `packages/web/src/lib/spec-refs.test.ts`
(§21.9). There is deliberately **no `CODEOWNERS`**: it would have to name an org team or
personal handles, both of which are values §2.2 and §2.3 keep out of the repository;
review requirements live in the repository's GitHub rulesets instead. The issue
templates likewise carry no repository URL — the security pointer is prose naming
`SECURITY.md`.

Rewritten: `README.md` (§21.8 — a full rewrite; the current file is the starter-kit
"copy this directory to a new repo" document and links two things that will not
exist), `CLAUDE.md` and this spec (§21.3 reference rewrites, §2.2 authority
inversion), `.gitignore` (`.claude/skills/`).

Deleted: `START_PROMPT.md`, `.gitlab-ci.yml`.

> **⚠ GAP-50 · code fix:** `packages/web/src/app/globals.css` still opens with the
> "STARTER-KIT NOTE: carried over from a proven sibling app …" paragraph in its header
> comment, a starter-kit artefact; replace it with a plain description of the file.

### §21.7 The attribution test

`packages/web/src/lib/attribution.test.ts` is rescoped per §2.2: it scans the whole
`packages/**` tree rather than `packages/*/src/**`, excluding build output and
`node_modules`, and allowlists exactly `components/AppShell.tsx` and
`e2e/discovery.spec.ts`. The assembled-from-fragments trick that keeps the scanner
from matching itself, the non-empty-scan guard, and the colophon-shape assertions are
all retained. The widened scope is the point: the old scope excluded `e2e/`, which is
why a second occurrence existed without being recorded anywhere.

### §21.8 README

The public README is the front door and replaces the starter-kit document entirely.
It states, in order: what InnoBox is; a screenshot or two; **prerequisites, stated
bluntly and first** — a Microsoft Entra ID tenant (app registration for OIDC, an
Enterprise Application for SCIM), PostgreSQL, S3-compatible object storage, ClamAV,
and optionally a Microsoft Graph service mailbox for e-mail; **that there is no demo
or evaluation mode** and InnoBox cannot be run without an Entra tenant (§19);
self-hosting instructions pointing at `deploy/`; an architecture summary pointing at
this spec and `ENTRA_AUTH_SPEC.md`; the TRADEMARK section and rebranding checklist
(§21.2); the licence; the versioning note (§21.1); and, last, contributing, security
and a plain **support statement** — the software is provided as-is, issues are read
but no response time is promised, and pull requests are closed. The screenshots live
under `docs/screenshots/`. It contains **no host, no mailbox, and no
deployment-specific value** (§2.3).

> **⚠ GAP-51 · doc fix:** `README.md`'s closing sections run Versioning →
> Contributing, security, support → Licence → Trademark; reorder them to Trademark
> (with the rebranding checklist) → Licence → Versioning → Contributing, security,
> support.

### §21.9 No internal spec references in user-facing surfaces

`§n` references are **internal to this document** (see the preamble) and must not
reach a user. A person using InnoBox has no access to `INNOBOX_SPEC.md` and no way to
resolve "§10.1"; publishing the repository does not change that, it only makes the
references look like leaked internal shorthand rather than mere noise.

**No `§` reference appears in any surface a user can see** — API error messages
returned to the browser, the What's new changelog, page copy, form validation
messages, e-mail templates, or notification text. The message must stand on its own:
`"this challenge is not editable in its current status"`, not
`"this challenge is not editable in its current status (§10.1)"`. Dropping the
reference is the whole edit; the wording that precedes it is already self-contained.

**`§n` references remain correct and encouraged in code comments, JSDoc, tests, SQL
comments, and the specs themselves** — that is what they are for, and they are the
main way the implementation stays anchored to this document. The rule is about the
boundary between the codebase and the person using it, not about the codebase.

A **hygiene unit test** (`packages/web/src/lib/spec-refs.test.ts`) enforces it,
mirroring the attribution test (§21.7): it strips JavaScript block and line comments
and SQL line comments from every non-test `.ts`/`.tsx` file under `packages/*/src`,
then fails on any surviving `§`. What survives comment-stripping is a string literal
or JSX text — that is, something a user can see. The test assembles its own needle
from a character code so it does not match itself, and carries the same
non-empty-scan guard.

### §21.10 Publication checklist

All of the following are true before the first public push, in order:

1. This section is approved and the implementation matches it.
2. `pnpm licenses list --prod` reviewed; no copyleft in the production tree; `NOTICE`
   reflects the outcome.
3. `gitleaks` (or equivalent) run over the published tree and the **full** pre-squash
   history: clean.
4. `pnpm typecheck` and every package's tests pass, including the rescoped
   attribution test (§21.7) and the spec-reference test (§21.9).
5. `.claude/skills/**` removed from the index and confirmed absent from
   `git ls-files`.
6. All skill references — docs, code comments, and configuration alike (§21.3) — and the `START_PROMPT.md` reference rewritten or
   removed; no dangling links to files that will not ship.
7. Organization GitHub org prerequisites confirmed with an org administrator:
   repository creation, private security advisories enabled, Actions permitted.
8. History squashed to one orphan commit authored under the releasing maintainer's
   GitHub noreply address, with no person `Co-Authored-By:` trailer and no work e-mail
   address anywhere in it; `changelog.ts` intact; only `main` pushed.
9. Jenkins repointed at the new remote, building `main` only and never fork pull
   requests; a deploy verified green from the new remote.
