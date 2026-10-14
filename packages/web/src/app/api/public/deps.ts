// The production wiring of the §24 public routes' dependencies (INNOBOX_SPEC.md §24.4): the live
// state, the key, the TRUST_PROXY-selected client address and the store. Each route file stays a
// one-liner over app/api/public/handlers.ts. Not wrapped in withSystemLog: an unauthenticated route
// must not be a write path into the system log (§14.7), like the CSP sink.
import { clientIpFromForwardedFor, parseTrustProxy, rateLimitIpKey } from "@/lib/client-ip";
import { pool } from "@/lib/db";
import { publicIntakeKey } from "@/lib/public-intake";
import { loadPublicIntakeState, publicIntakeSeamEnabled } from "@/lib/public-intake-live";
import type { PublicRouteDeps } from "./handlers";
import { confirmSubmission, receiveSubmission } from "./store";

/** TRUST_PROXY, with the worker's semantics; compose passes the same value to web and worker. */
const TRUST = parseTrustProxy(process.env.TRUST_PROXY);

export function publicRouteDeps(req: Request): PublicRouteDeps {
  return {
    state: loadPublicIntakeState,
    key: publicIntakeKey,
    clientIp: rateLimitIpKey(clientIpFromForwardedFor(req.headers.get("x-forwarded-for"), TRUST)),
    receive: (fields, salt) => receiveSubmission(pool, fields, salt),
    confirm: (token) => confirmSubmission(pool, token),
    exposeDevToken: publicIntakeSeamEnabled(),
  };
}
