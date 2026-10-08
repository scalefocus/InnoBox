# InnoBox

**A self-hosted challenge & solution management platform for organizations.**

Employees raise **Challenges** — problems worth solving. Colleagues propose
**Solutions**. A per-namespace review organization (admins plus a review committee)
triages them, validates the good ones, and drives a single winning solution through to
implementation. Likes, comments, follows, notifications, leaderboards, and a triage
queue sit on top; everything is visibility-filtered, optionally anonymous, and audited.

Identity is anchored in **Microsoft Entra ID** — OIDC sign-in, SCIM 2.0 provisioning,
and group-based RBAC.

---

## Before you go further: prerequisites

InnoBox is enterprise software with real infrastructure dependencies. **There is no
demo mode and no way to run it without a Microsoft Entra ID tenant** — this was a
deliberate decision, not an omission (see [INNOBOX_SPEC.md](INNOBOX_SPEC.md) §19). If
you were hoping to `docker compose up` and click around, this is not that project.

You will need:

| | |
|---|---|
| **Microsoft Entra ID tenant** | An app registration for OIDC sign-in and an Enterprise Application for SCIM provisioning. Roles resolve from SCIM-synced group membership — never from token claims — so provisioning is required, not optional. |
| **PostgreSQL 16** | Primary datastore. Migrations are plain SQL in [`db/migrations/`](db/migrations/). |
| **S3-compatible object storage** | Attachments. MinIO is what the bundled compose stack uses. |
| **ClamAV** | Attachments are served only after a clean scan. |
| **A reverse proxy terminating TLS** | The stack serves internally on `:8080`. |
| **A Microsoft Graph service mailbox** *(optional)* | Outbound e-mail notifications, via delegated `Mail.Send`. Without it, the in-app notification inbox still works. |

## Running it

The full stack — Postgres, migrations, MinIO, ClamAV, web, worker, proxy — is defined
in [`deploy/docker-compose.yml`](deploy/docker-compose.yml).

```bash
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env` — every value is documented inline in the example file, and
**no deployment-specific value is committed to this repository**, so there is nothing
to un-configure. Then:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

The `migrate` service applies every migration in order and exits 0 when done. Health
endpoints are `/healthz` and `/readyz`; Prometheus metrics are at `/metrics`; logs are
structured JSON.

For local development (Node 24 LTS, pnpm 9.15.x):

```bash
pnpm install
```

```bash
docker compose -f deploy/docker-compose.yml up -d postgres minio clamav migrate
```

```bash
pnpm dev
```

`pnpm typecheck`, `pnpm test`, and `pnpm build` all run recursively across the
workspace (`@innobox/shared`, `@innobox/web`, `@innobox/worker`).

## How it is built

| Document | What it covers |
|---|---|
| [`INNOBOX_SPEC.md`](INNOBOX_SPEC.md) | **The authoritative specification.** Every behavior is specified here first and implemented second. Start here to understand what InnoBox does and why. |
| [`ENTRA_AUTH_SPEC.md`](ENTRA_AUTH_SPEC.md) | The identity integration in detail — OIDC sign-in, the SCIM 2.0 server, RBAC resolution, and the Entra dialect quirks that matter. |
| [`CLAUDE.md`](CLAUDE.md) | The working context: the non-negotiable invariants, the gated spec-first workflow, the release ritual, and commit conventions. |
| [`db/migrations/README.md`](db/migrations/README.md) | Migration conventions, the append-only audit trigger, and the least-privilege app role. |

A few invariants are worth knowing before reading any code, because they explain
choices that otherwise look strange:

- **Roles never come from OIDC token claims** — only from SCIM-synced group membership.
  (Entra silently drops the `groups` claim past ~200 groups; a claim-based
  implementation fails in exactly the large tenants it needs to work in.)
- **Anonymity is enforced at the API layer, everywhere.** Lists, details, search,
  exports, e-mails, notifications. True identity surfaces only through an audited admin
  reveal.
- **Visibility filtering is total.** A namespace-restricted challenge must not leak
  through lists, search, autocomplete, counts, KPIs, leaderboards, or notifications.
- **The audit log is append-only**, enforced both by database grants and a trigger.
- **Attachments are served only through the authenticated gateway**, and only after a
  clean virus scan.

## Versioning

The product version is **`APP_VERSION`** in
[`packages/shared/src/version.ts`](packages/shared/src/version.ts), shown in the
sidebar colophon and on the **What's new** page. The `version` fields in the
`package.json` files are deliberately left at `0.0.0` — the packages are not published
to any registry, and a second version to keep in step would earn nothing. If you are
reporting a bug, the number in the sidebar is the one worth quoting.

## Contributing, security, support

- **Pull requests are not accepted** and are closed automatically. This is not a
  judgement on your patch — see [CONTRIBUTING.md](CONTRIBUTING.md) for the reasoning.
- **Issues are welcome and are read.** Bug reports, deployment problems, documentation
  gaps, and questions all help.
- **Security vulnerabilities**: do not open a public issue. Use GitHub's private
  vulnerability reporting — see [SECURITY.md](SECURITY.md).
- **Support**: InnoBox is provided **as-is**. Issues are read, but no response time is
  promised and there is no support commitment. Plan accordingly if you intend to run it.
- Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Trademark

**The Apache-2.0 grant covers the code. It does not cover names, logos, or brand.**
Apache-2.0 §6 grants no permission to use the licensor's trade names, trademarks, or
product names beyond reasonable and customary use in describing the origin of the work,
and none are granted here: the creating organization's name and logo, and the InnoBox
wordmark and mark, remain theirs. You may run, modify, and redistribute the software
freely — but not present your version as the original or imply it is endorsed by them.

The brand ships as the default look, and the codebase is deliberately arranged so you
can strip it. **To rebrand a fork, edit these and nothing else:**

1. `packages/web/src/components/AppShell.tsx` — the sidebar colophon attribution line.
2. `packages/web/e2e/discovery.spec.ts` — the e2e assertion that the line renders.
3. `packages/web/src/lib/attribution.test.ts` — the hygiene test that enforces the
   above two. It is meaningless in a fork; delete it.
4. `packages/web/public/brand/` and `packages/web/src/app/icon.svg` — the wordmark, its
   light/dark variants, the social-share card, and the browser icon.
5. `packages/web/src/app/globals.css` — the design tokens, if you are replacing the
   palette too. The token table in [`INNOBOX_SPEC.md`](INNOBOX_SPEC.md) §2.2 documents
   what each one does.

That list is exhaustive by design, and a test keeps it that way: the organization's
name may not appear anywhere else in `packages/**`.
