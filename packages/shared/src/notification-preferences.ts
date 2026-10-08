// Per-event notification preferences (INNOBOX_SPEC.md §12.1) — pure and CLIENT-SAFE (also
// exposed at `@innobox/shared/notification-preferences` for the profile page). Three toggles,
// default on, that remove a recipient from a follower-derived event before any row is written.
// The admin attention events and the actionable author/assignee events are never mutable.

export const NOTIFICATION_PREFERENCES = ["followedComments", "followedStatus", "followedSolutions"] as const;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

/** The users column behind each toggle — a fixed map, so it is safe to interpolate. */
export const NOTIFICATION_PREFERENCE_COLUMN: Record<NotificationPreference, string> = {
  followedComments: "notify_followed_comments",
  followedStatus: "notify_followed_status",
  followedSolutions: "notify_followed_solutions",
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

/** Parses a PATCH body: any subset of the three toggles plus the e-mail switch, each a boolean.
 *  Unknown keys are ignored; at least one recognised key is required. */
export function parsePreferencePatch(
  body: unknown,
): { ok: true; value: Partial<NotificationPreferences> & { emailNotificationsEnabled?: boolean } } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be a JSON object" };
  const rec = body as Record<string, unknown>;
  const value: Partial<NotificationPreferences> & { emailNotificationsEnabled?: boolean } = {};
  for (const key of ["emailNotificationsEnabled", ...NOTIFICATION_PREFERENCES] as const) {
    if (rec[key] === undefined) continue;
    if (typeof rec[key] !== "boolean") return { ok: false, error: `${key} must be a boolean` };
    value[key] = rec[key] as boolean;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, error: `one of emailNotificationsEnabled, ${NOTIFICATION_PREFERENCES.join(", ")} is required` };
  }
  return { ok: true, value };
}
