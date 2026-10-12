// What's new (INNOBOX_SPEC.md §13.9): renders the CHANGELOG — one user-facing entry per
// APP_VERSION, newest first. A server component for its metadata; everything that reads `/api/me`
// or the query string lives in client children: the greyed-out "Coming soon" list (filtered by
// the viewer's roles) and the release list (the read receipt, the "New since your last visit"
// highlighting and the "current" label).
import type { Metadata } from "next";
import { ComingSoon } from "./ComingSoon";
import { ReleaseList } from "./ReleaseList";

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

      <ReleaseList />
    </>
  );
}
