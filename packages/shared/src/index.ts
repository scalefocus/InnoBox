// @innobox/shared — SERVER-SIDE domain barrel: types, RBAC resolution, state machines,
// validation, and the e-mail engine (INNOBOX_SPEC.md §2, §12). This root import may pull
// in node-only code (node:crypto via the e-mail engine), so CLIENT components must import
// the client-safe subpaths instead — e.g. `@innobox/shared/version`.
//
// Phase 0 scaffolding: add domain modules (challenges, solutions, state machines, RBAC,
// validation, anonymity masking) to this barrel as they are implemented.
export { APP_VERSION } from "./version.js";

// Bundled e-mail engine carried over from a proven sibling project (INNOBOX_SPEC.md §12):
// crypto + Graph transport (also exposed at the `@innobox/shared/email` subpath) and the
// HTML wrapper templating (renderEmailText, renderWrappedEmailHtml, validateWrapperHtml, …).
export * from "./email.js";
export * from "./email-template.js";

// Phase 1 identity (ENTRA_AUTH_SPEC.md §5): layer-3 RBAC resolution and the shared
// append-only audit writer (packages/web/src/lib/audit.ts re-exports the latter).
export * from "./rbac.js";
export * from "./audit.js";

// Phase 2 first slice (INNOBOX_SPEC.md §13.1): challenge/solution status vocab,
// validation, anonymity masking, visibility gates, and the §8.3 single-winner gate.
export * from "./challenges.js";

// Phase 3 (INNOBOX_SPEC.md §10.2, §12, §7.3): comments, notifications, assignment.
export * from "./social.js";

// §11 attachments: content-type allowlist, object-key builder, ClamAV INSTREAM protocol,
// and the anonymity-safe client projection (invariant 3). Pure — storage/socket/DB live in
// the web store and worker sweep.
export * from "./attachments.js";

// Phase 4 (INNOBOX_SPEC.md §13.2-§13.4, §14.1, §14.3): dashboard/leaderboard vocab,
// platform date-format setting, CSV export escaping.
export * from "./discovery.js";

// §2 observability: pure Prometheus text-exposition helpers + the /metrics bearer-token gate,
// used by the web /metrics route and the worker /metrics handler.
export * from "./metrics.js";

// §3.1/§13.6 avatars: pure initials + deterministic fallback-color helpers (also exposed at the
// client-safe `@innobox/shared/avatars` subpath for the <AvatarBubble> component).
export * from "./avatars.js";

// §2.4 rate limiting: the worker's SCIM per-IP rule + the pure sliding-window limiter, and the
// RATE_LIMIT_MULTIPLIER resolver the web tier's token buckets also honour.
export * from "./ratelimit.js";

// §14.7 system log: which statuses are recorded, message sanitizing, the status chips, and the
// entity-in-path extraction behind anonymity masking. DB access lives in each tier.
export * from "./system-log.js";

// §15 audit browser: category chips (action prefixes), page size and export cap. Client-safe,
// also exposed at `@innobox/shared/audit-browser`.
export * from "./audit-browser.js";

// §14.6 system banner: validation, the fixed durations, lazy-expiry check. Client-safe, also
// exposed at `@innobox/shared/system-banner`.
export * from "./system-banner.js";

// §12.1 per-event notification preferences: the three follower-event toggles, the mute, and the
// PATCH parser. Client-safe, also exposed at `@innobox/shared/notification-preferences`.
export * from "./notification-preferences.js";

// §14.10 identity sync diagnostics: the SCIM last-request settings key + throttle, and the pure
// explanation selection. Client-safe, also exposed at `@innobox/shared/identity-sync`.
export * from "./identity-sync.js";

// §15 audit hash chain: the canonical serialization v1, row-hash recomputation and the
// verification state machine behind "Verify integrity". Server-only (node:crypto).
export * from "./audit-chain.js";
