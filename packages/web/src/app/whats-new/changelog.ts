// Changelog shown on the /whats-new page — newest version first.
//
// MAINTENANCE (see CLAUDE.md "What's new / changelog"): add one entry here in the SAME commit as
// every APP_VERSION bump, derived from that commit's message, BEFORE committing & pushing. Keep it
// user-facing and one line per version. Dates are the commit date (UTC, YYYY-MM-DD).
export interface ChangelogEntry {
  version: string;
  date: string; // YYYY-MM-DD
  summary: string;
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.44.0",
    date: "2026-10-08",
    summary:
      "Platform admins can now feature up to a few hand-picked challenges at the top of Home. Featured challenges show only to people allowed to see them, and a challenge drops off the list on its own if it is closed or withdrawn. The number of featured slots is a platform setting.",
  },
  {
    version: "0.43.0",
    date: "2026-10-08",
    summary:
      "Platform admins can connect a namespace to a Teams or other chat channel: when a challenge in that namespace opens for solutions, a solution is implemented, or a challenge is solved, a short post with the title, status and a link appears in the channel. Only organization-wide items are ever posted, and nobody's name is included.",
  },
  {
    version: "0.42.0",
    date: "2026-10-08",
    summary:
      "The Challenges page can now show challenges as a compact list instead of cards — number, title, status, namespace, author, likes, solutions and date on one row, with the same \"new\" tags. Your choice is remembered on this browser.",
  },
  {
    version: "0.41.0",
    date: "2026-10-08",
    summary:
      "The audit log can now prove it hasn't been tampered with: every new entry is chained to the one before it, and platform admins have a \"Verify integrity\" button that checks the whole chain and points to the first entry that doesn't match. Each check is itself recorded in the audit log.",
  },
  {
    version: "0.40.0",
    date: "2026-10-08",
    summary:
      "Platform admins get an Identity sync card in Administration: how many people and groups the directory has provisioned, when the last sync request arrived (and the last one that was refused), which role-mapped groups never arrived, and plain-language next steps when users sync without groups or nothing has synced yet.",
  },
  {
    version: "0.39.0",
    date: "2026-10-08",
    summary:
      "When a platform admin deletes a person's information, they can now hand that person's open assignments to a colleague in the same step. Anything the colleague can't see is listed so it can be reassigned by hand, and the colleague gets a single notification listing what they took over.",
  },
  {
    version: "0.38.0",
    date: "2026-10-08",
    summary:
      "Behind the scenes: operators can now run the browser security policy in report-only mode while checking a new deployment, and violations are counted for monitoring. Nothing changes in how InnoBox looks or works.",
  },
  {
    version: "0.37.0",
    date: "2026-10-08",
    summary:
      "Signing out now clears every InnoBox sign-in cookie, not just the session. And if your account was set up under the wrong directory ID, signing in for the first time now links you to it instead of failing or creating a second, empty account.",
  },
  {
    version: "0.36.1",
    date: "2026-10-08",
    summary:
      "Menus and pop-ups now open with the same quick, subtle animation everywhere, including the search suggestions under the top bar, and they share one consistent look. If your device is set to reduce motion, they simply appear.",
  },
  {
    version: "0.36.0",
    date: "2026-10-08",
    summary:
      "Submitting a challenge or solution, or resubmitting one, now locks the form while InnoBox works on it: the button reads \"Working…\" and nothing can be clicked twice, so a slow connection can no longer create a duplicate. If something goes wrong the form unlocks with everything you typed still in place.",
  },
  {
    version: "0.35.1",
    date: "2026-10-08",
    summary:
      "Behind the scenes: small code-quality fixes to the system log, the duplicate warning and the Challenges menu counter so they follow React's rendering rules. Nothing changes in how InnoBox looks or works.",
  },
  {
    version: "0.35.0",
    date: "2026-10-08",
    summary:
      "A busy comment thread no longer floods your inbox. Comments on the same challenge or solution now gather into a single notification — \"3 new comments on CH-412 … latest by Alice\" — that moves back to the top with each new one, and you get at most one e-mail about it until you have read it. Opening the challenge, opening the notification, or marking everything read counts as reading it; the next comment after that starts afresh.",
  },
  {
    version: "0.34.0",
    date: "2026-10-08",
    summary:
      "Your profile has three new notification switches: comments on items you follow, status changes on items you follow, and new solutions on challenges you follow. Turning one off stops those notifications altogether — no bell, no e-mail — while keeping everything else. Messages that need you to act, such as a rejection, a request for improvement or an assignment, always come through, and admins keep hearing about new work to triage.",
  },
  {
    version: "0.33.0",
    date: "2026-10-08",
    summary:
      "Before a new challenge is submitted, InnoBox now checks for challenges that look similar — among the ones you can already see — and lists up to five of them, so you can join an existing conversation instead of starting a duplicate. It is only a suggestion: \"Submit anyway\" goes ahead, and changing anything on the form simply checks again. Rejected and withdrawn challenges are left out; solved ones are included, since they may already hold your answer.",
  },
  {
    version: "0.32.0",
    date: "2026-10-08",
    summary:
      "The Challenges menu item now shows how many challenges have appeared since you last looked, and each of those cards carries a small \"new\" tag so you can spot them at a glance. The count and the tags stay put while you browse and reset when you leave the Challenges page — a new solution or comment on an old challenge does not make it new again. Only challenges you are allowed to see are ever counted.",
  },
  {
    version: "0.31.0",
    date: "2026-10-08",
    summary:
      "Platform admins can post a system banner — a short announcement that every signed-in person sees in the header, for things like a planned maintenance window. It takes an info or warning tone, an optional \"Learn more\" link and a fixed duration from one hour to 30 days, then disappears on its own (or when an admin clears it). Saving a new one replaces the old. It is not a notification: nobody is e-mailed and nothing lands in the inbox.",
  },
  {
    version: "0.30.0",
    date: "2026-10-08",
    summary:
      "The audit log is easier to work with: category chips (Challenges, Solutions, Comments, Attachments, Identity, Admin), a search box that matches actions, challenge or solution numbers and the acting person, a From/To date range, and a one-click way to clear every filter. The list now scrolls on endlessly instead of paging, and platform admins can export exactly the entries they are looking at as a CSV file — capped at 50,000 rows, and every export is itself recorded in the audit log.",
  },
  {
    version: "0.29.0",
    date: "2026-10-08",
    summary:
      "Platform admins get a System log: a view of the errors InnoBox returned to people — server failures and refused requests — with who hit them, searchable, filterable by status and date, exportable to CSV, and kept for 90 days. New entries light up a badge on the Administration console and a single in-app alert that keeps counting until it is read. It is operational telemetry, separate from the audit log, and it never stores request contents; entries that concern an anonymous challenge or solution never name the item.",
  },
  {
    version: "0.28.0",
    date: "2026-10-08",
    summary:
      "Searching is now part of the protection against runaway or automated traffic: each person can run up to 120 searches a minute, which normal use never comes close to, and anything over that is simply asked to wait a moment and retry. The identity sync endpoint gets the same kind of protection for each caller.",
  },
  {
    version: "0.27.1",
    date: "2026-10-08",
    summary:
      "A notification whose text contains an unusually long run of punctuation inside a link no longer slows down e-mail rendering.",
  },
  {
    version: "0.27.0",
    date: "2026-10-08",
    summary:
      "Security hardening across the app. Attachments are now checked by their actual contents, large uploads must match the size they declared, and a file the virus scanner can't check is marked \"Couldn't be scanned\" instead of waiting forever — encrypted archives are refused for the same reason. Items you can't see now look exactly like items that don't exist, a solution on a withdrawn challenge no longer shows on its author's public profile, and spreadsheet exports can no longer smuggle in formulas. Notification e-mails only link back to InnoBox itself, and very rapid repeated actions are briefly slowed down.",
  },
  {
    version: "0.26.2",
    date: "2026-10-08",
    summary:
      "Behind the scenes: an image-processing component that InnoBox never used is no longer installed, keeping the software's licensing simple. Nothing changes in how InnoBox looks or works.",
  },
  {
    version: "0.26.1",
    date: "2026-10-08",
    summary:
      "Security maintenance: the web framework, sign-in library and e-mail sender — along with the libraries beneath them — are updated to versions that close known vulnerabilities. Nothing changes in how InnoBox looks or works.",
  },
  {
    version: "0.26.0",
    date: "2026-08-26",
    summary:
      "Platform admins can now delete a challenge or a solution for good — for the rare case where something has to be gone rather than merely closed, such as confidential material posted by mistake. It is permanent: the item goes with its solutions, comments, likes, follows and files, there is no restore, and nobody is notified. To guard against a slip, the confirm step asks for the item's number typed back and a reason, which is kept in the audit trail. Deleting the solution that solved a challenge reopens that challenge for new solutions. Everyone else's options are unchanged — authors still withdraw their own items, and admins still close or reject.",
  },
  {
    version: "0.25.1",
    date: "2026-08-26",
    summary:
      "The e-mail notifications control on your profile is now a proper switch, matching the light/dark one in the top bar: an On/Off label beside a sliding pill that turns blue when e-mail is on. It flips the moment you click it, and if the change cannot be saved it slides back and tells you why instead of quietly doing nothing. In-app notifications are unaffected — they are always delivered.",
  },
  {
    version: "0.25.0",
    date: "2026-08-10",
    summary:
      "InnoBox is now open source under the Apache 2.0 licence. Nothing changes in how the app works, but a rough edge is gone: error messages no longer trail an internal reference number, so a message now simply says what went wrong. The brand stays as it is, and the licence spells out that anyone running their own copy is free to replace it.",
  },
  {
    version: "0.24.0",
    date: "2026-08-10",
    summary:
      "The sidebar colophon now reads “Powered by the community” beneath the “Created by” line — a nod to everyone who raises, proposes and builds here. In preparation for an open-source release, that colophon is the single place InnoBox names its maker: the sign-in card now says “Sign in with your Entra ID account”, and deployment details such as the site address and notification sender come purely from configuration. The look and feel is unchanged.",
  },
  {
    version: "0.23.0",
    date: "2026-07-29",
    summary:
      "Administration has a new “Currently online” panel for platform admins: see who is active right now (5 minutes up to 30 days), search them by name or email, and watch daily active users, DAU/WAU/MAU trend over time. Activity comes from real use of the app, never background polling; anonymous items are never named as someone's location; per-person activity is kept for 3 days and only platform admins can see it.",
  },
  {
    version: "0.22.0",
    date: "2026-07-28",
    summary:
      "Hover any avatar to see who that person is — a small card with their job title, department and office location, plus a link to their full profile. Office location is new, and it now shows on profile pages too. Anonymous authors never get a card.",
  },
  {
    version: "0.21.2",
    date: "2026-07-23",
    summary:
      "Triage queue now reads cleanly on phones — the filters stack full-width one per line, and each queue row restacks so its details fall below each other instead of clipping off the edge of the screen.",
  },
  {
    version: "0.21.1",
    date: "2026-07-23",
    summary:
      "Triage queue: click anywhere on a row to open it, the assignee column is now an inline field you can type in to search and reassign (with a ✕ to unassign), and assignee search results float above the list instead of being clipped.",
  },
  {
    version: "0.21.0",
    date: "2026-07-23",
    summary:
      "Platform admins can now delete a retired impact area from Admin settings — either when nothing uses it, or by moving its challenges to another active area first.",
  },
  {
    version: "0.20.2",
    date: "2026-07-23",
    summary:
      "The Triage queue, Platform settings, and Audit log pages now show a breadcrumb that links back to the Administration console.",
  },
  {
    version: "0.20.1",
    date: "2026-07-23",
    summary:
      "Assignee search results now show each person's avatar with their name and email neatly stacked and trimmed to fit — no more text spilling outside the dropdown, on both the challenge page and the triage queue.",
  },
  {
    version: "0.20.0",
    date: "2026-07-23",
    summary:
      "Attachments now upload with a progress bar and are virus-scanned before you can submit; large files upload in chunks (chunk size is configurable in Admin settings).",
  },
  {
    version: "0.19.1",
    date: "2026-07-23",
    summary: "Dropdown menus now show a cleaner down-arrow that sits a little further from the right edge, evenly spaced within the field, in both light and dark themes.",
  },
  {
    version: "0.19.0",
    date: "2026-07-23",
    summary:
      "Admins now get notified when a challenge or solution is submitted, resubmitted, or withdrawn, and the sidebar shows a Triage item with a 1–9+ bubble counting challenges and solutions awaiting attention — it clears when you open the triage queue, which now has a Solutions tab.",
  },
  {
    version: "0.18.5",
    date: "2026-07-23",
    summary: "The header search now shows a clear (✕) button once you start typing — click it or press Escape to empty the field.",
  },
  {
    version: "0.18.4",
    date: "2026-07-20",
    summary: "The account menu now shows your name neatly spaced and vertically centered next to your avatar bubble.",
  },
  {
    version: "0.18.3",
    date: "2026-07-16",
    summary: "The main menu now has a Submit a Challenge link that takes you straight to the challenge form.",
  },
  {
    version: "0.18.2",
    date: "2026-07-16",
    summary: "The Administration link in the main menu now uses a shield icon.",
  },
  {
    version: "0.18.1",
    date: "2026-07-16",
    summary:
      "Sharing an InnoBox link in Teams, Slack, or chat now shows a branded preview card — the innobox logo and tagline on a deep-navy background.",
  },
  {
    version: "0.18.0",
    date: "2026-07-16",
    summary:
      "You can now attach files while raising a challenge or proposing a solution — pick them right on the form and they're saved with your submission. Each file is virus-scanned, and the per-file size and count limits stay configurable in Administration.",
  },
  {
    version: "0.17.3",
    date: "2026-07-16",
    summary:
      "Fresh InnoBox branding — the official innobox logo now appears in the sidebar (navy on the light theme, white on the dark theme) and the browser tab shows the new orange box icon.",
  },
  {
    version: "0.17.2",
    date: "2026-07-16",
    summary: "The search bar now shows a small Ctrl+K (⌘K on Mac) hint so you can discover the jump-to-search shortcut.",
  },
  {
    version: "0.17.1",
    date: "2026-07-16",
    summary: "Fixed the administration cards (Namespaces, Role mappings, etc.) not fully collapsing — they used to still show a sliver of their content at the top when closed.",
  },
  {
    version: "0.17.0",
    date: "2026-07-16",
    summary: "Press Ctrl+K (Cmd+K on Mac) anywhere in the app to jump straight to the search bar.",
  },
  {
    version: "0.16.1",
    date: "2026-07-16",
    summary: "The title field now focuses automatically when you open the raise-a-challenge form.",
  },
  {
    version: "0.16.0",
    date: "2026-07-15",
    summary:
      'New "Quick start" onboarding page walking through submitting a challenge, proposing a solution, commenting/liking/following, and finding your way around — auto-opens the first time a new user signs in, and stays reachable afterward from the account menu, above "What\'s new".',
  },
  {
    version: "0.15.5",
    date: "2026-07-15",
    summary:
      "Security: email notifications now use a dedicated ‘InnoBox Email’ Entra app registration (ENTRA_EMAIL_CLIENT_ID/SECRET) so the Mail.Send permission is isolated from the OIDC app and cannot be exercised on behalf of regular users.",
  },
  {
    version: "0.15.4",
    date: "2026-07-15",
    summary:
      "Tiny fix: the topbar notification bell button now centers its icon correctly (it was relying on the browser's default button padding, which isn't reliably symmetric).",
  },
  {
    version: "0.15.3",
    date: "2026-07-15",
    summary:
      "Avatar bubbles everywhere: your Entra profile photo now appears next to your name across challenges, solutions, comments, assignees, the leaderboard, profiles, search, triage, and the account menu — falling back to coloured initials when there's no photo. Anonymous authors always show a neutral bubble (never a photo or identifying colour), and a deactivated user's photo is dropped automatically.",
  },
  {
    version: "0.15.2",
    date: "2026-07-15",
    summary:
      "Small polish: the topbar notification bell now uses a bell emoji, matching the emoji-glyph style of the theme toggle beside it.",
  },
  {
    version: "0.15.1",
    date: "2026-07-15",
    summary:
      "Small polish: the topbar notification bell now matches the theme toggle beside it — same rounded pill shape, height, and surface — so the two controls read as a matched pair.",
  },
  {
    version: "0.15.0",
    date: "2026-07-15",
    summary:
      "New sign-in experience: the separate sign-in page is gone. When you're signed out, the app opens on the Home welcome with a 'Sign in with Entra ID' button right where your account menu sits once you're in — no clutter, no nav links until you sign in.",
  },
  {
    version: "0.14.0",
    date: "2026-07-10",
    summary:
      "Observability & polish: web and worker now expose a Prometheus /metrics endpoint (build/up/process gauges, worker leader + sweep counters), token-guarded via METRICS_TOKEN. 'Rejected' and 'Needs improvement' notifications now go to the item's author only (with the edit-&-resubmit call to action), and an anonymous author is warned that commenting shows their real name.",
  },
  {
    version: "0.13.0",
    date: "2026-07-10",
    summary:
      "Triage queue gets faster assignment: filter by a specific assignee (or 'Assigned to me', or Unassigned), and assign, reassign, or unassign any challenge inline from its row without opening the detail page — with the same permissions, notifications, follow, and audit trail as before.",
  },
  {
    version: "0.12.0",
    date: "2026-07-10",
    summary:
      "Attachments arrive: authors can attach files to their challenges and solutions while the item is editable — only safe file types are accepted, each upload is virus-scanned by ClamAV before anyone can download it, and downloads are served through an authenticated gateway that enforces visibility and never leaks who uploaded an anonymous item. Authors can remove their own attachments, infected files are blocked and their uploader notified, and everything is audited.",
  },
  {
    version: "0.11.0",
    date: "2026-07-10",
    summary:
      "Security & compliance batch: namespace/platform admins can change a challenge's visibility (org ↔ namespace) after submission, with every change audited; platform admins get a new read-only, filterable Audit log browser over the append-only trail; and a GDPR 'Delete user info' erasure de-identifies a user and all their content (name becomes 'Deleted User', personal fields cleared, account deactivated) — irreversible and itself audited.",
  },
  {
    version: "0.10.0",
    date: "2026-07-10",
    summary:
      "Quick-wins sweep: unassignment now notifies the removed assignee, solution-implemented reaches solution followers, assignees are auto-followed, and the e-mail sweep backs off on Graph rate-limits; challenge detail shows the assignee and edited/updated dates, solution deep-links scroll to the solution, committee comments carry a badge; admins get impact-area rename, a triage 'created' column, and remembered collapse state; and other users' profiles show their photo.",
  },
  {
    version: "0.9.0",
    date: "2026-07-09",
    summary:
      "Authors can now edit their own challenges/solutions within the allowed windows (awaiting-triage / proposed, and again on needs-improvement), resubmit a needs-improvement item back into review (notifying reviewers), and withdraw from any non-terminal status — every edit stamps a timestamp and records a field-level diff in the audit trail.",
  },
  {
    version: "0.8.1",
    date: "2026-07-09",
    summary:
      "Fixed the Home dashboard and profile KPI tiles leaving empty cells on tablet/mobile widths — the 4-metric rows now lay out 4-across on desktop and a clean 2×2 on smaller screens instead of an auto-fit grid that could land on 3 columns.",
  },
  {
    version: "0.8.0",
    date: "2026-07-09",
    summary:
      "Committee members and challenge assignees can now move challenges and solutions through the enforced state machine — the detail page offers only the legal next statuses, admins keep the free-set override, and the audit trail distinguishes enforced transitions from overrides.",
  },
  {
    version: "0.7.1",
    date: "2026-07-09",
    summary:
      "Fixed local dev sign-in failing with a duplicate-key error: the dev user's synthetic username is now derived from the display name (1:1 with its identity) instead of the email, so two dev personas that share an email no longer collide.",
  },
  {
    version: "0.7.0",
    date: "2026-07-08",
    summary:
      "Hardening pass: capped and parallelized admin bulk actions, paginated and debounced the triage queue, indexed challenge assignment lookups, fixed a notification-dispatch N+1 query, consolidated duplicated fetch/transaction/form-field code, and got `pnpm lint` actually running (ESLint was silently non-functional).",
  },
  {
    version: "0.6.0",
    date: "2026-07-08",
    summary:
      "Discovery & admin: a real Home dashboard (KPI tiles, spotlights), the Leaderboard page, full-text search with topbar autocomplete, personal & public profiles, an admin triage queue with bulk assign/status and CSV export, and platform settings (impact areas, attachment limits, date format, notification sender).",
  },
  {
    version: "0.5.0",
    date: "2026-07-08",
    summary:
      "Social features land: comments with 15-minute owner edits and admin moderation, follow/unfollow with auto-follow, an in-app notification bell backed by e-mail delivery, admin assignment, and anonymity reveal (admin transient, author self-reveal).",
  },
  {
    version: "0.4.0",
    date: "2026-07-08",
    summary:
      "Challenges are here: raise a challenge, browse the gallery (tabs, filters, sort), propose solutions, like challenges and solutions, and an admin status override to triage — all with full anonymity masking and audit trail.",
  },
  {
    version: "0.3.1",
    date: "2026-07-08",
    summary:
      "Local dev sign-in now pre-fills the Dev display name, dev@innobox.innovate e-mail, and platform-admin flag so INNOBOX_DEV_AUTH sign-in is a one-click submit.",
  },
  {
    version: "0.3.0",
    date: "2026-07-08",
    summary:
      "Phase 1 identity complete: Microsoft Entra OIDC sign-in, SCIM 2.0 provisioning with Entra reconciliation, per-request RBAC (no token claims), namespace administration, and soft-delete audit trail.",
  },
  {
    version: "0.2.0",
    date: "2026-07-08",
    summary:
      "The InnoBox web app is born: a fully branded app shell with light & dark themes, the What's new page, platform health endpoints, and the append-only audit foundation in the database.",
  },
  {
    version: "0.1.0",
    date: "2026-07-08",
    summary:
      "Project scaffolded from the starter kit: specification, brand foundation, deploy stack, CI pipelines, and the identity & e-mail groundwork.",
  },
];
