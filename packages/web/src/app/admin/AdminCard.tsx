"use client";
// The Administration console's collapsible card (INNOBOX_SPEC.md §14): a header button that
// toggles the body, a summary chip, and — optionally — an ACTION SLOT beside the header button
// (§14.11). The header is a <button>, so a control such as the survey switch cannot nest inside
// it; the slot sits next to it instead and stays usable while the card is collapsed. The body
// stays mounted when closed so its state survives.
import type { ReactNode } from "react";

export function AdminCard({
  title,
  summary,
  open,
  onToggle,
  action,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  open: boolean;
  onToggle: () => void;
  /** Rendered beside — never inside — the collapse button. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const head = (
    <button type="button" className="admin-card-head" onClick={onToggle} aria-expanded={open}>
      <h3 className="admin-card-title" style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
        {title}
      </h3>
      <span className="admin-card-accessory">
        <span className="chip">{summary}</span>
      </span>
      <span className="admin-card-chevron" data-open={open} aria-hidden="true">
        <ChevronIcon />
      </span>
    </button>
  );
  return (
    <div className="card reveal" style={{ marginBottom: 18 }}>
      {action ? (
        <div className="admin-card-headrow">
          {head}
          <div className="admin-card-action">{action}</div>
        </div>
      ) : (
        head
      )}
      <div className="admin-card-body" data-open={open}>
        <div className="admin-card-body-inner">
          <div className="admin-card-body-pad">{children}</div>
        </div>
      </div>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
