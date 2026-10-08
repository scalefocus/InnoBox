# Contributing

Thanks for looking. Please read this before you spend time on anything — the posture
here is unusual and it is better to know up front.

## Pull requests are not accepted

**Pull requests are closed automatically.** This is not a judgement on your patch. It
is the honest position: InnoBox is developed by one organization for its own use, and
we are not resourced to review, test, and take responsibility for external code. We
would rather say that plainly than leave contributions sitting unreviewed for months.

If you want to change the code, **fork it**. Apache-2.0 gives you that right in full,
and the codebase is deliberately arranged so a fork can strip the original branding in
a handful of edits — see the TRADEMARK section in [README.md](README.md).

## Issues are welcome

Genuinely. The issue tracker is read, and it is the most useful thing you can offer:

- **Bug reports** — what you expected, what happened, the version from the sidebar
  colophon, and steps to reproduce. Server logs are structured JSON; the relevant
  lines usually say a lot.
- **Deployment problems** — something in `deploy/`, the migrations, or the Entra
  setup that does not work or is not documented well enough to follow.
- **Documentation gaps** — anywhere `README.md`, `INNOBOX_SPEC.md`, or
  `ENTRA_AUTH_SPEC.md` is wrong, stale, or assumes knowledge it should not.
- **Questions** about how something is meant to work. If the answer is not in the
  spec, that is a gap worth knowing about.
- **Feature ideas** — with the caveat below.

**No response time is promised.** Issues may sit. See the support statement in
[README.md](README.md).

## Security issues do not go here

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability
reporting — see [SECURITY.md](SECURITY.md).

## Before filing a feature idea

Two things shape what InnoBox will and will not do:

- **[INNOBOX_SPEC.md](INNOBOX_SPEC.md) is the authoritative specification.** Behavior
  is specified there first and implemented second, never the other way round. §19 is
  the explicit non-goals list — if your idea is on it, the reasoning for the rejection
  is recorded alongside it.
- **The invariants in [CLAUDE.md](CLAUDE.md) are not negotiable** — visibility
  filtering, anonymity enforcement at the API layer, the append-only audit log, the
  attachment gateway, roles resolved from SCIM group membership rather than token
  claims. A feature that requires relaxing one of these will not be built.

## If you are working in a fork

The repository documents its own conventions and they may save you time:

- `CLAUDE.md` — the working context: invariants, the gated spec-first workflow, the
  release ritual, commit conventions.
- `INNOBOX_SPEC.md` — what the product does and why.
- `ENTRA_AUTH_SPEC.md` — the identity integration in detail (OIDC, SCIM, RBAC).
- `db/migrations/README.md` — migration conventions, including the append-only audit
  trigger and the least-privilege app role.

## Code of conduct

Participation in the issue tracker is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).
