# InnoBox — OWASP Top 10 (2021) security review

Date: 2026-10-16 · Code reviewed: `main` at `d7bbd5b` (v1.13.0) · Method: static review of the
full codebase (web, worker, shared, migrations, deploy), no dynamic testing. Every finding below
was verified line-by-line against the source after the initial sweep.

## 1. Verdict

InnoBox is in good shape. The platform's own invariants (DB-resolved roles, one visibility
predicate with a SQL twin, total anonymity masking, gateway-only attachments, append-only audit)
are implemented consistently across ~130 API routes, the SCIM endpoint and the MCP agent surface.
Dependencies are clean (`pnpm audit --prod`: 0 vulnerabilities over 295 packages).

**No High findings. Two Medium, four Low**, all with a verified code path. The rest of this
document is category-by-category evidence plus a prioritised improvement list.

| # | Severity | Category | Finding | Where |
|---|---|---|---|---|
| F1 | Medium | A05 | MinIO admin console published on every interface in the deployed compose file | `deploy/docker-compose.yml:58` |
| F2 | Medium | A01 | Deactivated users keep receiving notification e-mails (immediate path lacks the `active` check the digest path has) | `packages/worker/src/notifications/dispatch.ts:192,211` |
| F3 | Low | A07 | SCIM full-resource POST/PUT treats a missing or string `active` as `true`, silently reactivating a leaver | `packages/worker/src/scim/resources.ts:114` |
| F4 | Low | A09 | Any user can append attacker-chosen text to the hash-chained audit log, unrate-limited | `packages/web/src/app/api/attachments/store.ts:520-523` |
| F5 | Low | A01 | The MCP `list_my_items` tool returns the caller's own trashed solutions | `packages/web/src/app/api/challenges/store.ts:1591-1597` |
| F6 | Low | A07 | Open dynamic client registration allows consent phishing with a look-alike client name (accepted by spec §25.3) | `packages/web/src/lib/mcp/oauth.ts:83-84` |

## 2. Findings in detail

### F1 · MinIO console exposed on all interfaces — Medium (A05 Security Misconfiguration)

`deploy/docker-compose.yml:58` maps `"9001:9001"` for the `minio` service with the comment
"console (dev only)", but this is the one compose file the Jenkins deploy stage runs
(`Jenkinsfile:440`). Postgres is correctly loopback-only (`127.0.0.1:5432:5432`, line 24); web and
worker are `expose`-only. The console accepts `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, and those
root credentials are also the app's S3 keys by default (lines 119-120, 189-190), with the user
name defaulting to the guessable `innobox`.

*Impact.* Anyone who can reach the deploy host on 9001 and guess or obtain the root password gets
direct read/write/delete on the attachment bucket, bypassing the authenticated download gateway
(invariant 4): unscanned `pending` objects, infected objects awaiting purge, namespace-restricted
attachments; objects can also be swapped after their clean verdict while the row stays `clean`.
A host firewall would mitigate it, but nothing in the repository guarantees one.

*Fix.* Remove the mapping from the production file (move it to a `docker-compose.dev.yml`
override) or bind it loopback-only (`"127.0.0.1:9001:9001"`). Separately, point
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` at a least-privilege MinIO user rather than root.
Infra-only change: no spec gate, no version bump.

### F2 · Leavers keep receiving notification e-mails — Medium (A01 Broken Access Control)

The immediate outbox sweep selects `u.email, u.email_notifications_enabled` and skips a row only
when `!row.email || !row.email_notifications_enabled`
(`packages/worker/src/notifications/dispatch.ts:192,211`). The digest path already checks
`!user.active` (`digest.ts:205`); the immediate path does not. Upstream, `finalRecipients`
(`packages/web/src/lib/notify.ts:225-241`) filters on dedup, actor, visibility and preference but
never on `active`; `getNamespaceAdminUserIds` / `getNamespaceCommitteeUserIds` (`notify.ts:104-147`)
omit the `users.active` join that `getPlatformAdminUserIds` has. SCIM deactivation sets
`active=false` but keeps `email` and `group_members` (`packages/worker/src/scim/router.ts:211-222`),
so `resolveRolesForUsers` (`lib/auth.ts:47-95`) still grants the leaver their namespace roles and
`canSeeChallenge` still passes.

*Impact.* After Entra disables an account, every follow/comment/status/new-solution event the person
was entitled to keeps producing an inbox row and an e-mail to their mailbox, including
namespace-restricted challenge numbers and titles and commenter names, indefinitely. Disabled
mailboxes are routinely delegated or converted to shared mailboxes during offboarding.
`ENTRA_AUTH_SPEC.md` defines leaver semantics as access lost at the next request; e-mail is the one
channel where it does not stop.

*Fix (three layers).* (1) `dispatch.ts`: add `u.active` to the select and `|| !row.active` to the
skip condition, marking the row skipped exactly as opt-out is. (2) `notify.ts finalRecipients`: drop
ids where `not active or scrubbed_at is not null` so no inbox/outbox rows are written for leavers.
(3) Add the `users.active and scrubbed_at is null` join to the two namespace-role helpers. Mirror
the digest dbtest for the immediate path. Behavior change: spec update first (§12 notifications,
leaver semantics), minor bump.

### F3 · SCIM full-resource writes default `active` to true — Low (A07)

`parseUserWrite` uses `typeof body?.active === "boolean" ? body.active : true`
(`packages/worker/src/scim/resources.ts:114`). PATCH already handles Entra's `"False"`/`"True"`
string quirk through `parseActiveValue` (`patch.ts:21-29`); the POST-on-existing-row and PUT paths
(`router.ts:523-527, 585-589` → `updateUserFull`) do not. A replayed POST or a PUT that omits
`active` or sends it as a string re-enables a deactivated leaver (sign-in works again until the
next sync). The audit row `scim.user_reactivated` makes it visible but not refused.

*Fix.* Use `parseActiveValue` in `parseUserWrite`; when the attribute is absent on an update of an
existing row, keep `existing.active`; default to `true` only on a brand-new insert. Minor bump,
spec note in `ENTRA_AUTH_SPEC.md` SCIM section.

### F4 · Audit-log pollution through the download gateway — Low (A09)

`getAttachmentForDownload` audits `attachment.download_denied` with the raw URL segment as
`targetId` even when it is not a UUID (`packages/web/src/app/api/attachments/store.ts:520-523`,
`auditDownloadDenied` at 120-127). `audit_log.target_id` is unbounded `text`
(`db/migrations/0002_audit_log.sql:14`), the GET route has no rate limit (unlike DELETE,
`[id]/route.ts:56`), and every insert serialises on the chain advisory lock
(`0028_audit_chain.sql:89`). Any signed-in user can loop `GET /api/attachments/<any string>` and
plant arbitrary text (up to ~2.7 KB per row) that the platform-admin audit browser and CSV export
render verbatim, drown real rows, and contend the lock against legitimate audit writes.

*Fix.* Audit the denial only for well-formed UUIDs (or record `targetId: null` with
`after: {reason: "malformed"}`), cap `target_id` length at the writer, and give the GET a token
bucket (a dedicated `download` bucket or the existing `mutation` one). Patch bump; spec §11/§15
note.

### F5 · `list_my_items` shows the author's own trashed solutions — Low (A01)

`listOwnSolutions` applies `pushChallengeVisibilityConditions` (parent `c.trashed_at is null`) but
never `s.trashed_at is null` (`packages/web/src/app/api/challenges/store.ts:1591-1597`); its only
caller is the MCP tool (`lib/mcp/tools.ts:395`). Every other agent read path goes through
`canSeeSolution`, which refuses trashed items for `viaAgent` viewers. The row leaks number,
pre-trash status, parent title and `canEdit`/`canResubmit` flags; follow-up tools correctly answer
"not found". Spec §10.4 ("an agent never sees an item in the trash") breach and a trash-existence
oracle, content is the author's own.

*Fix.* Add `s.trashed_at is null` to `conditions` (or call `pushSolutionVisibilityConditions`), plus
a dbtest: trash an own solution, assert `list_my_items` omits it. Patch bump.

### F6 · Consent phishing via open dynamic registration — Low (A07, design-accepted)

Anyone can register a client named e.g. "Claude Code" with an `https://attacker.example/cb`
redirect (`packages/web/src/lib/mcp/oauth.ts:83-84`, `redirect-uris.ts:239`), start a PKCE flow and
send a signed-in employee the `/oauth/authorize` link; approving hands the attacker a token acting
as that person for the refresh lifetime (90 days sliding by default). The consent page already
shows the return host (`consent-page.ts:424-426`), but as a secondary line. Spec §25.3 accepts open
registration, so this is a UI-strength item rather than a bug.

*Fix.* Make the redirect target the headline, distinguish "this computer (loopback)" from an
external host, label clients registered recently or never granted as "unverified", and consider
a platform-admin allow/block list of client names. Spec §25.3 update, minor bump.

## 3. Category-by-category

### A01 Broken Access Control — sound, with F2 and F5

Verified: everything outside an exact public-path allowlist requires a signature-verified JWT
(`middleware.ts:86-98`, `routeAccess.ts:20-44`); `getSessionUser` re-reads `users.active` per
request (`lib/auth.ts:121-165`); every by-number read and write runs the visibility gate first and
answers 404 before any 403 (`challenges/store.ts:367-380` and 15 call sites); the JS gate and its
SQL twin were compared arm by arm and agree (`shared/challenges.ts:197-247` vs
`challenges/store.ts:670-705`); lists, counts, search, similar, dashboard, leaderboards, inbox,
profile follow-lists and triage all use it. Object-level checks hold for comments (author +
15-minute window, moderator delete), notifications (`user_id` scoped), likes/follows (session user
only), upload sessions and drafts (`uploaded_by` scoped), agent grants (`user_id` scoped). All 48
platform-only admin routes call `requirePlatformAdmin` first; the 8 namespace-scoped triage routes
filter by `adminNamespaceIds` and bulk operations re-check role and visibility per item. Mass
assignment is closed: no body field can set `author_id`, `status`, `namespace`, `visibility='people'`,
`is_anonymous` on edit, or `featured`. State machines and the single-winner rule are enforced in
code and by a unique index.

### A02 Cryptographic Failures — sound

AES-256-GCM with a fresh 96-bit IV, pinned 128-bit tag and 32-byte key check for tokens, webhook
URLs and AI keys (`shared/email-crypto.ts:13-44`); PoW is HMAC-SHA-256 with `timingSafeEqual`;
confirm/OAuth/access/refresh tokens are 256-bit random and stored only as SHA-256; bearer
comparisons (SCIM, metrics, PKCE) are constant-time over fixed-length digests; no `Math.random`,
SHA-1 or static IVs in non-test code; the audit hash chain runs in a `BEFORE INSERT` trigger under
an advisory lock with caller values overwritten. Session cookies are HttpOnly, `SameSite=Lax`,
Secure under an https `PUBLIC_BASE_URL`.

### A03 Injection — sound

All SQL is parameterised; every interpolated fragment is a code-owned identifier (validated sort
keys, fixed column maps, `limit` constants or integer-clamped). The SCIM filter grammar is a strict
`attr eq "value"` regex whose value only ever becomes `$1`. No rich-text editor exists; the only
`dangerouslySetInnerHTML` is the nonce'd theme script. The OAuth consent/error pages escape every
interpolation. The admin e-mail wrapper goes through `sanitize-html` with an explicit allowlist on
save and on render; notification text is escaped and only same-origin URLs become anchors. E-mail
headers are base64/CRLF-neutralised on both transports. All three CSV exporters formula-neutralise
every cell. No `eval`, `new Function`, `vm` or `child_process` outside tests.

### A04 Insecure Design — sound

404-before-403 everywhere (no existence oracles), roles never from token claims, fail-loud startup
for every dev-only flag in production, attachment allowlist by extension AND MIME AND magic bytes
(SVG/HTML absent), clean-scan gate before serving, uninspectable archives treated as detections,
per-item caps atomic under advisory locks, tombstones instead of deletes.

### A05 Security Misconfiguration — F1

Otherwise strong: nonce + `strict-dynamic` CSP with no `unsafe-inline` for scripts, `object-src`
`base-uri` `frame-ancestors` locked, static headers on every response including `/_next/*`, HSTS
under https, containers run as `node`, `--frozen-lockfile`, no build-arg secrets, `/metrics` is 404
in production without a token, Caddy rewrites `X-Forwarded-For` from `trusted_proxies_strict`.

### A06 Vulnerable and Outdated Components — clean

`pnpm audit --prod --json`: 0 findings. next 16.3.8, next-auth 4.24.15, express 5.2.1,
sanitize-html 2.18.0, pg 8.23.1. `@modelcontextprotocol/sdk` is dev-only. Gap: `minio/minio:latest`
and `clamav/clamav:latest` are unpinned (A08 overlap).

### A07 Identification and Authentication Failures — F3, F6

Verified: dev credentials provider is structurally absent in production builds and the env flag
aborts startup; Entra provider pinned to the tenant with PKCE + state + nonce; multi-tenant ids
refused at startup; account relink only for never-used, SCIM-synced, active rows in one guarded
transaction; sign-out expires every cookie after Auth.js' own CSRF check; MCP OAuth is S256-only
PKCE, exact redirect-URI match, single-use 60 s codes bound to client + URI + resource + challenge,
refresh rotation with reuse detection that revokes the grant, deactivation revokes grants in the
same transaction.

### A08 Software and Data Integrity Failures — minor

Lockfile pinned, CI has `contents: read` and no secrets, migrations read-only mounted. Gaps: unpinned
MinIO/ClamAV image tags; `migrate.sh:48` tolerates "current transaction is aborted" as benign.

### A09 Security Logging and Monitoring Failures — F4

Verified: no tokens, bearers or keys reach logs; system-log rows carry one sanitised line and mask
anonymous paths; audit browser, export and verify are platform-admin only and exports are
themselves audited; the app role has only SELECT/INSERT on `audit_log` plus row- and
statement-level triggers. Gap: the SCIM 401 record includes an 8-hex fingerprint of the *configured*
token (`worker/src/system-log/record.ts:52-59`).

### A10 Server-Side Request Forgery — sound

Webhooks and the AI provider: https on 443 only, no userinfo, every A/AAAA answer must be public
(IPv4-mapped and NAT64 judged by the embedded address), connection pinned to the vetted address via
a custom `lookup` (no rebinding window), TLS verified, redirects never followed, proxy env ignored,
response size capped. The AI allowlist can never reach loopback/link-local/metadata. The Graph
OAuth callback validates `state` against an HttpOnly cookie and redirects only to a fixed path.

## 4. Prioritised improvements

Items marked **gate** change app behavior and must go spec-first per `CLAUDE.md`.

**Now (this week)**
1. F1 — bind or drop the MinIO console port; use a non-root S3 user. Infra only.
2. F2 — `active` check in `dispatch.ts`, `finalRecipients`, and the two namespace-role helpers. **gate**
3. F5 — `s.trashed_at is null` in `listOwnSolutions` + dbtest. **gate** (one-line spec note)
4. F4 — skip the audit row for non-UUID ids, cap `target_id`, rate-limit the download GET. **gate**

**Next**
5. F3 — `parseActiveValue` in the SCIM full-resource parser; keep stored `active` when absent. **gate**
6. F6 — consent page: redirect host as headline, "unverified client" label, optional admin allow-list. **gate**
7. Pin `minio` and `clamav` image tags or digests (`deploy/docker-compose.yml:49,66`).
8. Re-run `isOriginAllowed` inside the system-log wrapper so CSRF does not rest solely on the edge middleware (`lib/system-log-core.ts`).
9. Session revocation: a `session_version` column compared in `getSessionUser` so sign-out, role downgrades and admin-forced logout are global rather than waiting out the 7-day JWT (`authOptions.ts:104`).
10. Refuse scrubbing yourself or the last active platform admin (`api/admin/users/[userId]/scrub/route.ts:40`).

**Later / defence in depth**
11. MCP: store `resource` on refresh rows so the check at `lib/mcp/store.ts:294` is meaningful; revoke tokens on authorization-code reuse; delete a grant's old access tokens on refresh rotation.
12. SCIM: refuse `external_id` changes on rows with `last_seen_at` set, or require an explicit flag (`worker/src/scim/router.ts:166-187`); log only the sent token's fingerprint on 401, not the configured one; add a JSON 404 tail to the router.
13. Escape `%`/`_` in the author and user-directory `ILIKE` filters (`challenges/store.ts:874`, `search/store.ts:83`, `users/store.ts:58,66`), as the audit and system-log stores already do.
14. Banner URL rule: also refuse `/\` (`shared/system-banner.ts:62`); extend the CSV trigger to leading `|` and whitespace-then-`=` (`shared/discovery.ts:47`); add `nosniff` and a sandbox CSP to the photo gateway (`api/users/[userId]/photo/route.ts:40-48`); validate `client_uri`/`logo_uri` as https now (`lib/mcp/oauth.ts:96-97`).
15. Inbox rows written while an item was org-visible keep their title after the item is restricted; apply the live predicate in `getInbox` or purge on visibility change (`notifications/store.ts:42-66`).
16. Keys: check the base64 alphabet and length of the four encryption keys and assert they differ (`shared/email-crypto.ts:16`); add `**/.env*` to `.dockerignore`; pass the MinIO root secret to `mc` via `MC_HOST_s3` rather than the command line (`Jenkinsfile:452`).
17. Document removing `INNOBOX_BOOTSTRAP_ADMIN_GROUP` after first run and surface it in the admin UI (`lib/auth.ts:63-73`); document a distinct `NEXTAUTH_SECRET` per environment.

## 5. Coverage and limits

Read in full: middleware, auth, CSRF, RBAC, visibility and anonymity gates, every `route.ts` under
`packages/web/src/app/api` with its store/validation helpers, `app/mcp`, `app/oauth`,
`app/.well-known`, `lib/mcp/*`, the worker (SCIM, reconciliation, notifications, attachments,
webhooks, AI, public intake), all shared modules, all migrations, Dockerfiles, compose, Caddyfile,
Jenkinsfile and the GitHub workflow. Not done: dynamic testing, fuzzing, or a review of the React
client beyond XSS sinks (client-side checks are not trusted anyway). Rate-limit/DoS surface was
noted only where it compounds another finding.
