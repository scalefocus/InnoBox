# INNOBOX_SPEC.md — InnoBox

> **The authoritative specification.** Every change to app behavior lands here first,
> is reviewed and approved, and only then gets implemented. Code follows spec, never
> the reverse. `§n` references are internal to this document.
>
> Status: **v0.8 — draft for review** (2026-07-08; v0.2 added the UI and CI/CD
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
> fork-removability guarantee). Derived from the legacy
> Power Apps "InnoBox" canvas app (solution export `innobox-solution-master@e67e8ca94e4`)
> and a requirements interview with the product owner. This is a **brand-new
> development**: it serves the same business process but carries **no backwards
> compatibility** with, and no data migration from, the Power Apps app or its
> SharePoint lists.

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
  reconciliation, ClamAV scan pipeline, notification dispatch (outbox). **Singleton,
  leader-locked** via Postgres advisory lock.
- **`packages/shared`** — domain types, RBAC resolution, state-machine logic,
  validation.
- **Postgres** — metadata, `tsvector` FTS, append-only `audit_log`.
- **S3/MinIO** — immutable attachment objects.
- **ClamAV** — attachment scanning.
- **Deployment** — docker compose stack (`postgres`, `migrate`, `minio`, `clamav`,
  `web`, `worker`, `proxy`); plain-SQL migrations in `db/migrations` applied in order
  by the `migrate` service.

Cross-cutting requirements:

- Node ≥ 20, pnpm 9.x pinned via `packageManager`; TypeScript everywhere, ESM.
- Parameterized SQL through a thin query layer; no ORM magic.
- Secrets via env / mounted files only; never in images or the repo.
- Structured JSON logs; health `/healthz`, readiness `/readyz`, Prometheus `/metrics`
  on **both** web and worker. `/metrics` emits the Prometheus text exposition format:
  `innobox_build_info{version,service}`, `innobox_up`, process memory/uptime gauges, and
  (worker) `innobox_worker_leader` plus notification- and scan-sweep counters. When
  `METRICS_TOKEN` is set, `/metrics` requires `Authorization: Bearer <token>` (401 otherwise);
  when unset it is open (local dev).
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
   autocomplete, counts, KPIs, leaderboards, or notifications to users outside its
   namespace (§4.3). The **sole** unauthenticated surface is the Home route (`/`),
   which doubles as the sign-in landing: while unauthenticated it renders a static
   welcome and the sign-in control **only** — no challenge/solution/user data, KPIs,
   counts, spotlights, search, or notifications are fetched or shown (§2.2, §13.2).
3. **Anonymity is enforced at the API layer, everywhere** — lists, details, search,
   exports, e-mails, in-app notifications. The true identity is stored but is exposed
   only through the audited admin **reveal** action (§9).
4. **Attachments are served only through the authenticated fetch gateway** — no
   direct object-store URLs — and become visible only after a clean ClamAV scan (§11).
   Attachment rows are permanent tombstones; the **sole** exception is the
   platform-admin delete cascade (§10.3), which removes them with their parent.
5. **`audit_log` is append-only.** App DB role lacks UPDATE/DELETE; a trigger enforces
   it too (§15).
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
  visibly moves. Two switches exist in v1: the topbar
  **theme** toggle (☀️/🌙 — its track stays `--surface-2` in both states, because the
  whole page already reports which theme is active) and the profile **e-mail
  notifications** switch (§13.5). A *preference* switch, whose state nothing else on the
  page reveals, additionally fills its track with `--accent` when on and carries a visible
  `On`/`Off` word to the left of the pill. **Travel direction is per-switch, not global:**
  the theme toggle slides right for dark (the knob follows the page getting darker), while
  the e-mail preference slides **left for on and right for off**, so its knob comes to rest
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
    (display name + initials avatar, with Profile / Quick start / What's new /
    Sign out) in the sidebar foot, and the topbar search + notification bell +
    theme toggle.
  - **Unauthenticated** — the wordmark and version colophon only, **no nav links**,
    and a primary **"Sign in with Entra ID"** button occupying the exact sidebar-foot
    slot the account menu uses when signed in; the topbar shows only the theme toggle
    (search and bell are hidden). The button starts Entra OIDC sign-in and honors a
    `callbackUrl` (default `/`). The accompanying main area is the §13.2 landing.
  - **Loading** — neutral (no nav, no foot control) until the session resolves, so
    the shell never flashes the wrong state.
  There is **no** separate Auth.js sign-in page: the "Sign in with Azure Active
  Directory" default page is removed in favor of this in-shell control (§5 of
  `ENTRA_AUTH_SPEC.md`).
- **Breadcrumbs:** a section's sub-pages render a breadcrumb back to the section root
  above the page title, via a shared component — currently the Administration
  console's sub-pages (§14). Shown only once the viewer passes the page's access gate.
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
  - **No org-specific fallbacks in code.** `PUBLIC_BASE_URL` falls back to
    `http://localhost:3000` (development) instead of a production host; `SMTP_FROM`
    has no baked-in address — when unset it falls back to `SMTP_USER`, and if both
    are unset the SMTP transport is treated as **not configured** (the Graph
    transport and the in-app inbox are unaffected); the SCIM
    `serviceProviderConfig.documentationUri` is derived from `PUBLIC_BASE_URL` and
    **omitted** when that is unset (it is optional in SCIM 2.0).
  - **Committed files carry placeholders, never real values** — `deploy/.env.example`,
    `docker-compose.yml`, the `Caddyfile`, the `Jenkinsfile`, `README.md`, and the
    specs use `https://innobox.example.com`, `innobox@example.com`, and
    `<your-git-host>` in prose, examples, and comments. Test fixtures use
    `@example.com` addresses.
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
  request. Mirrors the Jenkins CI stages below (install → build → typecheck → unit
  tests), which is what a reader of the public repository can actually see and what
  proves the tree is green. The **live-DB integration suite** runs on a `postgres:16`
  service container with the least-privilege app role created and all
  `db/migrations/*.sql` applied in order. `.gitlab-ci.yml` is removed — it mirrors
  stages nobody outside the organization can run and duplicates the Actions
  workflow.
- **CI (Jenkins declarative pipeline) — retained for deploy, and as the internal
  pre-deploy gate:** stages —
  **Toolchain** (asdf-provisioned Node 20 from `.tool-versions`, corepack-pinned
  pnpm) → **Install** (`pnpm install --frozen-lockfile`) → **Build** (recursive;
  `shared` builds first) → **Typecheck** (recursive) → **Unit tests** (recursive;
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
  pipeline goes green.
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
  reconciliation. Sign-out clears the InnoBox session only (no Entra logout).
  Sessions: rolling 7-day cookie; the user's `active` flag and roles are resolved
  from the DB on every request — the session token never carries roles.
- **Provisioning:** SCIM 2.0 (users + groups) served by the worker; Entra is the
  source of truth. Periodic reconciliation against Entra corrects drift. Deactivated
  users lose access immediately at session validation. **SCIM DELETE deactivates**
  (idempotent) — it never triggers the GDPR scrub, which stays a deliberate, audited
  platform-admin action.
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
  A scrubbed user therefore never appears in the Currently online panel.

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
  an anonymous author's id in the first place, invariant 3).
- **Deactivation:** when a user deactivates (SCIM or reconciliation), the cached
  photo bytes + etag are cleared; the user renders as a greyed initials bubble
  thereafter (§13.6).

---

## §4 Namespaces, roles & permissions

### §4.1 Namespaces

- A **namespace** represents a business unit / organizational scope. Platform admins
  create, rename, and archive namespaces (archive blocks new submissions; existing
  content remains readable per its visibility).
- A built-in **`global`** namespace always exists; **every authenticated user is an
  implicit member** of `global`.
- Namespace membership and roles come from Entra groups mapped in `role_mappings`
  (group → `{namespace, role}`), synced via SCIM (invariant 1).

### §4.2 Roles

| Role | Scope | Powers |
|---|---|---|
| **Platform Admin** | global | Everything below in every namespace + platform settings (§14.3), namespace CRUD, role mappings, impact-area management |
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
    the namespace's admins, and platform admins.
  - Solutions in `proposed` status: visible only to their author, the challenge's
    assignee, and the namespace's committee/admins (mirrors the legacy behavior of
    hiding un-reviewed solutions).
  - `rejected` / `not_selected` solutions: shown in a collapsed "closed solutions"
    section of the challenge page to anyone who can see the challenge; excluded from
    solution counts and galleries.
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
- **`users`** — id, entra object id, email, display name, department, job title,
  **office_location** (nullable text — the directory profile's third field, mirroring
  the Entra `officeLocation` attribute; §3, §13.8),
  photo (cached 240×240 bytes) + photo_etag (§3.1), email_notifications_enabled
  (default true), triage_seen_at (nullable; last time the user opened the triage
  queue — drives the §14.4 attention badge),
  **last_seen_at** (nullable timestamptz; last user-initiated request, throttled to one
  write per 60 s — §14.5), **last_route** (nullable text; the route category/entity the
  user was last on, masked per §14.5 — current value only, never a history),
  deactivated_at.
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
  drives the §14.4 attention badge), created_at, updated_at, edited_at, resolved_at.
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
  infected), scanned_at, uploaded_by, created_at. Rows are retained as tombstones
  (§11) and hard-deleted only inside the §10.3 cascade.
- **`attachment_uploads`** — transient chunked-upload sessions (initiate → complete),
  §11: id, attachment_id, parent (nullable) / draft_key, filename, mime,
  declared_size_bytes, object_key, s3_upload_id, chunk_size_bytes, uploaded_by,
  created_at. Deletable working state (unlike `attachments`).
- **`notifications`** — id, user_id, type, payload (jsonb), read_at, created_at
  (in-app inbox, §12.2); plus an **outbox** table driving e-mail dispatch from the
  worker. Rows targeting a challenge/solution are deleted with it (§10.3), so no
  inbox item ever points at a vanished entity.
- **`user_activity_days`** — (user_id, day) unique; the transient per-person day set
  that makes "distinct users per day" computable (§14.5). **Deleted by the worker once
  older than 3 days** — long-lived presence history is aggregate-only.
- **`presence_daily`** — (day) unique, active_users int; the rolled-up daily
  distinct-active-user count behind the §14.5 chart. Carries **no user ids** and is
  retained indefinitely.
- **`settings`** — key/value platform configuration (§14.3).
- **`audit_log`** — append-only (§15).

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
impact = Client), namespace (memberships; default `global`), visibility (default
`org`), attachments (**staged inline via a `draftKey`**, §11), **"Submit
anonymously"** checkbox (§9).

On submit: challenge created with status **`awaiting_triage`**, number allocated, any
files staged during the form **bound** to it in the same transaction (§11) — the create
is **rejected while any staged file is still scanning or infected** when a scanner is
available (§11 *Binding at submit* scan gate) — author auto-follows it (§12.3),
notifications fire (§12.1 event 1), audit entry.

### §6.2 Solution proposal (any user who can see the challenge)

Allowed **only while the challenge status is `valid`** (the UI hides/disables the
action otherwise; the API enforces it).

Form: description, cost vs benefits (optional), attachments (**staged inline via a
`draftKey`**, §11), "Submit anonymously".

On submit: solution created with status **`proposed`**, number allocated, any files
staged during the form **bound** to it in the same transaction (§11) — the create is
**rejected while any staged file is still scanning or infected** when a scanner is
available (§11 *Binding at submit* scan gate) — author auto-follows it, notifications
fire (§12.1 event 2), audit entry.

There is no draft state for the solution itself; cancel discards (any files staged
via §11 are left to the 24-hour GC). Editing after submission: §10.1.

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
platform admin as actor.

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

A namespace admin assigns any user as the challenge's **assignee** (searchable
directory of active users). Assignment/unassignment is audited and notifies the
assignee (§12.1 event 7 — fixing the legacy bug where the notification went to the
assigning admin with a `[TEST]` subject). Assignment is possible from
`awaiting_triage` onward and is blocked on terminal statuses. The assignee gains the
per-challenge powers in §4.2.

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
  4. notifications fire (§12.1 event 8) and every change is audited.
- A `solved` challenge accepts no new solutions, likes are frozen (existing counts
  remain displayed), and comments stay open.
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
  search result, leaderboard, KPI, CSV export, e-mail, and in-app notification shows
  **"Anonymous"** with a neutral avatar — for all users **including admins and
  committee**. The neutral avatar is a **generic anonymous bubble** (§13.6): no
  photo, no initials, no per-user color — any of those would fingerprint the author.
- **Reveal:** namespace admins (own namespace) and platform admins can execute a
  per-item **"Reveal author"** action. The reveal is **transient** (shown in the UI
  for that admin, not persisted as unmasked) and **every execution is audited**
  (who revealed whom, on which item, when). The reveal surface shows the author's
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
**reveal** (transient, reveal-to-you-only) and author **self-reveal** (one-way) are
implemented on the challenge detail page.

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
  Author-only; refused from any other status. Audited as a `status_changed` row with
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
`notification_outbox` row targeting any of them. Deleting a **solution** removes the
same subtree rooted at that solution and leaves the parent challenge standing. Any
in-flight chunked-upload session (`attachment_uploads`, §11) for the deleted subtree is
aborted and dropped. The transaction is all-or-nothing: a failure anywhere leaves the
item exactly as it was.

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
author, not to the assignee, not to followers, not to other admins (§12.1). The audit
row is the only record. Inbox items for the deleted subtree are removed by the cascade,
so no notification survives pointing at a dead entity.

**Derived state.** Because the rows are gone, the item disappears everywhere by
construction: lists, search vectors, solution and like counts, KPIs, dashboard
spotlights, the triage queue and its attention badge (§14.4), CSV exports.
**Leaderboards recompute without it** — deleting an implemented solution retroactively
removes its author's credit and can change historical ranks (§13.3). That is accepted.

**Audit.** The delete writes `challenge.deleted` / `solution.deleted` carrying: the
number, entity type, author id, status at deletion, namespace, the per-type counts of
cascaded child rows, and the **mandatory reason** the admin supplied (free text,
required, ≤ 500 chars). It carries **no content** — no title, no description, no client
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
cannot be used as an existence oracle (invariant 2). Anonymity is unaffected: the audit
row records the real author of an anonymous item (audit legitimately retains PII, §15)
while no listing or admin screen surfaces that identity outside the audited reveal path
(invariant 3).

**Database.** A migration grants the app role **DELETE** on `challenges`, `solutions`,
`comments`, `attachments`, `notifications`, and `notification_outbox` (`likes` and
`follows` already have it; `audit_log` never will). Those grants exist to serve this
cascade and nothing else — **no other code path may hard-delete these rows**, and the
soft-delete rules of §10.2 and §11 remain in force everywhere else.

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
  scripts — is refused outright.
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
  (blocked, uploader notified, audited).
- **Submission blocks on the scan when a scanner is available:** a challenge or
  solution cannot be submitted while any of its files is `pending` or `infected` —
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
  (`pending`|`clean`|`infected`, default `pending`), `scanned_at`, `removed_at`,
  `uploaded_by`, `created_at`. Indexes on `(parent_type, parent_id)` and
  `(scan_status)`; the app DB role gets INSERT/SELECT/UPDATE (no DELETE — infected and
  author-removed rows stay as tombstones; the MinIO object is purged in both cases).
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
  `awaiting_triage`/`needs_improvement`, solution `proposed`/`needs_improvement`). Either
  path enforces the §14.3 limits (reject over-count 409, over-size 413) and validates the
  type against an **allowlist** — the file's extension **and** its declared MIME must
  both be in the set, else 415:
  - **Documents** — `.pdf`, `.doc`/`.docx`, `.xls`/`.xlsx`, `.ppt`/`.pptx`,
    `.odt`/`.ods`/`.odp`, `.rtf`
  - **Text** — `.txt`, `.csv`, `.md`
  - **Images** — `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp` (SVG is excluded — it can
    carry script)
  - **Archives** — `.zip` (ClamAV recurses into it during the scan)

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
    session row, and returns `{ uploadId, chunkSize }`. Before opening the new session it
    **aborts the caller's own stale sessions** (see *Upload-session GC*).
  - **Send parts** — `PUT /api/attachments/uploads/:uploadId/parts/:n` streams one chunk;
    the server relays it to MinIO `UploadPart` (part `n`). Every non-final part is exactly
    `chunkSizeMb` (≥ 5 MB — the S3 multipart part floor, which is why the setting's minimum
    is 5 MB); the final part may be smaller. Only the session's `uploaded_by` may send parts.
  - **Complete** — `POST /api/attachments/uploads/:uploadId/complete` runs
    `CompleteMultipartUpload`, inserts the `pending` `attachments` row (bound or staged,
    exactly as single-shot), deletes the session row, audits `attachment.uploaded`, runs the
    **on-demand scan**, and returns the `AttachmentView`.
  - **Failure** — a failed part is retried; if the file is abandoned, an **abort**
    (`POST …/abort`, or the GC) runs `AbortMultipartUpload`, frees the orphaned MinIO parts,
    drops the session row, and audits `attachment.upload_aborted`. No partial object is ever
    exposed (no `attachments` row exists until complete).
- **Binding at submit** — `POST /api/challenges` and the solution-create endpoint accept
  an optional `draftKey`. Inside the create transaction the server takes the caller's
  staged rows for that key (`uploaded_by = caller`, `parent_id is null`, `removed_at is
  null`, matching `parent_type`), re-checks the §14.3 cap, sets `parent_id = <new id>`,
  clears `draft_key`, and audits `attachment.bound` per row; `object_key` is left as-is
  (no MinIO move). **Scan gate:** when a scanner is available the create is **rejected**
  (409 `attachments_not_clean`) if any staged row for that key is still `pending` or
  `infected` — the author must let the (on-demand) scan finish or remove the file, so a
  submitted item is only ever born with `clean` attachments. When ClamAV is unavailable
  (the health probe fails) the gate is **skipped** and `pending` rows bind as before,
  scanning later. A caller can only bind rows they uploaded, so a foreign `draftKey`
  binds nothing. Anonymity is unaffected:
  `uploaded_by` is retained but never sent to the client (invariant 3).
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
  applies the verdict + `scanned_at`. **Infected** → the object is deleted from MinIO (the
  row stays as an `infected` tombstone), the uploader is notified (§12.1 event 11), and
  `attachment.scan_infected` is audited; **clean** → `attachment.scan_clean` audited.
  Transient scan errors leave the row `pending` for the next sweep. Removed rows (staged or
  bound) are excluded from scanning. The verdict handler is **shared** with the on-demand
  path, so behaviour is identical whichever fires first (and the sweep is idempotent for a
  row the web tier already resolved).
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
  Author-**removed** rows (`removed_at` set) are never listed to anyone. `pending` and
  `infected` rows are listed **only to the uploader** (as "scanning…" / "removed —
  failed scan"); `clean` rows are listed to anyone who can see the parent. The list
  never exposes the uploader's identity, preserving anonymity (invariant 3) — the
  per-status affordance is decided server-side by comparing the viewer to
  `uploaded_by`, which is never sent to the client. Bytes are never served for
  `pending`/`infected`/removed rows.
- **Download gateway** (invariant 4) — `GET /api/attachments/:id`: auth-required,
  re-checks parent visibility, and streams the object **only when `scan_status=clean`
  and `removed_at is null`** (Content-Disposition: attachment). Any denial (not
  visible / not clean / removed) returns the same 404 and is audited
  `attachment.download_denied`. No presigned/direct MinIO URLs are ever emitted.
- **UI** — one upload control is used identically on **all three surfaces**: the §6.1
  challenge form, the §6.2 solution form, and the §13.1 detail-page author-edit section.
  Each file moves through **two visually distinct phases**: **Uploading** — a **progress
  bar** (bytes sent / total) for a chunked file, or a **spinner** for a single-shot file
  ≤ the chunk size — then **Scanning…** — an indeterminate indicator until the verdict —
  then **Ready** (clean) or **Failed scan** (infected, removable). A file may be removed
  at any phase. On the two **submission forms** (backed by a per-form `draftKey`) the
  **Submit button is disabled while any file is Uploading, Scanning…, or Failed**
  whenever scanning is enforced (`scanAvailable`); when a scanner is unavailable the gate
  lifts and still-`pending` files may be submitted. The detail-page control has no submit
  to block — a bound file simply isn't downloadable until `clean` (unchanged gateway
  rule). Abandoned staged files are GC'd after 24 h; abandoned chunk sessions after 2 h.
  The §12.1 matrix keeps **event 11 — Attachment failed its scan → the uploader**.

---

## §12 Notifications & follows

### §12.1 Event matrix

Every event produces **an e-mail and an in-app inbox item**, both fed from the same
outbox table and dispatched by the worker (at-least-once, retry with backoff).
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
fallback. All mails render inside one branded HTML wrapper template; the per-user
e-mail opt-out (§13.5) is honored at dispatch (in-app items are always delivered):

| # | Event | Recipients |
|---|---|---|
| 1 | Challenge submitted | Namespace admins of the target namespace |
| 2 | Solution proposed | Namespace admins + committee, challenge author, challenge followers |
| 3 | Status changed (challenge or solution) | Item author, assignee, followers |
| 4 | Rejected | Item author (distinct template) |
| 5 | Needs improvement | Item author (call-to-action: edit & resubmit) |
| 6 | Comment posted | Item author, other commenters on the item, followers — **never the commenter** |
| 7 | Challenge assigned / unassigned | The assignee |
| 8 | Solution implemented (auto-close) | Challenge author, authors of `not_selected` siblings, followers of the challenge and its solutions |
| 9 | Resubmitted (`needs_improvement` → `in_review` by the author, §10.1) | Namespace admins + committee, the assignee, followers |
| 10 | Withdrawn (by the author, §10.1) | Namespace + platform admins, the assignee, and existing followers — delivered directly (a withdrawn item is hidden per §4.3, but admins retain access and the assignee/followers already had it) |
| 11 | Attachment failed its scan (§11) | The uploader |

Rules: recipients are deduplicated per event; actors never notify themselves;
recipients outside the item's visibility are dropped (invariant 2); anonymity-safe
rendering (§9). Deep links point to the canonical routes under `PUBLIC_BASE_URL`
(`<PUBLIC_BASE_URL>/challenges/:number`, `…/solutions/:number`).
Delivery is immediate (no digest in v1).

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

### §12.2 In-app inbox

Bell icon with unread count; inbox lists notifications newest-first with read/unread
state, mark-read and mark-all-read. In-app notifications are always on; the per-user
opt-out (§13.5 profile) affects e-mail only.

### §12.3 Follows

Any user may follow/unfollow any challenge or solution they can see. Authors and
assignees are auto-followed to their items (can unfollow). Followers receive events
3, 6, 8 (and 2 for challenge followers).

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
- Strictly visibility-filtered, including counts (invariant 2, §4.3).

**Detail page (`/challenges/:number`):**
- Full fields: number, title, description, impact area, client name (if
  applicable), namespace, visibility, author (masked/anonymous per §9), status,
  assignee (if any), created/updated/edited dates.
- Like button (toggle) with live count.
- The challenge's solutions, listed inline, honoring §4.3's solution-visibility rule
  (a `proposed` solution is hidden except to its author, the challenge's assignee,
  and the namespace's committee/admins). Each solution shows its own like button.
- **Propose a solution** (§6.2): visible to anyone who can see the challenge,
  enabled only while status = `valid`; opens the solution form (description, cost
  vs benefits, "Submit anonymously"). No standalone `/solutions/:number` page —
  the §12.1 deep-link convention resolves to the parent challenge page, scrolled to
  the solution.
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
- **KPI tiles** (visibility-filtered, correctly labeled — the legacy app's
  swapped/mislabeled counters are not reproduced): challenges by status
  (in review / valid / solved / rejected) and solutions by status
  (in review / valid / in implementation / implemented).
- **Spotlight cards:** most recently `implemented` solution; most recent
  `in_implementation` solution.
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

### §13.3 Leaderboard

A dedicated **`/leaderboard`** page (own app-shell nav
item). **Top 10**, two windows — **last 30 days** and **all time** — across four
metrics: **solutions implemented (default)**, challenges submitted, solutions
proposed, likes received. Ranked by count descending (ties by earliest achiever).
Computed over org-visible, non-anonymous, non-rejected contributions (§4.3, §9).

### §13.4 Search

Postgres `tsvector` full-text search over challenge
title/description/client name and solution description/cost-vs-benefits, plus exact
lookup by number (`CH-123`, `SOL-456`). Strictly visibility-filtered including
autocomplete and result counts (invariant 2). §13.1's gallery filters
(status/impact area/namespace/author) narrow the list alongside it.

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

### §13.5 Profile

Own profile shows: identity (from Entra — display name, e-mail, department, job
title, **office location**); **my challenges by
status** (incl. awaiting triage); **my solutions by status**; **likes received**;
items I follow; latest activity (newest first, any status — fixing the legacy
"oldest in-review only" bug); notification preference (the e-mail opt-out
**switch**, below).
Other users' profiles show display name, department, job title, **office location**,
photo, and their **non-anonymous** org-visible contributions.

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
  §3.1).
- **Sizing:** one stored image (§3.1), scaled by context — small (~24–40 px) in
  lists, chips, comments and rows — the **directory hover card (§13.8)** reuses the
  existing **medium** bubble of that band; large (~96 px) on profile pages and the
  reveal dialog. Bubbles are circular, with initials sized proportionally.
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
illustrated with a real screenshot of the current UI. Always reachable afterward
via the account menu (§2.2), positioned above **What's new**.

- **Auto-open on first sign-in:** `users` (§3) gains a nullable
  `quick_start_seen_at timestamptz` column. The migration backfills it to the
  migration's run time for all existing rows, so only users who sign in for the
  **first time after this ships** are treated as unseen — current users are not
  surprised by a redirect they never asked for. While the signed-in user's
  `quick_start_seen_at IS NULL`, the app shell redirects any authenticated route to
  `/quick-start` before rendering it — taking priority over a deep-link
  `callbackUrl`. A **"Continue to InnoBox"** action on the page sets
  `quick_start_seen_at = now()` (via the `me` resource, §16) and navigates to `/`
  (Home dashboard, §13.2); the redirect never fires again for that user afterward.
- **Manual re-access:** the account-menu link navigates to `/quick-start` as an
  ordinary page — no redirect logic, and visiting it this way never touches
  `quick_start_seen_at` (already set).
- **No visibility/anonymity surface:** the page shows no challenge/solution/user
  data, only static instructional content and screenshots, so §2.1 invariants 2–3
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
  - the **reveal dialog** (§9) — the dialog already names the revealed person, so the
    card adds nothing to the one surface where anonymity is deliberately lifted, and
    the reveal flow stays untouched.
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
5. **"View profile"** — a link to `/profile/<id>` (to `/profile` for your own bubble).

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
- **Animation** reuses the app's shared popover treatment (§2.2): a short fade-and-rise
  on open and an instant close — the same as every other popover in the app — and
  nothing at all under `prefers-reduced-motion: reduce`.

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
  Tab moves from the bubble into the card, then out and on through the page.

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
admins land here (platform-admin-only cards — settings, audit — are hidden from
namespace admins, §4). Its sub-pages — the triage queue (§14.1), platform settings
(§14.3), and the audit browser (§15) — each render a **breadcrumb** above the page
title, via a shared component: **Administration** (a link back to `/admin`) › *current
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
bulk status set (admin override semantics, each item audited individually). Permanent
delete (§10.3) is deliberately **not** a bulk action — it is one item at a time, from
the detail page. **CSV
export** of the current filtered view — identities of anonymous authors are masked in
the export; every export is audited (who, filter, row count).

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
export remain challenge-only in v1.

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

---

## §15 Audit

Append-only `audit_log` (invariant 5): actor, action, entity, timestamp, structured
payload. Audited events at minimum: challenge/solution created, edited (diff),
withdrawn, **deleted** (the platform-admin hard delete, §10.3 — metadata, cascade
counts and the mandatory reason only, never content); every status transition
(enforced vs override, from → to); assignment
changes; visibility changes; anonymity reveals (admin and self); comment posted,
edited, deleted (incl. moderator deletes); like/unlike; attachment uploaded, bound
(staged → parent), draft-expired and **chunk-upload-aborted** (§11), scan verdict, download denials; CSV exports; settings, namespace,
impact-area create/rename/retire/delete (a delete carries `before: { name, active }` plus any reassignment target and
per-challenge diffs), and role-mapping changes; **`presence.view`** — a platform admin
loading the Currently online panel, with the selected window (§14.5; the one audited
*read* in the app, and deliberately so); SCIM sync anomalies. Platform admins get a read-only,
filterable audit browser; a target that no longer resolves (a deleted challenge or
solution, §10.3) renders as plain text rather than a link. Audit retains actor PII
for provenance and is exempt from GDPR erasure (§3).

---

## §16 API surface (contract level)

REST under `/api`, session-authenticated, JSON, UTC ISO timestamps. Resource groups:

- `challenges` (list/search/detail/create/edit/withdraw/transition/assign/visibility/
  **delete**)
- `challenges/:id/solutions`, `solutions` (detail/create/edit/withdraw/transition/
  **delete**) — `DELETE` on either is the platform-admin hard delete (§10.3): reason
  required in the body, cascading, irreversible, **404 (not 403)** to anyone else
- `comments`, `likes`, `follows` (create/delete on either parent type)
- `attachments` (single-shot upload — bound or **staged via `draftKey`**; **chunked upload** via `attachments/uploads` — initiate → parts → complete/abort — for files over the chunk size; list own staged by `draftKey`; gateway download; `challenges`/`solutions` create accept a `draftKey` to bind staged files, **gated on a clean scan when a scanner is available**)
- `notifications` (inbox, mark read), `me` (profile, preferences)
- `users/:id/photo` (authenticated avatar image gateway, §3.1),
  `users/:id/card` (directory hover card — any authenticated user; 404 on unknown or
  malformed id, §13.8)
- `leaderboards`, `dashboard` (KPIs, spotlights)
- `admin/*` (queue incl. proposed-solutions tab, bulk, export, settings, namespaces, role-mappings, audit; **triage attention count + mark-seen**, §14.4;
  **`admin/presence?window=5m|1h|8h|24h|30d` → `{ asOf, dau, wau, mau, total, users[] }`
  and `admin/presence/history?range=7d|30d|90d|all` → `{ points[] }`** — platform admin
  only (**403** for namespace admins), anonymity-masked locations, §14.5)

Exact shapes are defined during implementation and documented alongside the code;
any change to a shipped shape is a spec change first (§17). Responses apply
visibility and anonymity masking server-side without exception (invariants 2–3).

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
comment threading; no digest e-mails; no undelete, trash, or restore for a deleted
challenge or solution (§10.3 is permanent by design); no i18n;
no Kubernetes/Helm, HA, or SAML; no mobile app.

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
(§21.2); the versioning note (§21.1); and a plain **support statement** — the software
is provided as-is, issues are read but no response time is promised, and pull requests
are closed. It contains **no host, no mailbox, and no deployment-specific value**
(§2.3).

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
