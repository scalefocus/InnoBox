// The node-layer half of "is the public form live" (INNOBOX_SPEC.md §24.2): the switch, the
// privacy notice, PUBLIC_INTAKE_KEY and an available e-mail transport (Graph connected with a
// saved wrapper, or the SMTP fallback). The public pages and routes read it through a 10-second
// in-process cache (§24.4 load shedding), so a flood costs no database read; a precondition that
// stops holding (the key removed, the mailbox disconnected) takes the form down within that time —
// 404 until it is fixed — while the review queue keeps working. Saving the settings card clears
// the cache, so the switch itself takes effect at once.
import { pool } from "./db";
import { getEmailChannelStatus } from "./email";
import { PUBLIC_STATE_CACHE_MS, createStateCache, getPublicIntakeState, type PublicIntakeState, type StateCache } from "./public-intake";

/** True while some transport can deliver the confirmation e-mail. */
export async function emailTransportAvailable(): Promise<boolean> {
  return (await getEmailChannelStatus()).pill !== "down";
}

/** The state read fresh from the database — for the settings card, which must show the truth. */
export function readPublicIntakeState(): Promise<PublicIntakeState> {
  return getPublicIntakeState(pool, emailTransportAvailable);
}

// On globalThis, like the submissions counter, so every route bundle shares one cache and the
// settings route clears the one the public routes read.
const CACHE_KEY = Symbol.for("innobox.publicIntakeStateCache");
type CacheHost = { [CACHE_KEY]?: StateCache<PublicIntakeState> };

function stateCache(): StateCache<PublicIntakeState> {
  const host = globalThis as CacheHost;
  return (host[CACHE_KEY] ??= createStateCache(readPublicIntakeState, PUBLIC_STATE_CACHE_MS));
}

/** The state as the public pages and routes see it: cached for 10 seconds. */
export function loadPublicIntakeState(): Promise<PublicIntakeState> {
  return stateCache().get();
}

/** Called after the settings card is saved, so the switch takes effect at once. */
export function invalidatePublicIntakeState(): void {
  stateCache().clear();
}

/** The dev/e2e seam (like the survey's, lib/survey-dev.ts): the e2e has no mailbox to read the
 *  confirmation link from, so while INNOBOX_DEV_AUTH=1 in a non-production build the 202 carries the
 *  token too. A production build never does, whatever the environment says. */
export function publicIntakeSeamEnabled(env: { NODE_ENV?: string; INNOBOX_DEV_AUTH?: string } = process.env): boolean {
  return env.INNOBOX_DEV_AUTH === "1" && env.NODE_ENV !== "production";
}
