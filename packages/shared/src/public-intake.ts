// Public submissions from outside the organization (INNOBOX_SPEC.md §24): the limits, the form's
// field validation, the abuse decisions, the retention dates, the privacy-notice link rendering and
// the e-mails to the submitter. Pure and dependency-free, so it is client-safe (also exposed at
// `@innobox/shared/public-intake` for the /submit page). The proof-of-work issue/verify needs
// node:crypto and lives in ./public-intake-pow.ts.

// ── Limits (§24.3, §24.4, §24.5, §24.8) ──────────────────────────────────────────────────────

/** The §6.1 limits, which the form shares with an ordinary challenge. */
export const PUBLIC_TITLE_MAX = 120;
export const PUBLIC_DESCRIPTION_MAX = 10_000;
export const PUBLIC_NAME_MAX = 120;
export const PUBLIC_EMAIL_MAX = 254;
export const PUBLIC_COMPANY_MAX = 200;
/** The §14.3 card: the privacy notice shown above the consent checkbox. */
export const PRIVACY_NOTICE_MAX = 4_000;
/** The optional note to the submitter in the decline e-mail (§24.5). */
export const DECLINE_NOTE_MAX = 1_000;

/** The public routes' body cap (§24.4) — not the 1 MB JSON limit. */
export const PUBLIC_BODY_MAX_BYTES = 64 * 1024;

/** A proof-of-work challenge expires 10 minutes after it is issued (§24.4). */
export const POW_TTL_MS = 10 * 60 * 1000;
/** The largest secret number the browser may have to try. Sized so a mid-range phone, hashing in
 *  small chunks that yield to the event loop, finds it in about a second on average: a desktop
 *  browser does ~65 000 WebCrypto hashes a second (≈ 0.15 s on average here), a phone several
 *  times fewer. */
export const POW_MAX_NUMBER = 20_000;
/** A submission arriving sooner than this after its challenge was issued is a bot (§24.4). */
export const MIN_SUBMIT_DELAY_MS = 3_000;

/** The e-mailed confirmation link works for 24 hours (§24.5). */
export const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** At most 3 confirmation e-mails per address per 24 hours (§24.4). */
export const PER_ADDRESS_LIMIT = 3;
export const PER_ADDRESS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most 100 confirmation e-mails per hour across the platform (§24.4). */
export const PLATFORM_CEILING = 100;
export const PLATFORM_WINDOW_MS = 60 * 60 * 1000;

/** Unconfirmed rows are deleted 7 days after they were created (§24.8). */
export const UNCONFIRMED_RETENTION_DAYS = 7;
/** Contact details are erased 90 days after the decline, or after the challenge closes (§24.8). */
export const CONTACT_RETENTION_DAYS = 90;
/** The Decided tab lists the last 90 days (§24.5). */
export const DECIDED_LIST_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── The metric (§24.4) ───────────────────────────────────────────────────────────────────────

/** `innobox_public_submissions_total{outcome}` — the only record of unauthenticated traffic. */
export const PUBLIC_SUBMISSION_OUTCOMES = [
  "received",
  "confirmed",
  "honeypot",
  "too_fast",
  "pow_failed",
  "address_capped",
  "ip_limited",
  "ceiling",
] as const;
export type PublicSubmissionOutcome = (typeof PUBLIC_SUBMISSION_OUTCOMES)[number];

// ── Field validation (§24.3) ─────────────────────────────────────────────────────────────────

export type IntakeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** A pragmatic e-mail syntax check: one `@`, a dotted domain, no spaces or brackets. The address is
 *  proven by the confirmation link, not by this. */
export function isEmailSyntax(raw: string): boolean {
  if (raw.length === 0 || raw.length > PUBLIC_EMAIL_MAX) return false;
  return /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:".]{2,}$/.test(raw) && !raw.includes("..");
}

/** The proof-of-work answer the browser sends back (§24.9). */
export interface PowSolution {
  salt: string;
  number: number;
  signature: string;
}

export interface PublicSubmissionFields {
  title: string;
  description: string;
  name: string;
  email: string;
  company: string | null;
  /** The honeypot field (`website`): a person never fills it. */
  honeypot: string;
}

function requiredText(raw: unknown, label: string, max: number): IntakeResult<string> {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: `${label} is required.` };
  const value = raw.trim();
  if (value.length > max) return { ok: false, error: `${label} must be at most ${max.toLocaleString("en-US")} characters.` };
  return { ok: true, value };
}

/** The form's fields (§24.3), with the §6.1 limits. The `pow` object is checked separately: a
 *  missing or bad proof-of-work is a 403, not a field error. */
export function validatePublicSubmission(body: Record<string, unknown>): IntakeResult<PublicSubmissionFields> {
  const title = requiredText(body.title, "Title", PUBLIC_TITLE_MAX);
  if (!title.ok) return title;
  const description = requiredText(body.description, "Description", PUBLIC_DESCRIPTION_MAX);
  if (!description.ok) return description;
  const name = requiredText(body.name, "Your name", PUBLIC_NAME_MAX);
  if (!name.ok) return name;
  const email = requiredText(body.email, "Your e-mail", PUBLIC_EMAIL_MAX);
  if (!email.ok) return email;
  if (!isEmailSyntax(email.value)) return { ok: false, error: "Enter a valid e-mail address." };

  let company: string | null = null;
  if (body.company !== undefined && body.company !== null) {
    if (typeof body.company !== "string") return { ok: false, error: "Company must be text." };
    const value = body.company.trim();
    if (value.length > PUBLIC_COMPANY_MAX) return { ok: false, error: `Company must be at most ${PUBLIC_COMPANY_MAX} characters.` };
    company = value || null;
  }
  if (body.consent !== true) return { ok: false, error: "Confirm that you have read the privacy notice." };

  const honeypot = typeof body.website === "string" ? body.website : "";
  return { ok: true, value: { title: title.value, description: description.value, name: name.value, email: email.value, company, honeypot } };
}

/** The `pow` object's shape, or null when it is missing or malformed (→ 403). */
export function parsePowSolution(raw: unknown): PowSolution | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.salt !== "string" || typeof o.signature !== "string") return null;
  if (typeof o.number !== "number" || !Number.isSafeInteger(o.number) || o.number < 0) return null;
  if (o.salt.length > 200 || o.signature.length > 200) return null;
  return { salt: o.salt, number: o.number, signature: o.signature };
}

// ── The abuse decisions (§24.4) ──────────────────────────────────────────────────────────────

/** The silent drops: a filled honeypot, or an answer faster than a person could type. The caller
 *  answers the normal 202 and stores and sends nothing. Null = carry on. */
export function silentDrop(input: { honeypot: string; issuedAtMs: number; nowMs: number }): "honeypot" | "too_fast" | null {
  if (input.honeypot.trim() !== "") return "honeypot";
  if (input.nowMs - input.issuedAtMs < MIN_SUBMIT_DELAY_MS) return "too_fast";
  return null;
}

/** True once an address has had its 3 confirmation e-mails in the last 24 hours. */
export function isAddressCapped(sentToAddressInWindow: number): boolean {
  return sentToAddressInWindow >= PER_ADDRESS_LIMIT;
}

/** True once the platform has sent 100 confirmation e-mails in the last hour. */
export function isPlatformCeilingReached(sentInWindow: number): boolean {
  return sentInWindow >= PLATFORM_CEILING;
}

/** Addresses are compared lower-cased (§24.4). */
export function normalizeEmailForCap(email: string): string {
  return email.trim().toLowerCase();
}

// ── Retention (§24.8) ────────────────────────────────────────────────────────────────────────

/** When an accepted submission's contact details fall due: 90 days after the challenge first
 *  reaches `solved` or `rejected`. */
export function contactEraseDueAt(closedAt: Date): Date {
  return new Date(closedAt.getTime() + CONTACT_RETENTION_DAYS * DAY_MS);
}

/** The daily job's cut-offs at `now`: unconfirmed rows created before `unconfirmedBefore` are
 *  deleted; declined rows decided before `declinedBefore` have their contact details erased. */
export function retentionCutoffs(now: Date): { unconfirmedBefore: Date; declinedBefore: Date } {
  return {
    unconfirmedBefore: new Date(now.getTime() - UNCONFIRMED_RETENTION_DAYS * DAY_MS),
    declinedBefore: new Date(now.getTime() - CONTACT_RETENTION_DAYS * DAY_MS),
  };
}

// ── The privacy notice (§24.2) ───────────────────────────────────────────────────────────────

/** Plain text up to 4 000 characters; surrounding whitespace is dropped. */
export function validatePrivacyNotice(raw: unknown): IntakeResult<string> {
  if (typeof raw !== "string") return { ok: false, error: "privacyNotice must be text" };
  const value = raw.trim();
  if (value.length > PRIVACY_NOTICE_MAX) return { ok: false, error: `the privacy notice must be at most ${PRIVACY_NOTICE_MAX} characters` };
  return { ok: true, value };
}

export type NoticeSegment = { kind: "text"; text: string } | { kind: "link"; href: string };

/** The notice split into text and `https` links — the only markup it gets. Everything else stays
 *  text (the page renders it escaped). Trailing sentence punctuation is not part of a link. */
export function privacyNoticeSegments(notice: string): NoticeSegment[] {
  const out: NoticeSegment[] = [];
  const re = /https:\/\/[^\s<>"'`]+/g;
  let last = 0;
  for (const m of notice.matchAll(re)) {
    let href = m[0];
    while (/[.,;:!?)\]]$/.test(href)) href = href.slice(0, -1);
    if (href.length <= "https://".length) continue;
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", text: notice.slice(last, start) });
    out.push({ kind: "link", href });
    last = start + href.length;
  }
  if (last < notice.length) out.push({ kind: "text", text: notice.slice(last) });
  return out;
}

// ── E-mails to the submitter (§24.7) ─────────────────────────────────────────────────────────
// Each carries the subject, the plain-text message and, for the confirmation only, a relative
// link (the worker prefixes PUBLIC_BASE_URL). None links into InnoBox, names an employee, or
// carries comments or solution content. The confirmation carries nothing the submitter wrote.

export type SubmitterEmailKind = "confirm" | "accepted" | "declined" | "solved" | "rejected";

export interface SubmitterEmail {
  kind: SubmitterEmailKind;
  subject: string;
  message: string;
  /** Relative to PUBLIC_BASE_URL; "" for every mail but the confirmation. */
  link: string;
}

/** The confirmation path. The token sits in the fragment, so it never reaches a server log, a
 *  proxy log or a Referer. */
export function confirmLinkPath(token: string): string {
  return `/submit/confirm#${token}`;
}

export function confirmationEmail(token: string): SubmitterEmail {
  return {
    kind: "confirm",
    subject: "Confirm your submission",
    message:
      "Someone used this e-mail address to send a challenge to InnoBox. It will be reviewed only after it is confirmed.\n\n" +
      "If this was not you, you can ignore this e-mail and nothing will be kept.\n\n" +
      "To confirm the submission, open this link within 24 hours:",
    link: confirmLinkPath(token),
  };
}

export function acceptedEmail(title: string): SubmitterEmail {
  return {
    kind: "accepted",
    subject: "Your submission is under review",
    message: `Thank you for your submission "${title}". Our team has accepted it and will now look at it. We'll e-mail you again once it reaches an outcome.`,
    link: "",
  };
}

export function declinedEmail(title: string, note: string | null): SubmitterEmail {
  const base = `Thank you for your submission "${title}". After review, it will not be taken further.`;
  return {
    kind: "declined",
    subject: "About your submission",
    message: note ? `${base}\n\nA note from the team:\n${note}` : base,
    link: "",
  };
}

export function outcomeEmail(title: string, outcome: "solved" | "rejected"): SubmitterEmail {
  return outcome === "solved"
    ? {
        kind: "solved",
        subject: "Your submission has been solved",
        message: `Your submission "${title}" has been solved: a solution has been put in place. Thank you for raising it.`,
        link: "",
      }
    : {
        kind: "rejected",
        subject: "An update on your submission",
        message: `Your submission "${title}" has been closed without a solution. Thank you for raising it.`,
        link: "",
      };
}

/** The outbox `type` of a submitter e-mail. */
export function submitterOutboxType(kind: SubmitterEmailKind): string {
  return `public_submission_${kind}`;
}
