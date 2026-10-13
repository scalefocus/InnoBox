// The node-layer half of "is the public form live" (INNOBOX_SPEC.md §24.2): the switch, the
// privacy notice, PUBLIC_INTAKE_KEY and an available e-mail transport (Graph connected with a
// saved wrapper, or the SMTP fallback). Read per request by the public pages and routes, so a
// precondition that stops holding (the key removed, the mailbox disconnected) takes the form
// down at once — 404 until it is fixed — while the review queue keeps working.
import { pool } from "./db";
import { getEmailChannelStatus } from "./email";
import { getPublicIntakeState, type PublicIntakeState } from "./public-intake";

/** True while some transport can deliver the confirmation e-mail. */
export async function emailTransportAvailable(): Promise<boolean> {
  return (await getEmailChannelStatus()).pill !== "down";
}

export function loadPublicIntakeState(): Promise<PublicIntakeState> {
  return getPublicIntakeState(pool, emailTransportAvailable);
}

/** The dev/e2e seam (like the survey's, lib/survey-dev.ts): the e2e has no mailbox to read the
 *  confirmation link from, so while INNOBOX_DEV_AUTH=1 in a non-production build the 202 carries the
 *  token too. A production build never does, whatever the environment says. */
export function publicIntakeSeamEnabled(env: { NODE_ENV?: string; INNOBOX_DEV_AUTH?: string } = process.env): boolean {
  return env.INNOBOX_DEV_AUTH === "1" && env.NODE_ENV !== "production";
}
