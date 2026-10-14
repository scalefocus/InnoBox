// The four §24 public routes' logic (INNOBOX_SPEC.md §24.4, §24.9), with their dependencies
// injected so the whole decision tree is unit-testable without a database or a server. Rules
// shared by all four:
//   - while the form is not live, every method answers 404 — the feature cannot be discovered;
//   - per-IP token buckets (the TRUST_PROXY-selected address, like the CSP sink), 429 with
//     Retry-After;
//   - bodies capped at 64 KB, JSON only (the Origin check runs in the middleware);
//   - never a session read, never the system log, never the audit log — only the
//     innobox_public_submissions_total counter records what happened.
// The handlers never throw: a database failure is a 500 with a fixed message.
import {
  PUBLIC_BODY_MAX_BYTES,
  isConfirmTokenShape,
  issuePowChallenge,
  parsePowSolution,
  silentDrop,
  validatePublicSubmission,
  validateVisibilityRequest,
  verifyPowSolution,
  type PublicSubmissionFields,
  type VisibilityRequest,
} from "@innobox/shared";
import { readJsonObject } from "../../../lib/http";
import { takeToken, type RateLimitBucket } from "../../../lib/rate-limit";
import { countPublicSubmission, publicNotFound } from "../../../lib/public-intake";
import type { ConfirmResult, ReceiveResult } from "./store";

/** What the store receives: the form's fields plus the §24.3 *Who should see this?* request. */
export type ReceivedSubmission = PublicSubmissionFields & { request: VisibilityRequest };

export interface PublicRouteDeps {
  /** Whether the form is live, and its notice. */
  state: () => Promise<{ live: boolean; privacyNotice: string }>;
  /** PUBLIC_INTAKE_KEY (non-null whenever `live`). */
  key: () => Buffer | null;
  /** The TRUST_PROXY-selected client address, null when none. */
  clientIp: string | null;
  now?: () => number;
  receive: (fields: ReceivedSubmission, powSalt: string) => Promise<ReceiveResult>;
  confirm: (token: string) => Promise<ConfirmResult>;
  /** The dev/e2e seam: include the confirmation token in the 202. */
  exposeDevToken?: boolean;
}

export const VERIFICATION_FAILED = "Verification failed — reload the page and try again.";
export const LINK_INVALID = "This link is invalid or has expired.";
const TOO_MANY = "Too many requests — try again later.";

const NO_STORE = { "cache-control": "no-store" };

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function ipLimited(deps: PublicRouteDeps, bucket: RateLimitBucket): Response | null {
  const decision = takeToken(deps.clientIp ?? "unknown", bucket, (deps.now ?? Date.now)());
  if (decision.ok) return null;
  countPublicSubmission("ip_limited");
  return json({ error: TOO_MANY }, 429, { "Retry-After": String(decision.retryAfterSeconds) });
}

async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "public submission route failed", error: String(err) }));
    return json({ error: "Something went wrong — try again later." }, 500);
  }
}

/** GET /api/public/settings → { privacyNotice } — the only application data the form reads. */
export function handlePublicSettings(deps: PublicRouteDeps): Promise<Response> {
  return guarded(async () => {
    const state = await deps.state();
    if (!state.live) return publicNotFound();
    return ipLimited(deps, "public-read") ?? json({ privacyNotice: state.privacyNotice }, 200);
  });
}

/** GET /api/public/pow → a fresh proof-of-work challenge. */
export function handlePublicPow(deps: PublicRouteDeps): Promise<Response> {
  return guarded(async () => {
    const state = await deps.state();
    const key = deps.key();
    if (!state.live || !key) return publicNotFound();
    return ipLimited(deps, "public-read") ?? json(issuePowChallenge(key, (deps.now ?? Date.now)()), 200);
  });
}

/** POST /api/public/submissions → 202, or 400/413/415/422 (body and fields), 403 (proof-of-work),
 *  429 (limits). The honeypot, the timing check and the per-address cap answer the same 202 as a
 *  real submission and store nothing. */
export function handlePublicSubmission(req: Request, deps: PublicRouteDeps): Promise<Response> {
  return guarded(async () => {
    const state = await deps.state();
    const key = deps.key();
    if (!state.live || !key) return publicNotFound();
    const limited = ipLimited(deps, "public-submit");
    if (limited) return limited;

    const read = await readJsonObject(req, PUBLIC_BODY_MAX_BYTES);
    if (!read.ok) return read.response;
    const fields = validatePublicSubmission(read.value);
    if (!fields.ok) return json({ error: fields.error }, 422);
    // §24.3: the visibility request — only a request, which the admin settles on accept.
    const request = validateVisibilityRequest(read.value);
    if (!request.ok) return json({ error: request.error }, 422);

    const now = (deps.now ?? Date.now)();
    const pow = parsePowSolution(read.value.pow);
    const verdict = pow ? verifyPowSolution(key, pow, now) : null;
    if (!pow || !verdict || !verdict.ok) {
      countPublicSubmission("pow_failed");
      return json({ error: VERIFICATION_FAILED }, 403);
    }

    const accepted = json({ ok: true }, 202);
    const drop = silentDrop({ honeypot: fields.value.honeypot, issuedAtMs: verdict.issuedAtMs, nowMs: now });
    if (drop) {
      countPublicSubmission(drop);
      return accepted;
    }

    const result = await deps.receive({ ...fields.value, request: request.value }, pow.salt);
    switch (result.status) {
      case "spent":
        countPublicSubmission("pow_failed");
        return json({ error: VERIFICATION_FAILED }, 403);
      case "address_capped":
        countPublicSubmission("address_capped");
        return accepted;
      case "ceiling":
        countPublicSubmission("ceiling");
        return json({ error: TOO_MANY }, 429, { "Retry-After": "3600" });
      case "received":
        countPublicSubmission("received");
        return deps.exposeDevToken ? json({ ok: true, devConfirmToken: result.token }, 202) : accepted;
    }
  });
}

/** POST /api/public/confirm { token } → 200, or 410 for anything unknown, expired or used. */
export function handlePublicConfirm(req: Request, deps: PublicRouteDeps): Promise<Response> {
  return guarded(async () => {
    const state = await deps.state();
    if (!state.live) return publicNotFound();
    const limited = ipLimited(deps, "public-confirm");
    if (limited) return limited;

    const read = await readJsonObject(req, PUBLIC_BODY_MAX_BYTES);
    if (!read.ok) return read.response;
    const token = read.value.token;
    if (!isConfirmTokenShape(token)) return json({ error: LINK_INVALID }, 410);
    const result = await deps.confirm(token);
    if (result.status !== "confirmed") return json({ error: LINK_INVALID }, 410);
    countPublicSubmission("confirmed");
    return json({ ok: true }, 200);
  });
}

/** Any other method: 404 while the form is off (nothing to discover), else 405. */
export function handlePublicMethodNotAllowed(deps: Pick<PublicRouteDeps, "state">, allow: string): Promise<Response> {
  return guarded(async () => {
    if (!(await deps.state()).live) return publicNotFound();
    return json({ error: "method not allowed" }, 405, { Allow: allow });
  });
}
