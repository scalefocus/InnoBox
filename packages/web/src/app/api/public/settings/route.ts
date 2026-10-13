// GET /api/public/settings (INNOBOX_SPEC.md §24.3, §24.9): the privacy notice — the only
// application data the public form ever reads. 404 while the form is off (§24.2).
import { handlePublicMethodNotAllowed, handlePublicSettings } from "../handlers";
import { publicRouteDeps } from "../deps";

export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handlePublicSettings(publicRouteDeps(req));
}

const other = (req: Request) => handlePublicMethodNotAllowed(publicRouteDeps(req), "GET");
export const POST = other;
export const PUT = other;
export const PATCH = other;
export const DELETE = other;
