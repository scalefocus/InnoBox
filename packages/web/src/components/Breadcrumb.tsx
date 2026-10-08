// Shared section breadcrumb (INNOBOX_SPEC.md §2.2): renders above a sub-page title as
// "Root › … › Current". Every crumb carrying an href is a link; the trailing current-page
// crumb (no href) is plain text marked `aria-current="page"`. Callers render it only once
// the viewer has passed the page's access gate (§14) — never on loading/forbidden states.
import Link from "next/link";
import type { Crumb } from "./breadcrumb-crumbs";

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol className="breadcrumb-list">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li className="breadcrumb-item" key={`${item.label}-${i}`}>
              {item.href && !last ? (
                <Link href={item.href} className="breadcrumb-link">
                  {item.label}
                </Link>
              ) : (
                <span className="breadcrumb-current" aria-current={last ? "page" : undefined}>
                  {item.label}
                </span>
              )}
              {!last && (
                <span className="breadcrumb-sep" aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export { adminCrumbs } from "./breadcrumb-crumbs";
export type { Crumb } from "./breadcrumb-crumbs";
