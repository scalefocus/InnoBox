# CLAUDE.md — InnoBox project context

> Read this first. It pins the project's intent, decisions, conventions, and the
> gated workflow. The authoritative spec is **`INNOBOX_SPEC.md`**; this file is the
> working context for day-to-day implementation. `§n` references throughout are the
> canonical deep-dive pointers into `INNOBOX_SPEC.md`.

## What this is
**InnoBox** — an enterprise, self-hosted **challenge & solution management** platform:
employees raise Challenges, colleagues propose Solutions, per-namespace admins and a
review committee triage, validate, and drive the winning solution to implementation.
Identity/access is anchored in Microsoft Entra ID (OIDC + SCIM + group-based RBAC).
Production URL: the deployment's own **`PUBLIC_BASE_URL`** — none is pinned in the
repository (§2.3). Greenfield — it replaces a legacy
Power Apps app but carries **no** backwards compatibility or data migration.

## Key files (jump straight here)
| File | Role |
|---|---|
| `INNOBOX_SPEC.md` | The authoritative spec — every change lands here **first** |
| `packages/shared/src/version.ts` | `APP_VERSION` — bumped on every app change |
| `packages/web/src/app/whats-new/changelog.ts` | The What's new `CHANGELOG` — one entry per version bump |
| `db/migrations/` | Plain-SQL migrations, applied in order by the `migrate` compose service |
| `deploy/docker-compose.yml` | The full stack (postgres, migrate, minio, clamav, web, worker, proxy) |
| `ENTRA_AUTH_SPEC.md` | The identity integration in detail — OIDC, SCIM, RBAC (§3) |
| `LICENSE` / `NOTICE` | Apache-2.0 and the copyright notice (§21.1) |

## Local agent tooling (not in the repository)
Two skills — **scalify-ui** (the brand book) and **scale-entra** (the Entra
OIDC/SCIM/RBAC playbook) — were used to build this project. They are **not part of the
repository**: `.claude/skills/` is gitignored, because `scalify-ui` *is* the creating
organization's brand book and `scale-entra` is an internal playbook (`INNOBOX_SPEC.md`
§21.3). They may still be present on a given machine, and remain useful there, but
**nothing in the repository may depend on them** and no document may cite them as an
authority.

Consequently the authorities are in-repo:
- **Brand** — the token table in `INNOBOX_SPEC.md` §2.2 is the sole source for the
  palette, typography, and assets. (The old "where the skill and the spec table
  disagree, the skill wins" rule is **reversed**; the spec now simply wins.)
- **Identity** — `ENTRA_AUTH_SPEC.md` is the authority for OIDC sign-in, SCIM 2.0
  provisioning, and group-based RBAC.

## The change workflow (GATED — spec-first with a mandatory stop)
Every change to app behavior goes through this gate. **Never skip straight to code.**

1. **Grill first.** Interrogate the request until unambiguous: scope, edge cases,
   roles affected, visibility and anonymity implications, data model impact, what
   happens on transition/withdrawal/conflict. Depth proportional to the change.
2. **Update `INNOBOX_SPEC.md` — and ONLY the spec.** No code, no migrations yet.
3. **STOP for verification.** Present the spec diff and end the turn. **The user must
   approve the spec before anything is built.** Do not proceed on silence.
4. **Implement to match the approved spec.** Code follows spec, never the reverse.
   **New code ships with its tests in the same change:** unit tests for domain/RBAC/
   state-machine/validation/anonymity-masking logic, integration tests for anything
   touching the API, DB, or SCIM surface, e2e coverage when the change alters a
   user-facing flow (submit→triage→propose→validate→implement).
5. **Release ritual.** Version bump → changelog → commit (see below).

Exempt from the gate: pure internal work with zero behavior change (refactors, CI,
comments) and doc-only edits — but if in doubt, it's gated. The `cp`/`mm` shortcuts
never bypass the gate: they assume steps 1–4 already happened.

## Commands / dev workflow
Node ≥ 20, pnpm 9.15.x (pinned via `packageManager`). Workspace packages:
`@innobox/shared`, `@innobox/web`, `@innobox/worker`. Shell commands below are
**bash syntax** — on Windows run them in Git Bash (or adapt for PowerShell).

```bash
pnpm install                                   # bootstrap the workspace
cp deploy/.env.example deploy/.env             # once; fill secrets (never commit)
docker compose -f deploy/docker-compose.yml up -d postgres minio clamav migrate
                                               # backends + migrations (migrate exits 0 when done)
pnpm dev                                       # all packages in parallel; web on http://localhost:3000
pnpm --filter @innobox/web dev                 # a single package
pnpm test | pnpm typecheck | pnpm build        # all packages (recursive)
docker compose -f deploy/docker-compose.yml up -d --build   # full containerized stack
```

**Pre-commit gate: `pnpm typecheck` must pass, plus the tests of every package you
touched.**

## Non-negotiable invariants (§2.1)
1. **Roles resolve from SCIM-synced group membership + `role_mappings`, NEVER from
   OIDC token claims** (Entra ~200-group claim overage).
2. **All access is auth-required and strictly visibility-filtered.** A
   namespace-restricted challenge must never leak via lists, search, autocomplete,
   counts, KPIs, leaderboards, or notifications (§4.3).
3. **Anonymity is enforced at the API layer, everywhere** — lists, details, search,
   exports, e-mails, notifications. True identity is exposed only through the
   audited admin **reveal** action (§9).
4. **Attachments are served only through the authenticated fetch gateway** — no
   direct object-store URLs — and only after a clean ClamAV scan (§11). Attachment rows
   are permanent tombstones; the sole exception is the platform-admin delete cascade
   (§10.3).
5. **`audit_log` is append-only.** App DB role lacks UPDATE/DELETE; a trigger
   enforces it too (§15). Never mutate audit rows.
6. **Status transitions follow the enforced state machines** (§7.2, §8.2) for
   committee members and assignees; namespace/platform admins may set any status —
   every transition is audited with `from → to` and actor.
7. **At most one Solution per Challenge advances past `valid`** (§8.3). Implementing
   it auto-solves the challenge and closes siblings as `not_selected`.
8. **The organization's name is confined to a closed set of places, so a fork can
   strip it in one edit** (§2.2 removability rule). InnoBox is Apache-2.0 (§21), which
   grants no trademark rights — the brand ships as the default and must be *removable*.
   The permitted places are exactly: the sidebar colophon, its e2e assertion in
   `discovery.spec.ts`, `LICENSE`/`NOTICE` (copyright holder), and the passages of the
   spec and this file that define the rule. Never in copy, e-mails, exports, metadata,
   comments, other tests, fixtures, config defaults, or other docs; and **no
   deployment-specific value** (host, mailbox, repo URL) lives in the repository —
   those come from `deploy/.env` via the Jenkins credentials (§2.3). The brand itself
   (palette, typography, logo assets) is unchanged.
   Enforced by `packages/web/src/lib/attribution.test.ts`, which scans all of
   `packages/**`.
9. **No `§` spec reference reaches a user-facing surface** (§21.9) — not API error
   messages, changelog entries, page copy, or e-mail templates. A user cannot resolve
   "§10.1". Comments, JSDoc, tests, and SQL comments may cite the spec freely; that is
   what anchors the code to it. Enforced by `packages/web/src/lib/spec-refs.test.ts`.
10. **Store UTC, convert at display.** Every time column is `timestamptz`; the API
   serializes UTC ISO strings; the browser converts via the shared formatter
   (`components/DateFormat.tsx` → `useDateFmt()`). EU/US style is a platform setting.

## Roles (§4)
- **Platform Admin** (global) · **Namespace Admin** (per-ns) · **Committee Member**
  (per-ns, enforced transitions only) · **Assignee** (per-challenge).
- Implicit for any authenticated user: submit challenges, propose solutions (on
  `valid` challenges only), comment, like, follow, consume per visibility.

## Before every commit (the release ritual, in order)
1. **Spec** — `INNOBOX_SPEC.md` reflects the change (done and approved in the gate).
2. **Implementation** — matches the approved spec, **with its tests**;
   `pnpm typecheck` + touched tests pass.
3. **Version** — bump `APP_VERSION` in `packages/shared/src/version.ts` (rules below).
4. **Changelog** — prepend the matching entry to `changelog.ts` (rules below).
5. **Commit** — subject `type(scope): summary (vX.Y.Z)`, body as needed, ending with
   the `Co-Authored-By` trailer. Then push.

Steps 3–4 are skipped only when the change is doc-only/infra-only (no bump → no
changelog entry → no `(vX.Y.Z)` suffix).

## App version (MANDATORY on every change)
`APP_VERSION` lives in **`packages/shared/src/version.ts`** (client-safe via
`@innobox/shared/version`) and is displayed in the sidebar colophon above the two
attribution lines (§2.2). **Bump it in the SAME commit as ANY change to the app:**
- **patch** — bug fixes, styling/layout, copy, refactors, small tweaks
- **minor** — new features, endpoints/pages, behaviors, DB migrations
- **major** — breaking changes (API shapes, required config)

One bump per commit (highest applicable level). **The new version must be strictly
greater than the highest version already in the branch history** — re-check
`git log` before bumping.

## What's new / changelog (MANDATORY before every commit & push)
The **What's new** page (`/whats-new`, linked in the account menu) reads from
**`packages/web/src/app/whats-new/changelog.ts`**. Whenever you bump `APP_VERSION`,
prepend one `{ version, date, summary }` entry (newest first) in the SAME commit:
`version` = the new `APP_VERSION`, `date` = today (UTC `YYYY-MM-DD`), `summary` = one
user-facing line derived from the commit message. No bump → no entry.

**`changelog.ts` is itself the source of truth for past versions.** The history was
squashed to a single commit for the open-source release (§21.4), so `git log` no longer
carries the per-version subjects that used to serve as the backfill source — nothing
reconstructs a lost entry. Treat the file as append-only history: never rewrite or drop
an existing entry, only prepend.

## Conventions
- **Commit subjects: `type(scope): summary (vX.Y.Z)`** — conventional-commit prefix
  (`feat`/`fix`/`style`/`chore`/`docs`/`refactor`), scope in parentheses, the new
  `APP_VERSION` as suffix. **The suffix is load-bearing** (changelog backfill parses
  it). Omit only on no-bump commits.
- **Shortcut: "cp" = commit and push.** Stage all, commit with a descriptive message
  ending in the `Co-Authored-By` trailer, push (rebase onto `origin/main` and retry if
  rejected). Bump `APP_VERSION` + changelog first, as usual.
- **Shortcut: "mm" = merge into main.** Run these steps in order, every time:
  1. Commit as `cp` would (stage all, bump `APP_VERSION` + changelog first, commit
     with the `Co-Authored-By` trailer).
  2. **Get the latest code** — `git fetch origin` and rebase the branch onto
     `origin/main` (`git pull --rebase origin main`).
  3. **Resolve any conflicts** from the rebase, then continue it.
  4. **Fast-forward merge into `main`** — check out `main`, `git pull --rebase origin
     main`, and merge the branch fast-forward (`git merge --ff-only <branch>`); push
     `main`.
  5. **Delete this worktree and its branch** — return to the primary checkout, remove
     the worktree (`git worktree remove`), and delete the now-merged branch locally
     and on the remote.
  On `main` already (not a worktree), `mm` behaves like `cp` (steps 1–2 + push).
- Language: TypeScript everywhere, ESM. Package manager: **pnpm** (workspaces).
- DB access: parameterized SQL / a thin query layer; migrations are plain SQL files
  in `db/migrations` (see the README there for idempotency + audit-trigger rules).
- Secrets: env / mounted only — never baked into images or committed.
- Logs: structured JSON. Health: `/healthz`, `/readyz`. Metrics: Prometheus `/metrics`.
- Tests: unit (domain, RBAC, state machines, anonymity), integration (API + DB +
  **SCIM conformance vs Entra payloads**), e2e (submit→triage→propose→implement).

## Starter-kit provenance (read before touching the carried-over modules)
This repo was seeded from a starter kit; some modules were carried over from a
proven sibling project with `skilly→innobox` renames applied:
- `packages/web/src/app/globals.css` — brand tokens + app-shell CSS. Sections for
  features InnoBox lacks are pruned during Phase 4; new UI follows the §2.2 token table.
- `packages/shared/src/email-*.ts` + `email.ts` — the Graph e-mail engine
  (delegated Mail.Send service mailbox, encrypted token storage, wrapper templates)
  **with its tests**. Wire its exports into `src/index.ts` and the worker dispatch
  when implementing §12. Comment references to old audit items / spec § numbers are
  historical — re-anchor when touching.
- `packages/web/src/lib/email.ts` — web-tier email admin helpers. Depends on
  `./db`, `./audit`, and the `platform_settings` / `email_service_account` / `users`
  tables — wire during Phases 1/3.
- `packages/web/src/components/DateFormat.tsx` — the timestamp formatter (imports a
  `./ui` cache helper that Phase 0 must provide).
- Dockerfiles, compose, Caddyfile, migrate.sh, Jenkinsfile — ready; all deploy specifics
  (host, path, repo URL, keys) load from Jenkins credentials (see the Jenkinsfile header
  for the IDs) — nothing environment-specific is hardcoded. GitHub Actions
  (`.github/workflows/ci.yml`) is the public CI; Jenkins mirrors it and owns deploy.

## Build order (§18)
Phase 0 foundations → Phase 1 identity (OIDC + SCIM + RBAC + namespaces, per
`ENTRA_AUTH_SPEC.md`) → Phase 2 core domain (challenges, solutions, state machines,
attachments + scan, search) → Phase 3 social + notifications (comments, likes,
follows, outbox, e-mail + bell) → Phase 4 discovery + admin (dashboard, KPIs,
leaderboards, profile, triage queue, bulk/CSV, settings, polish).

## Don't
- Don't build before the spec is updated AND the user has verified it.
- Don't resolve roles from token claims. Don't mutate audit rows.
- Don't let namespace-restricted challenges leak via metadata/search/counts/
  leaderboards. Don't expose anonymous authors outside the audited reveal path —
  not in UI, not in e-mails, not in exports.
- Don't serve attachments except through the gateway, and never before a clean scan.
- Don't allow a second solution past `valid` on the same challenge.
- Don't hard-delete a challenge/solution row outside the platform-admin delete cascade
  (§10.3) — every other removal path is soft (withdraw, comment `deleted_at`, attachment
  tombstone), and the new DELETE grants exist only to serve that cascade.
- Don't introduce Kubernetes/Helm, SAML, or i18n in v1. Never deploy to Vercel.
- Don't set the dev-auth bypass flag outside local dev/e2e.
