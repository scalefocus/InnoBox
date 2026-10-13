// GET /api/public-submissions/link (INNOBOX_SPEC.md §6.1, §24.9): the share link behind the
// new-challenge page's "or ask a customer to challenge us" control. Any authenticated user (401
// without a session); `url` is `<PUBLIC_BASE_URL>/submit` while the public form is live (switch on
// and every §24.2 precondition holds), null otherwise — always 200, never the §24.2 404, and
// nothing else (no notice, no precondition detail). Read-only; not audited. Dependencies are
// injected and imports are relative so the decision runs under the plain unit runner.
import { PUBLIC_FORM_PATH } from "../../../../lib/public-intake-paths";

export type ShareLinkGate = { ok: true } | { ok: false; response: Response };

export interface ShareLinkDeps {
  /** The session gate — `requireUser` in the route. */
  gate: () => Promise<ShareLinkGate>;
  /** Whether the public form answers right now (`PublicIntakeState.live`). */
  live: () => Promise<boolean>;
  /** PUBLIC_BASE_URL with no trailing slash ("" only where it is unset in production). */
  baseUrl: string;
}

/** The link, or null while the form is not live (or no base URL is configured). */
export function publicShareUrl(live: boolean, baseUrl: string): string | null {
  return live && baseUrl ? `${baseUrl}${PUBLIC_FORM_PATH}` : null;
}

export async function handleShareLink(deps: ShareLinkDeps): Promise<Response> {
  const gate = await deps.gate();
  if (!gate.ok) return gate.response;
  return Response.json({ url: publicShareUrl(await deps.live(), deps.baseUrl) });
}
