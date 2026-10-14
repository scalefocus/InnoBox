// The web tier's binding of the §24 public submission form (INNOBOX_SPEC.md §24.2, §24.4): the
// PUBLIC_INTAKE_KEY parse, the two platform settings, the "is the form live" decision every
// public route and page makes first, and the in-process innobox_public_submissions_total counter.
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { Pool, PoolClient } from "pg";
import { PUBLIC_SUBMISSION_OUTCOMES, parsePublicIntakeKey, type PublicSubmissionOutcome } from "@innobox/shared";

type Db = Pool | PoolClient;

export const PUBLIC_SUBMISSIONS_ENABLED_KEY = "public_submissions_enabled";
export const PUBLIC_PRIVACY_NOTICE_KEY = "public_privacy_notice";

/** PUBLIC_INTAKE_KEY parsed afresh (cheap) — null when unset/invalid (§2.3). */
export function publicIntakeKey(): Buffer | null {
  return parsePublicIntakeKey(process.env.PUBLIC_INTAKE_KEY);
}

export interface PublicIntakeSettings {
  enabled: boolean;
  privacyNotice: string;
}

/** The §24.2 switch (off by default) and the privacy notice (empty by default). */
export async function getPublicIntakeSettings(db: Db): Promise<PublicIntakeSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(`select key, value from platform_settings where key = any($1::text[])`, [
    [PUBLIC_SUBMISSIONS_ENABLED_KEY, PUBLIC_PRIVACY_NOTICE_KEY],
  ]);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const notice = byKey.get(PUBLIC_PRIVACY_NOTICE_KEY);
  return { enabled: byKey.get(PUBLIC_SUBMISSIONS_ENABLED_KEY) === true, privacyNotice: typeof notice === "string" ? notice : "" };
}

/** What the §24.2 switch needs, in the order the card names a missing one. */
export interface PublicIntakePreconditions {
  keyValid: boolean;
  noticeSet: boolean;
  transportAvailable: boolean;
}

export type MissingPrecondition = "key" | "notice" | "transport";

/** Every unmet precondition, in the fixed key → notice → transport order; empty when the switch
 *  may be on. The card lists them all so an admin can fix them in one pass. */
export function unmetPreconditions(p: PublicIntakePreconditions): MissingPrecondition[] {
  const unmet: MissingPrecondition[] = [];
  if (!p.keyValid) unmet.push("key");
  if (!p.noticeSet) unmet.push("notice");
  if (!p.transportAvailable) unmet.push("transport");
  return unmet;
}

/** The first missing precondition, or null when the switch may be on. */
export function missingPrecondition(p: PublicIntakePreconditions): MissingPrecondition | null {
  return unmetPreconditions(p)[0] ?? null;
}

/** The card's hint for a missing precondition (plain text, no section marks). */
export const PRECONDITION_HINT: Record<MissingPrecondition, string> = {
  key: "Set PUBLIC_INTAKE_KEY — a 32-byte base64 key — on the web service.",
  notice: "Enter a privacy notice first.",
  transport: "Connect the notification sender (or configure the SMTP fallback) first.",
};

/** One line of the card's unmet list: the precondition and its plain-text hint. */
export interface UnmetPrecondition {
  precondition: MissingPrecondition;
  hint: string;
}

/** The card's unmet list — every unmet precondition with its hint, in order. */
export function unmetPreconditionList(p: PublicIntakePreconditions): UnmetPrecondition[] {
  return unmetPreconditions(p).map((precondition) => ({ precondition, hint: PRECONDITION_HINT[precondition] }));
}

export interface PublicIntakeState extends PublicIntakeSettings, PublicIntakePreconditions {
  /** The switch is on AND every precondition holds: the public routes answer. */
  live: boolean;
}

/** The full state. `transportAvailable` is injected (the e-mail channel status needs the pool and
 *  the Graph env), so this stays testable without them. */
export async function getPublicIntakeState(db: Db, transportAvailable: () => Promise<boolean>): Promise<PublicIntakeState> {
  const settings = await getPublicIntakeSettings(db);
  const pre: PublicIntakePreconditions = {
    keyValid: publicIntakeKey() !== null,
    noticeSet: settings.privacyNotice.trim() !== "",
    transportAvailable: await transportAvailable(),
  };
  return { ...settings, ...pre, live: settings.enabled && missingPrecondition(pre) === null };
}

/** The answer every public route gives while the form is not live — indistinguishable from a
 *  route that does not exist (§24.2). */
export function publicNotFound(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}

// ── innobox_public_submissions_total{outcome} (§24.4) ────────────────────────────────────────
// In-process, like the CSP counter: the only record of unauthenticated traffic, which is never
// system-logged or audited. On globalThis so every route bundle and /metrics share one map.
const COUNTER_KEY = Symbol.for("innobox.publicSubmissionsTotal");
type CounterHost = { [COUNTER_KEY]?: Map<PublicSubmissionOutcome, number> };

function counter(): Map<PublicSubmissionOutcome, number> {
  const host = globalThis as CounterHost;
  return (host[COUNTER_KEY] ??= new Map());
}

export function countPublicSubmission(outcome: PublicSubmissionOutcome): void {
  const map = counter();
  map.set(outcome, (map.get(outcome) ?? 0) + 1);
}

/** Every outcome, zeros included (a fixed label set), for /metrics. */
export function publicSubmissionCounts(): Array<{ outcome: PublicSubmissionOutcome; count: number }> {
  const map = counter();
  return PUBLIC_SUBMISSION_OUTCOMES.map((outcome) => ({ outcome, count: map.get(outcome) ?? 0 }));
}

/** Test hook. */
export function resetPublicSubmissionCounts(): void {
  counter().clear();
}
