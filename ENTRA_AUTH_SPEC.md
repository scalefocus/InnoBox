# Entra ID integration spec — InnoBox (Phase 1: identity)

Status: **DRAFT (pending approval)**
Layers in scope: **authentication + provisioning + authorization** (OIDC sign-in, SCIM provisioning, group-based RBAC)
Parent spec: `INNOBOX_SPEC.md` §3–§4 (this document details them; on conflict the parent wins
and must be amended in the same change).

## 1. Current state

Greenfield. Phase 0 shipped: Next.js 16 App Router (standalone) web app with the brand shell,
Express worker with a health surface, Postgres 16 with plain-SQL migrations
(`0001` least-privilege `innobox_app` role, `0002` append-only `audit_log` + `appendAudit`),
pnpm monorepo, compose deployment behind Caddy (`/scim/*` → worker:4000, rest → web:3000),
secrets via `deploy/.env` (Jenkins credentials vault in production). `next-auth` (Auth.js)
`^4.24` is already a web dependency. There is **no authentication today** — every route is
open; no user table exists. No local accounts will ever exist (INNOBOX_SPEC.md §3).

## 2. Decisions (policy interview, 2026-07-08)

| Question | Decision |
|---|---|
| Tenancy | Single-tenant: the deploying organization's tenant (`ENTRA_TENANT_ID`) |
| Sign-in gating | **Any tenant member** may sign in ("Assignment required" stays No); the app gates capabilities via roles |
| Existing-account linking / local passwords | n/a — greenfield, no local accounts ever |
| JIT sign-in before provisioning | **Allowed**: first sign-in creates a stub user from token claims, keyed on `oid`; SCIM/reconciliation completes and thereafter owns profile attributes |
| Leaver (deactivation) semantics | `active=false` + `deactivated_at`; sign-in refused; live sessions lose access at the next request (per-request `active` check at session validation). Content, likes, follows, assignments stay intact; a deactivated assignee is reassigned manually by a namespace admin. Reactivation restores access with data intact |
| Erasure (SCIM DELETE) semantics | **Deactivate only** (idempotent). The GDPR "Delete user info" scrub (§3 of the parent spec: PII scrub + "Deleted User" de-identification, `audit_log` exempt) remains a deliberate, audited platform-admin action (UI in Phase 4) |
| Groups synced | Only groups **assigned to the provisioning enterprise app** ("Sync only assigned"), plus reconciliation always syncs membership of every group referenced by `role_mappings` and the bootstrap group |
| Role vocabulary | `platform_admin` (scope: platform), `namespace_admin`, `committee`, `member` (per-namespace). `member` grants namespace membership only — visibility + submission targeting (§4.3). **Assignee is per-challenge (`challenges.assignee_id`), never group-based.** Baseline: every active authenticated user is an implicit `member` of the built-in `global` namespace |
| Mapping management | Platform admins only, every change audited. Phase 1 ships a minimal `/admin` surface (namespaces CRUD-lite + role mappings list/add/remove, dead-mapping flag); the full §14.3 settings page is Phase 4 polish |
| Bootstrap admins | `INNOBOX_BOOTSTRAP_ADMIN_GROUP` (Entra group object id, already in `.env.example`): while set, treated as an implicit `(group → platform_admin)` mapping. Its membership is synced by reconciliation from worker boot, so bootstrap works before any SCIM assignment |
| Role staleness | **Per-request resolution** (one indexed join); `users.active` checked on every request at session validation. No role cache in v1 |
| Session | Auth.js JWT cookie session (`HttpOnly`, `Secure`, `SameSite=Lax`), rolling, **7-day** max age. The JWT carries `oid` + display basics only — **never roles** |
| Sign-out | Local only (destroy the InnoBox session); no Entra front-channel logout |
| Rollout | Greenfield hard cutover: once Phase 1 deploys, all routes require sign-in. Local dev/e2e use the `INNOBOX_DEV_AUTH` bypass (never set in production — §2.3 release checklist) |

## 3. Entra configuration (operator runbook)

### 3.1 App registration "InnoBox" — OIDC + SCIM (main app)

One app registration **"InnoBox"** (single tenant), owned by the platform team:

1. **Redirect URIs** (type Web): `<PUBLIC_BASE_URL>/api/auth/callback/azure-ad`
   (e.g. `https://innobox.example.com/api/auth/callback/azure-ad`),
   plus `http://localhost:3000/api/auth/callback/azure-ad` for dev.
2. **Client secret**: max lifetime 24 months; rotation owner: platform team; lives in the
   Jenkins vault / `deploy/.env` (`ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_TENANT_ID`).
3. **Token configuration**: add the optional `email` claim to the ID token.
   **Do not add the `groups` claim** — roles never come from claims (§6).
4. **API permissions (application, admin-consented)** for worker reconciliation:
   `User.Read.All` + `GroupMember.Read.All` (client-credentials flow).
   **No `Mail.Send` permission here** — email uses a separate app registration (§3.2).
5. **Enterprise application → Provisioning (Automatic)**:
   Tenant URL `<PUBLIC_BASE_URL>/scim/v2`, Secret Token = `SCIM_BEARER_TOKEN`
   (≥ 32 random bytes; generated by ops, stored in the vault, never logged).
   Attribute mappings: `objectId → externalId`, `userPrincipalName → userName`,
   `displayName → displayName`, `mail → emails[type eq "work"].value`, `jobTitle → title`,
   `department → urn:…:enterprise:2.0:User:department`; trim the rest.
   **No office-location mapping** — SCIM carries no such attribute and must never write
   `users.office_location`; reconciliation owns that field (INNOBOX_SPEC.md §3, §13.8),
   so this change requires **no provisioning-mapping edit in the tenant**.
   **Users and groups** blade: assign the groups to provision; scope = "Sync only assigned".
   Test Connection → Provision on demand (pilot users) → Provisioning On.
6. "Assignment required" on the enterprise app stays **No** (open tenant sign-in).

### 3.2 App registration "InnoBox Email" — delegated mail send (email-only app)

A second, separate app registration **"InnoBox Email"** (single tenant) used exclusively
for the §12.1 notification email transport:

1. **Redirect URIs** (type Web): `<PUBLIC_BASE_URL>/api/admin/email/callback`,
   plus `http://localhost:3000/api/admin/email/callback` for dev.
2. **Client secret**: max lifetime 24 months; stored in the vault / `deploy/.env` as
   `ENTRA_EMAIL_CLIENT_ID` and `ENTRA_EMAIL_CLIENT_SECRET`. `ENTRA_TENANT_ID` is shared
   with the main app (same tenant).
3. **API permissions (delegated, admin-consented)**: `Mail.Send` + `offline_access` only.
   No application permissions, no `User.Read.All`, no OIDC scopes beyond what the
   delegated flow requires.
4. **Enterprise application → "Assignment required" = Yes**. Assign **only** the service
   mailbox account (e.g. `innobox@example.com`) to this app. No other user can authenticate
   through it, ensuring `Mail.Send` cannot be exercised on behalf of regular users.
5. The platform admin connect flow (Administration page → "Set email service account")
   redirects to this app's authorize URL. The admin signs in as the service mailbox;
   the resulting tokens are stored encrypted in `email_service_account`.

## 4. Data model changes — migration `0003_identity.sql`

```sql
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE NOT NULL,          -- Entra object id == OIDC oid == SCIM externalId
  user_name     text NOT NULL,                 -- UPN as sent (compared case-insensitively)
  email         text,
  display_name  text NOT NULL DEFAULT '',
  department    text,
  job_title     text,
  office_location text,                        -- Entra officeLocation; directory profile (INNOBOX_SPEC.md §13.8)
  photo         bytea,                         -- 96px thumbnail via reconciliation (Graph)
  photo_etag    text,
  email_notifications_enabled boolean NOT NULL DEFAULT true,   -- §12 per-user e-mail opt-out
  active        boolean NOT NULL DEFAULT true,
  deactivated_at timestamptz,
  scim_synced   boolean NOT NULL DEFAULT false, -- false = JIT stub; true once SCIM/recon owns attributes
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_user_name_lower_idx ON users (lower(user_name));

CREATE TABLE IF NOT EXISTS groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE NOT NULL,          -- Entra group object id
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id);

CREATE TABLE IF NOT EXISTS namespaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  display_name  text NOT NULL,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO namespaces (slug, display_name) VALUES ('global', 'Global')
  ON CONFLICT (slug) DO NOTHING;                -- §4.1 built-in namespace

CREATE TABLE IF NOT EXISTS role_mappings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_external_id  text NOT NULL,             -- Entra group object id (never display name)
  role               text NOT NULL CHECK (role IN ('platform_admin','namespace_admin','committee','member')),
  namespace_id       uuid REFERENCES namespaces(id),
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_external_id, role, namespace_id),
  CHECK ((role = 'platform_admin') = (namespace_id IS NULL))
);
CREATE INDEX IF NOT EXISTS role_mappings_group_idx ON role_mappings (group_external_id);

-- audit_log grew up in 0002 promising this FK once users existed:
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_fk
  FOREIGN KEY (actor_user_id) REFERENCES users(id);  -- users are never hard-deleted

-- Least-privilege grants (no UPDATE where rows are immutable, no DELETE where soft):
GRANT SELECT, INSERT, UPDATE         ON users         TO innobox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON groups        TO innobox_app;  -- SCIM group DELETE is real
GRANT SELECT, INSERT,         DELETE ON group_members TO innobox_app;
GRANT SELECT, INSERT, UPDATE         ON namespaces    TO innobox_app;  -- archive, never drop
GRANT SELECT, INSERT,         DELETE ON role_mappings TO innobox_app;
```

(Wrapped `ALTER TABLE … ADD CONSTRAINT` in the idempotency idiom the migration runner
tolerates; exact file follows `db/migrations/README.md` rules.)

## 5. Endpoints and flows

### Layer 1 — OIDC sign-in (web)

- **Auth.js v4** route `packages/web/src/app/api/auth/[...nextauth]/route.ts`, AzureAD
  provider (`checks: ["pkce", "state", "nonce"]`), scopes `openid profile email`,
  JWT session strategy (rolling 7 days). Provider display `name: "Entra ID"` (so any
  provider-labeled text reads "Entra ID", never "Azure Active Directory"), and
  `pages: { signIn: "/" }` so there is **no** default Auth.js sign-in page — the Home
  landing is the sign-in surface (§5 sign-in UI, below).
- **Token validation** is delegated to the library and pinned by config: issuer
  `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`, audience = client id,
  RS256 via the tenant JWKS (rotation-safe), `nonce`/`state` enforced.
- **`signIn` callback**: look up `users` by `oid`.
  - Missing → JIT-insert a stub (`external_id=oid`, `user_name=preferred_username`,
    `email`, `display_name`, `scim_synced=false`), audited as `user.jit_created`.
  - Present + `active=false` → **reject** (sign-in error page: "account deactivated").
  - Present + JIT-stub (`scim_synced=false`) → refresh name/email from claims.
    Once `scim_synced=true`, SCIM/reconciliation own attributes; claims never overwrite.
- **Session validation** (every request): `src/lib/auth.ts` exposes `getSessionUser()` —
  reads the JWT cookie, loads the user row by `oid`, **rejects if missing or inactive**,
  resolves roles (layer 3), returns `{ user, roles }`. All API routes and pages call it;
  unauthenticated UI requests redirect to the Home landing `/` (original path preserved
  as a `callbackUrl` query param), API requests get 401.
- **Route protection**: `middleware.ts` gates **everything** except `/api/auth/*`,
  `/healthz`, `/readyz`, Next static assets, **and the Home landing `/`**. Making `/`
  public does not weaken invariant 2 — while unauthenticated it renders a static welcome
  and the sign-in control only, fetching no protected data (§13.2 of `INNOBOX_SPEC.md`).
  Every other route — `/challenges`, `/leaderboard`, `/admin`, `/whats-new`, all non-auth
  `/api/*` — stays behind sign-in.
- **Sign-in UI**: no default Auth.js page. The app shell renders the sign-in control
  in-place: when unauthenticated, the sidebar foot (the account-menu slot when signed in)
  shows a primary **"Sign in with Entra ID"** button that calls
  `signIn("azure-ad", { callbackUrl })`; the sidebar carries no nav links and the main
  area is the §13.2 welcome landing. A sign-in error returned on the URL (e.g.
  `?error=AccessDenied` for a deactivated account) is surfaced on that landing.
- **Sign-out**: Auth.js `signOut` clears the local session cookie only.
- **Dev bypass**: when `INNOBOX_DEV_AUTH=1`, a Credentials provider ("Dev sign-in": free-form
  display name + role preset) is registered and the Entra provider becomes optional; used by
  local dev and Playwright. Because there is no default Auth.js page, the dev form renders on
  the Home landing as a **dev-only panel** — shown only when the `dev` provider is configured
  (never in production); Playwright drives that panel instead of `/api/auth/signin`. The flag
  is refused at startup when `NODE_ENV=production` unless `INNOBOX_DEV_AUTH_I_KNOW=1` — and the
  deploy env review (§2.3) forbids it.

### Layer 2 — SCIM 2.0 server (worker, `/scim/v2`)

Express router on the existing worker (public via Caddy `/scim/*`). Follows the SCIM 2.0
provisioning contract, including the Entra dialect quirks:

- **Auth**: `Authorization: Bearer` compared to `SCIM_BEARER_TOKEN` in constant time
  (`crypto.timingSafeEqual`); failures → 401 SCIM error; the header/token is never logged.
- **Endpoints**: `/Users` GET(filter)+POST, `/Users/{id}` GET+PUT+PATCH+DELETE, `/Groups`
  GET(filter)+POST, `/Groups/{id}` GET+PUT+PATCH+DELETE, `/ServiceProviderConfig`,
  `/ResourceTypes`, `/Schemas` (static; `patch.supported=true`, `filter.supported=true`).
- **Filters**: `userName eq "…"` (case-insensitive compare), `externalId eq "…"`,
  `displayName eq "…"` (groups); anything else → 400 `invalidFilter`. List responses are
  RFC 7644 `ListResponse`, 1-based `startIndex`, empty = 200 + `totalResults: 0`.
- **Writes are idempotent upserts keyed on `externalId`** (fall back to `id`; neither → 400).
  Duplicate POST returns the existing resource logic per contract (409 on `userName`
  uniqueness conflicts). All SCIM writes set `scim_synced=true` and stamp `updated_at`.
- **PATCH quirks handled**: case-insensitive `op`; `active` deactivation in all three
  serializations (bool, string `"False"`, path-less `{value:{active:false}}`); unknown paths
  applied-if-stored else ignored with 204 (never fail the sync); group membership `Add`/
  `Remove` including the `members[value eq "…"]` filter-path form; unknown member ids
  ignored (reconciliation heals ordering races).
- **DELETE `/Users/{id}`** → deactivate (leaver semantics, §2), idempotent 204.
  **DELETE `/Groups/{id}`** → remove group + memberships; `role_mappings` rows survive and
  are flagged "dead" in the admin UI.
- **Audit**: `scim.user_created|updated|deactivated|reactivated|deleted_received`,
  `scim.group_created|renamed|deleted`, `scim.membership_changed`, and every anomaly
  (`scim.anomaly`) — actor `null` (system), per §15.

### Reconciliation (worker, leader-only)

- **Leadership**: Postgres advisory lock on a **dedicated long-lived connection** (not the
  pool — pooled sessions silently drop session locks); standbys retry periodically.
- **Cadence**: on worker boot, then hourly.
- **Pass**: with Graph client credentials —
  1. Every local `active` user → `GET /users/{oid}` (`accountEnabled`, profile fields):
     missing or disabled → deactivate (audited `recon.user_deactivated`); refresh
     `display_name/email/user_name/department/job_title/office_location`; fetch the 96px
     photo when the ETag changed. The three directory-profile fields
     (`department`/`job_title`/`office_location`, INNOBOX_SPEC.md §13.8) are refreshed
     **unconditionally** like every other attribute here — a Graph value that is absent
     or empty writes NULL, so clearing an attribute upstream clears it locally. All
     three ride the `$select` this pass already issues: **no extra request, no new
     permission** (default properties of the user resource, covered by application
     `User.Read.All`). Because this pass visits *every* local active user, a user who
     belongs to no role-mapped group still gets a current directory profile.
  2. Every synced group ∪ every group referenced by `role_mappings` ∪ the bootstrap group →
     `GET /groups/{id}/members` → replace local membership (creating JIT-grade stubs for
     unknown members); group gone in Entra → drop group + memberships (audited).
- Reconciliation is tenant-based (not app-assignment-based) because sign-in is open to the
  tenant: a JIT user who was never assigned to the provisioning app must not be "healed"
  into deactivation.

### Layer 3 — RBAC resolution

- Pure resolution function in `@innobox/shared` (unit-tested), one indexed join at the web tier:

  ```sql
  SELECT rm.role, rm.namespace_id
    FROM group_members gm
    JOIN groups g        ON g.id = gm.group_id
    JOIN role_mappings rm ON rm.group_external_id = g.external_id
   WHERE gm.user_id = $1
  ```

  unioned with: implicit `member` of `global` (every active user), and `platform_admin` when
  the user is in the local mirror of `INNOBOX_BOOTSTRAP_ADMIN_GROUP` (while the env is set).
  Inactive user ⇒ **zero roles** (enforced upstream: `getSessionUser()` already rejects).
- `RoleSet` helpers: `isPlatformAdmin`, `isNamespaceAdmin(ns)`, `isCommittee(ns)`,
  `isMemberOf(ns)`, `memberNamespaces()`. Enforcement is always server-side; the client gets
  role hints for UI only.
- **`/api/me`** becomes real: identity, roles, `email_notifications_enabled`, `dateFormat`
  (platform default until §14.3 settings land).
- **Minimal admin surface** (platform-admin-gated, every mutation audited):
  `GET|POST /api/admin/namespaces`, `PATCH /api/admin/namespaces/:id` (rename/archive),
  `GET|POST|DELETE /api/admin/role-mappings`; an `/admin` page listing namespaces and
  mappings (group display name from the synced store, dead-mapping flag). Sidebar shows
  "Administration" to platform admins only.
- Account menu shows the real signed-in user (name, initials avatar, Sign out).

## 6. Security invariants (restated for InnoBox)

1. Identity key = Entra `oid` ≡ SCIM `externalId` (`users.external_id`); never email/UPN.
2. **Roles never come from token claims** (Entra ~200-group claim overage; INNOBOX_SPEC.md
   invariant 1). The `groups` claim is not requested and is ignored if present.
3. Leaver ≠ erasure: PATCH/PUT `active:false` and SCIM DELETE deactivate; the GDPR scrub is
   a separate audited admin action; `audit_log` is exempt from erasure (invariant 5).
4. No credential logging (SCIM bearer, authorization headers, OIDC codes/tokens);
   constant-time secret compares.
5. SCIM writes are idempotent upserts; background loops run on exactly one leader via a
   session advisory lock on a dedicated connection.
6. All routes auth-required (invariant 2); `users.active` is checked on every request.

## 7. Migration & rollout plan

1. Land migration `0003_identity.sql` + shared RBAC + web auth + SCIM + reconciliation
   behind the normal release (single version bump; greenfield — no dual-auth window).
2. Operator (platform team): main app registration per §3.1 (redirect URIs, email claim,
   secret, Graph application permissions); email app registration per §3.2 ("Assignment
   required = Yes", service mailbox assigned, `Mail.Send` + `offline_access` delegated,
   admin-consented); set env (`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`,
   `ENTRA_EMAIL_CLIENT_ID`, `ENTRA_EMAIL_CLIENT_SECRET`, `SCIM_BEARER_TOKEN`,
   `INNOBOX_BOOTSTRAP_ADMIN_GROUP`) in the vault.
3. Deploy; verify sign-in + bootstrap admin (reconciliation syncs the bootstrap group on
   worker boot).
4. Configure Entra provisioning (Test Connection → on-demand pilot → On).
5. Platform admin creates namespaces + role mappings in `/admin`.
   Rollback story: redeploy the previous version (auth is additive; no data destroyed).

## 8. Test plan

- **Unit (shared/web/worker)**: role resolution (baseline, multi-namespace union, platform
  scope, inactive user, unmapped group, dead mapping, bootstrap group); SCIM filter parser;
  PATCH normalizer (case-insensitive ops, `"False"` string, path-less replace, member
  remove-by-filter); constant-time token compare; JIT-vs-SCIM attribute precedence.
- **Integration (gated `test:db`, live Postgres)**: SCIM endpoints driven by the literal
  Entra payload shapes from the provisioning contract above — create → duplicate POST (no dup) →
  PATCH deactivate variants → reactivate → group create/membership add+remove → user DELETE
  idempotency; grants/trigger still hold for audit writes.
- **E2E (dev-auth bypass)**: sign-in gate redirect, account menu, admin surface visibility.
- **Negative**: missing/wrong bearer → 401 SCIM error (and no token in logs); deactivated
  user with a live session cookie loses access on next request; wrong-tenant issuer refused
  (config-level unit test).
- Verification checklists of all three layers (authentication, provisioning, authorization), walked against the
  Entra portal (Test Connection, provision-on-demand, leaver, group→role, re-enable).

## 9. Out of scope / accepted gaps

Front-channel logout; multi-tenant sign-in; photos beyond the 96px thumbnail; SCIM bearer
dual-token rotation (pause-swap-resume documented instead); Prometheus `/metrics` (later
phase); SAML (§19). The §12 e-mail engine uses a separate app registration (§3.2) and is
not in scope for this identity spec beyond the runbook entry above.

## 10. Open questions

None.
