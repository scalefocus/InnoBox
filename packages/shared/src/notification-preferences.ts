// Per-event notification preferences (INNOBOX_SPEC.md §12.1) — pure and CLIENT-SAFE (also
// exposed at `@innobox/shared/notification-preferences` for the profile page). Four toggles,
// default on, that remove a recipient from an event before any row is written: the three
// follower-derived ones, and §40.6's invitations to propose a solution — the one actionable event a
// person can mute, since anyone who can see a challenge may send one. The admin attention events
// and the other actionable author/assignee events are never mutable.
import { EMAIL_DELIVERY_MODES, isEmailDelivery, type EmailDelivery } from "./email-digest.js";

export const NOTIFICATION_PREFERENCES = ["followedComments", "followedStatus", "followedSolutions", "invitations"] as const;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

/** The users column behind each toggle — a fixed map, so it is safe to interpolate. */
export const NOTIFICATION_PREFERENCE_COLUMN: Record<NotificationPreference, string> = {
  followedComments: "notify_followed_comments",
  followedStatus: "notify_followed_status",
  followedSolutions: "notify_followed_solutions",
  invitations: "notify_invitations",
};

export const NOTIFICATION_PREFERENCE_LABEL: Record<NotificationPreference, { title: string; sub: string }> = {
  followedComments: {
    title: "Comments on items I follow",
    sub: "New comments on challenges and solutions you follow — your own included.",
  },
  followedStatus: {
    title: "Status changes on items I follow",
    sub: "When a followed item moves on. Rejections, requests for improvement and assignments always reach you.",
  },
  followedSolutions: {
    title: "New solutions on challenges I follow",
    sub: "When someone proposes a solution to a challenge you follow or wrote.",
  },
  invitations: {
    title: "Invitations to propose a solution",
    sub: "When a colleague invites you to propose a solution to a challenge.",
  },
};

export type NotificationPreferences = Record<NotificationPreference, boolean>;

export function isNotificationPreference(v: unknown): v is NotificationPreference {
  return typeof v === "string" && (NOTIFICATION_PREFERENCES as readonly string[]).includes(v);
}

/**
 * Drops the opted-out recipients, except the `exempt` ones — people for whom the event is a duty
 * rather than a courtesy (admins/committee on a new solution, the assignee on a status change).
 * Order is preserved.
 */
export function applyPreferenceMute(recipients: readonly string[], optedOut: ReadonlySet<string>, exempt: ReadonlySet<string> = new Set()): string[] {
  return recipients.filter((id) => exempt.has(id) || !optedOut.has(id));
}

/** The non-toggle keys a preference PATCH may carry: the e-mail switch and the digest choice. */
export interface EmailPreferencePatch {
  emailNotificationsEnabled?: boolean;
  /** §12.1 e-mail digests. */
  emailDelivery?: EmailDelivery;
}

/** Parses a PATCH body: any subset of the four toggles plus the e-mail switch, each a boolean,
 *  and the digest choice. Unknown keys are ignored; at least one recognised key is required. */
export function parsePreferencePatch(
  body: unknown,
): { ok: true; value: Partial<NotificationPreferences> & EmailPreferencePatch } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be a JSON object" };
  const rec = body as Record<string, unknown>;
  const value: Partial<NotificationPreferences> & EmailPreferencePatch = {};
  for (const key of ["emailNotificationsEnabled", ...NOTIFICATION_PREFERENCES] as const) {
    if (rec[key] === undefined) continue;
    if (typeof rec[key] !== "boolean") return { ok: false, error: `${key} must be a boolean` };
    value[key] = rec[key] as boolean;
  }
  if (rec.emailDelivery !== undefined) {
    if (!isEmailDelivery(rec.emailDelivery)) return { ok: false, error: `emailDelivery must be one of ${EMAIL_DELIVERY_MODES.join(", ")}` };
    value.emailDelivery = rec.emailDelivery;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: `one of emailNotificationsEnabled, emailDelivery, ${NOTIFICATION_PREFERENCES.join(", ")} is required` };
  }
  return { ok: true, value };
}
