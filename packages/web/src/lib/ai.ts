// The web tier's binding of the §22 AI helper (INNOBOX_SPEC.md §22.6): the AI_TOKEN_ENC_KEY parse,
// the non-production localhost allowance, and the shared client bound to the web pool with
// `source = web`. Tasks call `webAi().complete(...)` / `webAi().available(...)`; the browser never
// talks to the provider.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import { aiAllowedPrivateHosts, aiLocalhostAllowed, createAiClient, parseAiKey, type AiClient, type AiTransportDeps } from "@innobox/shared/ai";
import { pool } from "./db";

/** AI_TOKEN_ENC_KEY parsed afresh (cheap) — null when unset/invalid: the provider form is off. */
export function aiKey(): Buffer | null {
  return parseAiKey(process.env.AI_TOKEN_ENC_KEY);
}

/** The transport options for this process: http://localhost only outside production, and the
 *  operator's AI_ALLOWED_PRIVATE_HOSTS (§22.2) — read afresh, like the key. */
export function aiTransport(): AiTransportDeps {
  return {
    allowLocalhost: aiLocalhostAllowed(process.env.NODE_ENV),
    allowedPrivateHosts: aiAllowedPrivateHosts(process.env.AI_ALLOWED_PRIVATE_HOSTS).hosts,
  };
}

export function webAi(): AiClient {
  return createAiClient({ db: pool, key: aiKey(), source: "web", transport: aiTransport() });
}
