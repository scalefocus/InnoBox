// Liveness (INNOBOX_SPEC.md §2): the process is up. No dependencies checked.
import { APP_VERSION } from "@innobox/shared/version";

export function GET(): Response {
  return Response.json({ status: "ok", version: APP_VERSION });
}
