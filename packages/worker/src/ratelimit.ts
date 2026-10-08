// The worker's rate-limit middleware (INNOBOX_SPEC.md §2.4 "SCIM rate limiting"): keyed per client IP,
// mounted on the SCIM endpoints only — /healthz, /readyz and /metrics are exempt so probe and
// scrape cadence can never be throttled. Behind the proxy, Express's `trust proxy` (TRUST_PROXY)
// decides which forwarded address counts as the client, so the real caller is keyed, never the
// proxy. A denied request answers 429 in the SCIM error envelope with Retry-After.
import type { NextFunction, Request, Response } from "express";
import { SCIM_RATE_LIMIT, SlidingWindowLimiter, resolveRateLimitMultiplier, scaleRule, type RateLimitRule } from "@innobox/shared";
import { scimError } from "./scim/resources.js";

export interface RateLimitMiddlewareOptions {
  rule?: RateLimitRule;
  /** Injected for tests; defaults to a fresh process-wide limiter. */
  limiter?: SlidingWindowLimiter;
  /** Defaults to RATE_LIMIT_MULTIPLIER resolved against NODE_ENV (production → 1). */
  multiplier?: number;
}

export function createScimRateLimit(opts: RateLimitMiddlewareOptions = {}) {
  const limiter = opts.limiter ?? new SlidingWindowLimiter();
  const multiplier = opts.multiplier ?? resolveRateLimitMultiplier(process.env.RATE_LIMIT_MULTIPLIER, process.env.NODE_ENV);
  const rule = scaleRule(opts.rule ?? SCIM_RATE_LIMIT, multiplier);

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const decision = limiter.check(key, rule);
    if (decision.allowed) {
      next();
      return;
    }
    res
      .status(429)
      .set("Retry-After", String(decision.retryAfterSeconds))
      .json(scimError(429, "Too many requests"));
  };
}

/** Parses the TRUST_PROXY env (deploy/.env.example): a hop count, true/false, a preset such as
 *  "loopback", or a comma-separated subnet list. Unset → X-Forwarded-For is not trusted. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw.trim() === "") return false;
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}
