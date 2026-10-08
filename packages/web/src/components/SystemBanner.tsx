"use client";
// The §14.6 system banner pill (INNOBOX_SPEC.md): a platform-wide announcement in the topbar
// between the search box and the bell. Desktop: a width-capped pill that truncates on one line
// (full text via `title`) and never slides under the control cluster. Mobile: its own full-width
// line below the search, wrapping the whole message (touch has no hover). Hidden entirely when
// nothing is active. Plain text only; an optional "Learn more" link. The banner itself arrives
// on the bell's 30-second poll — this component only renders what it is handed.
import Link from "next/link";
import type { SystemBanner as Banner } from "@innobox/shared/system-banner";

export function SystemBanner({ banner }: { banner: Banner | null }) {
  if (!banner) return null;
  const external = banner.url ? /^https:\/\//i.test(banner.url) : false;
  return (
    <div className={`system-banner system-banner-${banner.tone}`} role="status" title={banner.message} data-testid="system-banner">
      <span className="system-banner-text">{banner.message}</span>
      {banner.url &&
        (external ? (
          <a className="system-banner-link" href={banner.url} target="_blank" rel="noopener noreferrer">
            Learn more →
          </a>
        ) : (
          <Link className="system-banner-link" href={banner.url}>
            Learn more →
          </Link>
        ))}
    </div>
  );
}
