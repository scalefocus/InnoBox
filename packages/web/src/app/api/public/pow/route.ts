// GET /api/public/pow (INNOBOX_SPEC.md §24.4, §24.9): a fresh proof-of-work challenge for the
// public form. 404 while the form is off (§24.2).
import { handlePublicMethodNotAllowed, handlePublicPow } from "../handlers";
import { publicRouteDeps } from "../deps";

export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handlePublicPow(publicRouteDeps(req));
}

const other = (req: Request) => handlePublicMethodNotAllowed(publicRouteDeps(req), "GET");
export const POST = other;
export const PUT = other;
export const PATCH = other;
export const DELETE = other;
