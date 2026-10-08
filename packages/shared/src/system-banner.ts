// System banner rules (INNOBOX_SPEC.md §14.6) — pure and CLIENT-SAFE (also exposed at the
// `@innobox/shared/system-banner` subpath for the topbar pill and the admin card). One platform-
// wide announcement, platform-admin set, every authenticated user sees it, lazy expiry.

export const SYSTEM_BANNER_MESSAGE_MAX = 120;

export const SYSTEM_BANNER_TONES = ["info", "warning"] as const;
export type SystemBannerTone = (typeof SYSTEM_BANNER_TONES)[number];

/** The fixed duration options; no custom value. Modeled in whole hours: 1d = 24 h, 1w = 168 h,
 *  30d = 720 h (a fixed 30-day span). */
export const SYSTEM_BANNER_DURATIONS = ["1h", "4h", "8h", "1d", "1w", "30d"] as const;
export type SystemBannerDuration = (typeof SYSTEM_BANNER_DURATIONS)[number];

export const SYSTEM_BANNER_DURATION_HOURS: Record<SystemBannerDuration, number> = {
  "1h": 1,
  "4h": 4,
  "8h": 8,
  "1d": 24,
  "1w": 168,
  "30d": 720,
};

export const SYSTEM_BANNER_DURATION_LABEL: Record<SystemBannerDuration, string> = {
  "1h": "1 hour",
  "4h": "4 hours",
  "8h": "8 hours",
  "1d": "1 day",
  "1w": "1 week",
  "30d": "30 days",
};

export interface SystemBanner {
  message: string;
  tone: SystemBannerTone;
  /** Optional "Learn more" link: https only, or a path relative to the deployment's base URL. */
  url: string | null;
  /** UTC ISO instant. */
  expiresAt: string;
}

export interface SystemBannerInput {
  message: string;
  tone: SystemBannerTone;
  url: string | null;
  duration: SystemBannerDuration;
}

export type BannerValidation = { ok: true; value: SystemBannerInput } | { ok: false; error: string };

export function isSystemBannerTone(v: unknown): v is SystemBannerTone {
  return typeof v === "string" && (SYSTEM_BANNER_TONES as readonly string[]).includes(v);
}

export function isSystemBannerDuration(v: unknown): v is SystemBannerDuration {
  return typeof v === "string" && (SYSTEM_BANNER_DURATIONS as readonly string[]).includes(v);
}

/** `https://…` or an app-relative path (`/…`, never `//…`). Anything else — `http:`,
 *  `javascript:`, `data:` — is refused. */
export function isAllowedBannerUrl(raw: string): boolean {
  if (raw.startsWith("/")) return !raw.startsWith("//") && !/[\s<>"']/.test(raw);
  try {
    const u = new URL(raw);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateSystemBannerInput(body: unknown): BannerValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "request body must be a JSON object" };
  const rec = body as Record<string, unknown>;
  const message = typeof rec.message === "string" ? rec.message.replace(/\s+/g, " ").trim() : "";
  if (message === "") return { ok: false, error: "message is required" };
  if (message.length > SYSTEM_BANNER_MESSAGE_MAX) return { ok: false, error: `message must be at most ${SYSTEM_BANNER_MESSAGE_MAX} characters` };
  const tone = rec.tone === undefined ? "info" : rec.tone;
  if (!isSystemBannerTone(tone)) return { ok: false, error: "tone must be 'info' or 'warning'" };
  if (!isSystemBannerDuration(rec.duration)) return { ok: false, error: `duration must be one of ${SYSTEM_BANNER_DURATIONS.join(", ")}` };
  let url: string | null = null;
  if (rec.url !== undefined && rec.url !== null && rec.url !== "") {
    if (typeof rec.url !== "string" || rec.url.length > 2048 || !isAllowedBannerUrl(rec.url.trim())) {
      return { ok: false, error: "url must be an https:// address or a path starting with /" };
    }
    url = rec.url.trim();
  }
  return { ok: true, value: { message, tone, url, duration: rec.duration } };
}

/** Expiry is lazy: active iff `expiresAt` is in the future, judged at read time. */
export function isSystemBannerActive(banner: SystemBanner | null | undefined, nowMs: number = Date.now()): banner is SystemBanner {
  if (!banner) return false;
  const t = Date.parse(banner.expiresAt);
  return Number.isFinite(t) && t > nowMs;
}

/** "expires in 3h 20m" / "expires in 6d 2h" / "expires in 45s" for the admin card. */
export function bannerRemainingLabel(expiresAtIso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(expiresAtIso) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `expires in ${Math.max(1, Math.floor(ms / 1000))}s`;
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `expires in ${days}d ${hours}h`;
  if (hours > 0) return `expires in ${hours}h ${minutes}m`;
  return `expires in ${minutes}m`;
}
