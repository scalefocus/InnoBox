# InnoBox performance audit — 2026-10-21

Read-only analysis of the web tier, database access layer, worker, and client bundle.
Every finding below was checked against the source; line numbers are as of commit `8be26ea`.
Nothing here is implemented — each item is a candidate change that goes through the
spec gate (CLAUDE.md) before any code lands.

## How to read the priorities

- **P1** — scales badly with data or users and is on a hot path (every request, every poll).
- **P2** — measurable waste on a common path; fix when touching the area.
- **P3** — small, cheap, or admin-only.

The short version: the app does little per page server-side (nearly every page is a client
component), so the real cost is in **how many API calls a page makes × what each call costs**.
Three things dominate: the per-call auth queries, the three 30-second pollers per tab, and a
notifications query that cannot use an index.

---

## P1 — fix first

### 1. Notification inbox and unread count scan every challenge per notification row
`packages/web/src/app/api/notifications/store.ts:32-73`

The visibility gate and the trash filter are correlated `not exists` subqueries over
`challenges` whose join predicate casts the indexed side:

```sql
c.id::text = n.payload->>'challengeId'
s.id::text = n.payload->>'parentId'
```

The primary-key index cannot be used, so for each of the viewer's notification rows Postgres
scans all challenges. `getInbox` evaluates it twice (list and unread count), `markAllRead` a
third time. The bell polls this every 30 s per open tab, and nothing ever purges
`notifications` (only the item-delete cascade removes rows), so per-user row counts grow
without bound. Cost ≈ notifications-per-user × challenges, per tab, every 30 s. This is the
query most likely to become the dominant steady-state DB load.

**Fix:** flip the casts so the index applies —
`c.id = (n.payload->>'challengeId')::uuid`, `s.id = (n.payload->>'parentId')::uuid`,
`tc.number = (…)::bigint` for the link form. Better: add a real `notifications.challenge_id`
column written at dispatch, backfilled from the payload, indexed `(user_id, challenge_id)`.
Get the unread count from the list query with `count(*) filter (where read_at is null) over()`
instead of a second full evaluation. Consider a retention purge for read rows older than N days.

### 2. Three 30-second pollers per tab, each re-running full auth, never pausing when hidden
`packages/web/src/components/NotificationBell.tsx:36-47`,
`packages/web/src/components/AppShell.tsx:440-450, 465-476`

`/api/notifications`, `/api/challenges/new-count`, and (admins) `/api/admin/triage/attention`
each poll on their own 30 s interval. There is no `visibilitychange` handling anywhere in
`src` — background tabs keep polling forever. Each call pays the 3–4 auth queries from
finding 3 before its own work: 9–12 auth queries + 3 payload queries per tab per 30 s.
A hundred open tabs is 400–600 requests per minute at idle. Each bell tick also sets a fresh
array/object into shell state, re-rendering the shell tree every 30 s.

**Fix:** one shell-level poller against one endpoint returning
`{ unreadCount, newChallenges, attention, banner }`; fetch the bell list only when opened;
stop on `document.visibilityState === "hidden"` and refetch on return; back off to 2–5 min
after idle ticks; compare values before `setState` so unchanged ticks do not re-render.

### 3. `getSessionUser` is 3–4 sequential round trips, repeated on every API call
`packages/web/src/lib/auth.ts:48-96, 123-171`

Per call: users row by `external_id` → group/role-mapping grants → (bootstrap admin group,
when configured) → `challenge_access`. All awaited in sequence, no per-request memo, 132 call
sites. A `/challenges` page load runs it 4–5 times (`/api/me`, `/api/notifications`,
`/api/challenges`, `new-count`, `attention`), resolving the same roles each time. Roughly
40–50 % of all queries the app issues are this.

**Fix (spec-neutral):** fold the three role queries into one statement (CTEs returning arrays,
or `left join lateral`), or at minimum run them with `Promise.all` after the user row. The
"roles from SCIM groups, never claims" invariant is untouched; this is the same data in fewer
hops. A short per-user role cache would remove most of the rest, but the spec currently rules
that out — a spec decision, not an implementation one.

### 4. Global advisory lock in the audit-chain trigger serializes every write, and transactions do a lot of work after taking it
`db/migrations/0028_audit_chain.sql` (`audit_log_chain()`),
`packages/web/src/app/api/challenges/store.ts:1318-1395` and other write paths

The trigger takes `pg_advisory_xact_lock(hashtextextended('innobox:audit_log_chain', 0))`,
held until COMMIT, so at most one audit-writing transaction is in flight platform-wide (web
and worker). That is by design for the hash chain. The problem is lock *scope*: write paths
call `appendAudit` early and keep going. `setSolutionStatus` writes its first audit row, then
runs awards, the sibling-close loop (one audit each), `writeLiveAwards` (per recipient:
advisory lock, points, daily-cap count, badge checks, achievement notification), webhook
enqueue, and finally `fetchSolutionRows` — 20–40 round trips under the global lock.
`createChallenge`, `toggleLike`, `giveHype`, `createComment` follow the same shape.
`bulkSetStatus` with `BULK_CONCURRENCY = 10` just queues ten connections on the lock.

**Fix:** make `appendAudit` the last statement of each transaction and move the post-write
refetches (`CHALLENGE_SELECT`, `fetchSolutionRows`, attachment lists) outside it. The
structural fix (sequence-allocated `chain_seq`, hashing off the critical path) is a spec change.

### 5. `/api/me` issues roughly 23 queries, twelve of them `platform_settings` point reads
`packages/web/src/app/api/me/route.ts:30-43`, `api/me/survey/store.ts:171-190`

A 10-wide `Promise.all` (date format, AI display-name setting, open survey, self survey, bug
reports, gamification, new achievements, MCP settings, live connection, hype enabled) followed
by a serial hype-budget read. Several readers re-read the users row or the same settings keys.
On the default 10-connection pool, one `/api/me` monopolises the pool for its duration, and it
runs on every full page load.

**Fix:** one `select key, value from platform_settings where key = any($1)` for all keys,
passed into the readers; widen the `getSessionUser` select to carry the survey and
achievement columns; move the hype budget into the parallel block and compute "now" in SQL.
Target ≤ 6 queries.

### 6. Worker: outbox, digest, and scan sweeps can overlap and claim no rows
`packages/worker/src/index.ts:346-347, 364-365`,
`packages/worker/src/notifications/dispatch.ts:194`

Webhook delivery and triage assist have a `running` guard; the e-mail outbox, digest, and
ClamAV sweeps do not, and the outbox SELECT neither locks nor marks rows. A sweep of 50 rows
with Graph at its 15 s timeout can run 12 minutes; every 30 s a new sweep re-selects the same
still-`pending` rows and sends them again. Zero cost at idle; at the first Graph slowdown,
duplicate e-mails scale with sweep time ÷ 30 s. The scan sweep similarly re-streams a large
object to clamd when a scan exceeds 15 s (the DB write is idempotent, the S3 egress and CPU
are not).

**Fix:** add the `running` guard to all three; claim rows with
`update … set status='sending', locked_at=now() where id in (select … for update skip locked) returning *`
(needs a `locked_at` column and a reclaim rule for stale locks).

---

## P2 — measurable waste on common paths

### 7. Challenge detail: N+1 attachments query plus five serial steps
`api/challenges/store.ts:600-613`, `api/challenges/[number]/route.ts:24-39`

`buildDetailWithAttachments` runs `listAttachmentsForParent` once per solution in a `for`
loop, then once for the challenge, then `listAccessEntries`. The route then awaits the
mark-read UPDATE, the hype switch, and `dbNow` in sequence. Total ≈ 12 + N round trips.
**Fix:** one attachments query with `parent_id = any($1::uuid[])` grouped in JS; run the
mark-read UPDATE, hype switch, and detail fetch in parallel; use `now()` in SQL.

### 8. Challenge detail page: fetch waterfall, N+1 comment requests, full re-read per micro-action
`packages/web/src/app/challenges/[number]/page.tsx:170-191, 239-287, 675, 992`,
`components/CommentThread.tsx:81-91`

The page is a client component that fetches the detail on mount; each `CommentThread`
(one for the challenge, one per solution) then fetches `/api/comments` on mount — 1 + N
requests that start only after the detail renders. Like, hype, and follow each trigger a full
detail refetch. The `[number]` effect has no abort, so a quick CH-1 → CH-2 navigation can
commit CH-1's late response.
**Fix:** include comments in the detail payload or batch them; have like/hype/follow return
new counts and patch state locally; abort on route change. Consider a server component for
the first paint.

### 9. Attachment scan poll re-reads the whole challenge every 4 seconds
`components/AttachmentControl.tsx:72, 143-146, 179`

In bound mode, `refresh` calls `boundOnChanged`, which on the detail page is a full
`GET /api/challenges/:n`. Fifteen full-detail reads per minute per pending file per open
control, for as long as ClamAV is slow or down.
**Fix:** poll a status-only endpoint (`/api/attachments/:id`) and patch the row; back off
4 → 8 → 16 s and stop after a few minutes.

### 10. `CHALLENGE_SELECT` carries seven correlated subqueries per row and the full description into list views
`api/challenges/store.ts:311-335`, sort at `:879-890`

`like_count`, `liked_by_viewer`, `followed_by_viewer`, `solution_count`, `is_new` (a
per-row users lookup for the viewer's own `challenges_seen_at`), `featured_by_name`,
`trashed_by_name`, plus `c.description` and contact columns, for the gallery (limit 100),
search (with OFFSET), and featured. With a count-based sort the subquery is the ORDER BY key,
so it is evaluated for every visible challenge before the top-100 sort; `most_hyped` adds a
`sum(weight)` subquery per row and then `withHypePoints` re-queries hype for the same ids.
**Fix:** a `CHALLENGE_LIST_SELECT` without body/contact/trash columns; pass
`challenges_seen_at` as a parameter from the session user; fold hype into the select when on;
longer term, maintained `like_count` / `solution_count` columns updated in the transactions
that already audit those changes (then the sorts are indexable).

### 11. Triage queue evaluates the hype subquery for every matching row before paging
`api/admin/triage/store.ts:156-169, 200-207, 456-471`

`hype_points` sits in the inner select; with `count(*) over()` and OFFSET, it runs for all
challenges in the admin's namespaces per page, hype on or off.
**Fix:** attach hype only to the returned page; skip when hype is off; add
`challenges (namespace_id, created_at desc) where trashed_at is null`.

### 12. Worker: one Graph token transaction and one SMTP connection per e-mail
`worker/src/notifications/dispatch.ts:94-101, 149`, `shared/src/email-graph.ts:95-110`

`ensureFreshAccessToken` per row = connect, BEGIN, `select … for update`, COMMIT; a fresh
nodemailer transport per message. At 50 rows per tick that is ~250 DB round trips and 50 TLS
handshakes per sweep, serial.
**Fix:** resolve the token once per sweep (refresh only on 401), one pooled transport per
sweep, bounded concurrency (~5) keeping the 429 early exit.

### 13. Worker: digest sweep is O(users × held rows) serial queries
`worker/src/notifications/digest.ts:363, 440-513`

Per due recipient: held rows, user row, role resolution (4 queries including a constant
global-namespace lookup), then one `isVisibleTo` query **per held row**, then updates and a
Graph send with its own token transaction. 500 daily-digest users × 10 rows ≈ 9,000 queries
plus 500 serial sends at 06:00 UTC, with the overlap bug from finding 6 on top.
**Fix:** one query for all due users' rows, bulk role resolution (`resolveRoles.many` already
exists on the web side), parent visibility by `id = any($1)`, concurrency 3–5.

### 14. SCIM group membership writes are one round trip per member
`worker/src/scim/router.ts:417-427, 450-459, 735-736`

`addMembersTolerantly` does `userExists` + `addGroupMember` per id; removal is one DELETE per
member; neither is in a transaction, so a mid-way failure leaves a half-applied roster while
Entra retries the whole request. A PUT of a 500-member group ≈ 1,000 sequential round trips.
`GET /Groups` fans out one `listGroupMemberIds` per group in an unbounded `Promise.all`
(up to 200 → bursts past the 10-connection pool).
**Fix:** set-based `insert … select from users where id = any($2) … on conflict do nothing
returning user_id` (unknown = input minus returned), `delete … where user_id = any($2)`,
wrapped in `atomically`; one `select group_id, user_id … where group_id = any($1)` for lists.

### 15. Entra reconciliation: two serial Graph calls per active user, hourly, no overlap guard
`worker/src/recon/reconcile.ts:103, 174, 290`, `index.ts:385`

`getUser` + photo metadata per user, sequential, 15 s timeout each, no 429 backoff; a
per-oid `select` per membership add. 2,000 users ≈ 4,000 serial Graph calls ≈ 10+ min/hour,
and a pass longer than an hour overlaps the next.
**Fix:** `running` guard; `/users/delta` or `$batch`; bounded concurrency for photo checks;
load local users once into a Map.

### 16. Chunked upload is strictly serial
`lib/chunked-upload.ts:138-143`, `components/AttachmentControl.tsx:71`

One 5 MB part at a time: a 200 MB file is 40 sequential PUTs, each paying connection ramp-up
on a high-RTT VPN. The server already accepts parts independently.
**Fix:** 2–3 parts in flight with ordered progress.

### 17. Webhook delivery: serial with 10 s timeout per row → head-of-line blocking
`worker/src/webhooks/deliver.ts:127-210`, `shared/src/webhook-send.ts:204`

One dead receiver with 50 queued rows holds the sweep for 8+ minutes; every other webhook
waits. `keepAlive: false` means a fresh DNS + TLS per row.
**Fix:** group the batch by `webhook_id`, run webhooks concurrently (limit ~5), rows serial
within a webhook; after a timeout/5xx, skip that webhook's remaining rows this sweep.

### 18. Pool sizing and timeouts
`packages/web/src/lib/db.ts:15`, `packages/worker/src/index.ts:100`

Both pools use the pg defaults: `max` 10, no `statement_timeout`, no
`idle_in_transaction_session_timeout`. Finding 5's 10-wide burst plus a few concurrent API
calls already queues on the web pool; symptoms are random latency, not errors. The worker
pool serves SCIM HTTP and every sweep, so a SCIM group-list burst can stall `/readyz`'s
`select 1`. Postgres itself runs with image defaults (no `shared_buffers` or
`work_mem` tuning in `deploy/docker-compose.yml`).
**Fix:** set `max` explicitly (20–30 web, 10–15 worker), a `statement_timeout` (e.g. 30 s)
and `idle_in_transaction_session_timeout` on the app role, and a basic Postgres config for the
host's RAM. Reduce the bursts via findings 3 and 5.

---

## P3 — small, cheap, or admin-only

19. **Shell cluster on every route** — `layout.tsx:81-85`, `AppShell.tsx` (1014 lines):
    ≈546 KB uncompressed JS before any page code (react-dom + Next runtime 433 KB, next-auth
    client 40 KB, shell 35 KB + 38 KB). Survey, bug-report, What's-new, and achievement
    machinery could be a lazily imported `ShellExtras`. `SessionProvider` refetches
    `/api/auth/session` on every window focus (`refetchOnWindowFocus` default) while the app
    already polls; `DateFormat.tsx:22-33` fires `/api/me` before the session resolves (a 401
    on the signed-out home).
20. **Unused dependencies** — the five `@tiptap/*` packages in `packages/web/package.json`
    have zero imports in `src` (13 MB in the install, nothing in the bundle). JetBrains Mono
    is loaded in `layout.tsx` but `--font-mono` is used only by dead `.dropzone-hint` /
    `.code-cmd` rules.
21. **Dead CSS from the starter kit** — `globals.css` (123 KB source, 79 KB built, every
    route): ~99 class names never referenced (`skill-row*`, `rating-hist*`, `install-*`,
    `md-*`, `dropzone-*`, `filepick-*`, `taginput-*`, `facet*`, `metric-strip`, …). This is
    the Phase 4 pruning CLAUDE.md mentions, still pending. ~3 KB gzipped.
22. **`listComments` is 4 serial round trips** — `api/comments/store.ts:105-110`:
    `getParentAccess` already reads `namespace_id`; `getParentNamespaceId` re-queries it;
    `committeeMemberIds` can run alongside the list.
23. **Dashboard runs its two KPI aggregates serially before its parallel block** —
    `api/dashboard/store.ts:76-93, 144-150`. Four stages → two.
24. **`markCommentNotificationsReadForChallenge` matches no partial index** —
    `lib/notify.ts:353-359`: `type in ('comment_posted','hyped')` implies neither of the
    single-type partial indexes from 0026/0050, so each challenge open filters all the user's
    rows. One partial index on `(user_id, (payload->>'challengeId')) where read_at is null and
    type in (…)`.
25. **Index gaps and one redundant index** — no `challenges (created_at desc) where
    trashed_at is null` for the gallery's default order; `solutions (challenge_id,
    created_at)` would replace `solutions_challenge_idx` for the always-ordered
    `fetchSolutionRows`; `attachments_scan_status_idx` (0012) is a strict prefix of
    `attachments_scan_status_next_idx` (0021) and can be dropped.
26. **Audit browser search** — `api/admin/audit/store.ts:75-86, 122`: ILIKE over an
    expression containing correlated subqueries with `c.id::text = a.target_id`; each
    candidate audit row scans `challenges`. Cast the other side inside the type-guarded CASE
    branches; pre-parse `CH-12` / `SOL-34` queries into id lookups.
27. **Write paths load every sibling solution to return one** —
    `api/challenges/store.ts:1099, 1390, 2006`: `fetchSolutionRows(...).find(...)` inside the
    transaction (under the audit lock). A single-row variant.
28. **Coalesced comment/hype dispatch is two queries per recipient, serial** —
    `lib/notify.ts:308-347, 406-440`. One multi-row upsert with `returning (xmax = 0)` and
    one multi-row outbox insert, as `writeNotifications` already does.
29. **Leaderboard cold cache** — `lib/gamification-read.ts:101-110`: ten `(metric, window)`
    boards computed sequentially on a cold 30 s cache; `likes_received` scans all `likes` with
    no `likes (created_at)` index for the 30-day window. `Promise.all` + the index.
30. **Admin console** — `admin/page.tsx:77-250`: eight cards each fetching on mount;
    `CurrentlyOnline.tsx:103, 112` fetches both the window and the full history regardless of
    the selected range. One overview endpoint; history for the visible range only.
31. **`withSystemLog` amplifies 4xx cost** — `lib/system-log-core.ts:95-150`: on recorded
    error statuses it clones and parses the body, re-reads the session, and queries the actor
    and anonymity target. Pass the already-resolved user; skip the anonymity check on 401/403.
32. **Triage assist throughput** — `worker/src/ai/triage.ts:295`: batch of 3, serial, per
    minute → ≤180 challenges/hour; enabling it on a 1,000-item backlog takes ~6 h.
    `api/ai/similar.ts:54` has no content-hash cache, unlike summary and triage.
33. **ClamAV scan wall-clock cap** — `worker/src/attachments/scan.ts`: the 180 s socket
    timeout is an idle timeout; a clamd that keeps reading but never answers can hold the
    sweep indefinitely. Streaming itself is correct (64 KB frames, backpressure, no buffering).
34. **Minor client** — `TopbarSearch.tsx:57-58` and `challenges/page.tsx:79-95` lack
    `AbortController` (out-of-order responses on fast typing / filter changes); the `✕`
    glyph in the shell pulls Open Sans' 26 KB symbols subset (use an SVG).

---

## Verified clean (no action)

- ECharts is `echarts/core` with tree-shaken modules, loaded via dynamic import only on
  `/admin` (591 KB chunk behind a 1 KB loader).
- `@aws-sdk/client-s3` is server-only; `@modelcontextprotocol/sdk` is test-only.
- Avatar photos ship `Cache-Control: private, max-age=3600` with ETag/304.
- `cachedGet` dedupes `/api/me` across the shell, date provider, and pages.
- Triage, audit, and system-log lists are paginated; the gallery is capped at 100.
- Middleware does no DB work (JWT verify + nonce only).
- Rate limiter is a bounded LRU (50,000 keys); presence throttle map self-sweeps.
- Search uses the GIN tsvector indexes with the visibility predicate inside the candidate limit.
- Notification fan-out (`writeNotifications`) is batched; recipient roles resolve in bulk.
- ClamAV streaming, MinIO puts, and the ClamAV probe run outside transactions.
- Presence rollup is incremental and bounded to a 3-day window.
- Webhook retry schedule honours `Retry-After`; no retry storms.

## Suggested order of work

1. Findings 1 + 2 + 3 together (one spec change: "pulse" endpoint, visibility-gated polling,
   indexable notification predicates, single-statement role resolution). This removes most of
   the steady-state load.
2. Finding 6 (worker sweep guards + row claims) — a correctness issue as much as performance.
3. Findings 4, 5, 7, 10 (audit-lock scope, `/api/me`, detail N+1, list select).
4. Findings 12–15 (worker throughput) when e-mail volume, digests, or SCIM group sizes grow.
5. P3 items opportunistically, in the commits that touch those files.
