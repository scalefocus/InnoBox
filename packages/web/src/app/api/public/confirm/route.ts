// POST /api/public/confirm (INNOBOX_SPEC.md §24.5, §24.9): the submitter's "Confirm my submission"
// click. 200, or 410 for an unknown, expired or used token — one answer for all three. 404 while
// the form is off (§24.2).
import { handlePublicConfirm, handlePublicMethodNotAllowed } from "../handlers";
import { publicRouteDeps } from "../deps";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handlePublicConfirm(req, publicRouteDeps(req));
}

const other = (req: Request) => handlePublicMethodNotAllowed(publicRouteDeps(req), "POST");
export const GET = other;
export const PUT = other;
export const PATCH = other;
export const DELETE = other;
