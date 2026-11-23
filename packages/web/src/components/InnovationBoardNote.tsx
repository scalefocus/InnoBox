"use client";
// What people are told about the innovation board (INNOBOX_SPEC.md §45.7). Two muted lines, both
// read from `me.innovationBoard` and naming nobody:
//  - above a submit button, while the board has at least one active member — the board can read
//    this challenge or solution before it is reviewed. Until the board existed only admins (and,
//    for a solution, the committee and the assignee) did, so authors are told that has changed.
//    Anonymity is unaffected, so the line is the same with "Submit anonymously" ticked;
//  - at the top of a member's own notification preferences — they are on the board.
// With an empty board, or for a non-member, each renders nothing.
import { useEffect, useState } from "react";
import { BOARD_PROFILE_LINE, boardFormNote } from "@innobox/shared/innovation-board";
import { cachedGet } from "@/lib/ui";

interface BoardMe {
  innovationBoard?: { member?: boolean; active?: boolean };
}

function useBoardState(): { member: boolean; active: boolean } {
  const [state, setState] = useState({ member: false, active: false });
  useEffect(() => {
    let live = true;
    cachedGet<BoardMe>("/api/me")
      .then((me) => {
        if (live) setState({ member: me.innovationBoard?.member === true, active: me.innovationBoard?.active === true });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** The line above a submit button. `restricted`: the challenge is not organization-wide (§4.3). */
export function InnovationBoardFormNote({ form, restricted }: { form: "challenge" | "solution"; restricted: boolean }) {
  const { active } = useBoardState();
  if (!active) return null;
  return (
    <p className="board-note" data-testid="innovation-board-note">
      {boardFormNote(form, restricted)}
    </p>
  );
}

/** The line at the top of a member's own notification preferences. */
export function InnovationBoardProfileLine() {
  const { member } = useBoardState();
  if (!member) return null;
  return (
    <p className="board-note" data-testid="innovation-board-member-line">
      {BOARD_PROFILE_LINE}
    </p>
  );
}
