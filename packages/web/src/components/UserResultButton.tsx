"use client";
// Assignee-search result row (INNOBOX_SPEC.md §7.3, §13.6): one clickable row in an
// assignee-search popover — an avatar bubble plus a stacked, ellipsis-truncated name/e-mail
// column, so long values never spill outside the popover. Shared by the challenge-detail
// assignment control and the triage filter/bulk/per-row assign controls so all four look
// identical. This directory lists real active users only (never anonymous authors), so the
// avatar is always the user's real photo or initials bubble — there is no anonymity path here.
import { AvatarBubble } from "@/components/AvatarBubble";

export interface UserResult {
  id: string;
  displayName: string;
  email: string | null;
}

export function UserResultButton({
  user,
  onClick,
  disabled = false,
}: {
  user: UserResult;
  onClick: () => void;
  disabled?: boolean;
}) {
  // Full "Name (email)" on the native tooltip so the untruncated value stays reachable.
  const title = user.email ? `${user.displayName} (${user.email})` : user.displayName;
  return (
    <button type="button" className="user-result-item" disabled={disabled} onClick={onClick} title={title}>
      {/* noCard (§13.8): this row sits inside an open popover, and the row already carries the
          full "Name (email)" native tooltip above. */}
      <AvatarBubble size="sm" userId={user.id} displayName={user.displayName} noCard />
      <span className="user-result-text">
        <span className="user-result-name">{user.displayName}</span>
        {user.email && <span className="user-result-mail">{user.email}</span>}
      </span>
    </button>
  );
}
