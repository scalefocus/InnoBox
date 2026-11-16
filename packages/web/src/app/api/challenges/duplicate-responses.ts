// The HTTP answer to a §42.3 refusal (INNOBOX_SPEC.md §42.9), shared by the mark, its preview and
// the dialog's search: 404 for a challenge the caller cannot see, the shared 409 when it is trashed,
// 403 for an actor who may not mark (the committee bar with its own message), 409 for the status
// and for an open solution, 422 for the original or the note. No message carries a section mark.
import { DUPLICATE_MESSAGES, TEAM_MESSAGES } from "@innobox/shared";
import { trashedResponse } from "@/lib/http";
import type { DuplicateRefusal } from "./duplicates";

export function duplicateRefusalResponse(refusal: DuplicateRefusal): Response {
  switch (refusal.status) {
    case "not_found":
      return Response.json({ error: "challenge not found" }, { status: 404 });
    case "trashed":
      return trashedResponse();
    case "forbidden":
      return Response.json({ error: DUPLICATE_MESSAGES.forbidden }, { status: 403 });
    case "own_item":
      return Response.json({ error: TEAM_MESSAGES.ownItemReview, code: "own_item" }, { status: 403 });
    case "wrong_status":
      return Response.json({ error: DUPLICATE_MESSAGES.wrongStatus, code: "duplicate_status" }, { status: 409 });
    case "open_solutions":
      return Response.json({ error: DUPLICATE_MESSAGES.openSolutions, code: "open_solutions" }, { status: 409 });
    case "invalid":
      return Response.json({ error: refusal.message, code: "invalid_original" }, { status: 422 });
  }
}
