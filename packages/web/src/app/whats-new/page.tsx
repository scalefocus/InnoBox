// What's new (CLAUDE.md "App version" / INNOBOX_SPEC.md §2): renders the CHANGELOG —
// one user-facing line per APP_VERSION, newest first. Dates are calendar dates
// (UTC YYYY-MM-DD), shown verbatim; they are release stamps, not timestamps.
// Above the releases, the greyed-out "Coming soon" list (§13.9) — a client child, because it
// filters by the viewer's roles.
import type { Metadata } from "next";
import { CHANGELOG } from "./changelog";
import { ComingSoon } from "./ComingSoon";

export const metadata: Metadata = { title: "What's new — InnoBox" };

export default function WhatsNewPage() {
  return (
    <>
      <div className="page-head reveal">
        <div className="eyebrow">Release notes</div>
        <h1 className="page-title">What&apos;s new</h1>
        <p className="page-sub">Every release of InnoBox, newest first.</p>
      </div>

      <ComingSoon />

      <div className="rows reveal" style={{ animationDelay: "0.08s" }}>
        {CHANGELOG.map((entry) => (
          <div className="row" key={entry.version}>
            <span className="chip chip-accent">v{entry.version}</span>
            <div className="grow">
              <div className="ttl">{entry.summary}</div>
            </div>
            <span className="mono muted" style={{ fontSize: 12 }}>
              {entry.date}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
