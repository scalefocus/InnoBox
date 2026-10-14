// POST /api/me/survey/bug { description, pagePath, fromOffer } → { ok } (INNOBOX_SPEC.md §13.10
// *Bug reports*). Stored in one transaction as a `bug` survey response with NO reference to the
// author, the page path (path only) and the server's own APP_VERSION. 409 `surveys_off` /
// `bug_reports_off` while a switch is off, 409 `no_open_survey` when `fromOffer` names no open
// `self` offer, 422 on validation. The `bug_report` limits: 3 a minute and 20 a day. Unaudited,
// anonymous in the system log and the rate-limit warning, presence-silent — like every survey route.
import { APP_VERSION } from "@innobox/shared/version";
import { requireUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readJsonObject } from "@/lib/http";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { submitBugReport } from "../store";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "bug_report", { anonymous: true }) ?? rateLimit(gate.user.id, "bug_report_day", { anonymous: true });
  if (limited) return limited;

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const result = await submitBugReport(pool, { id: gate.user.id, roles: gate.user.roles }, read.value, APP_VERSION);
  switch (result.status) {
    case "ok":
      return Response.json({ ok: true });
    case "invalid":
      return Response.json({ error: result.error }, { status: 422 });
    default:
      return Response.json({ error: result.status }, { status: 409 });
  }
}

export const POST = withSystemLog("/api/me/survey/bug", handlePOST, { anonymousActor: true });
