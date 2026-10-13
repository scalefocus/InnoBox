// POST /api/public/submissions (INNOBOX_SPEC.md §24.3–§24.5, §24.9): a submission from the public
// form. 202 when received (or silently dropped), never a session read, never audited or
// system-logged. 404 while the form is off (§24.2).
import { handlePublicMethodNotAllowed, handlePublicSubmission } from "../handlers";
import { publicRouteDeps } from "../deps";

export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handlePublicSubmission(req, publicRouteDeps(req));
}

const other = (req: Request) => handlePublicMethodNotAllowed(publicRouteDeps(req), "POST");
export const GET = other;
export const PUT = other;
export const PATCH = other;
export const DELETE = other;
