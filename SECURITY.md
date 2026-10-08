# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it through GitHub's private vulnerability reporting: go to the **Security**
tab of this repository and choose **Report a vulnerability**. That channel is private
between you and the maintainers until an advisory is published.

There is deliberately no e-mail address here. InnoBox pins no organization- or
deployment-specific value in the repository, and GitHub advisories give a private
channel without one.

## What to include

Whatever you have: the affected component (web, worker, migrations, deployment
configuration), the version or commit, what an attacker can achieve, and the steps to
reproduce it. A proof of concept helps but is not required.

## Scope

InnoBox is self-hosted software. Reports concern **this codebase** — not any
particular deployment of it. If you have found a problem with a running InnoBox
instance you do not operate, contact whoever operates it.

In scope, and worth reporting:

- Anything that lets a user read or act on a challenge or solution outside their
  visibility (namespace-restricted content leaking through lists, search,
  autocomplete, counts, KPIs, leaderboards, or notifications).
- Anything that exposes the true identity behind an anonymous submission outside the
  audited admin reveal — in the UI, an API response, an export, an e-mail, or a
  notification.
- Anything that escalates a role beyond what the SCIM-synced group membership grants.
- Anything that serves an attachment outside the authenticated gateway, or before a
  clean virus scan.
- Anything that mutates or deletes rows in the append-only audit log.
- Authentication or session handling flaws.

Out of scope:

- The `INNOBOX_DEV_AUTH` credentials sign-in. It is guarded by a second condition
  (`NODE_ENV !== "production"`) and cannot be enabled in a production build. Reports
  that require setting it in a development build are not vulnerabilities. Reports that
  demonstrate it activating in a **production** build very much are.
- Findings that require an attacker to already hold Platform Admin.
- Missing hardening on the example deployment configuration in `deploy/` where the
  documentation already tells the operator to change it.
- Vulnerabilities in dependencies with no demonstrated impact on InnoBox — report
  those upstream.

## Supported versions

Only `main` is supported. There are no maintained release branches and no backported
fixes; a fix lands on `main` and deployments update by redeploying.

## What to expect

Reports are read. No response time is promised — see the support statement in
[README.md](README.md). If a report is valid and fixed, the advisory credits you
unless you would rather it did not.
