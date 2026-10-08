// Shared response mapping for the §12.4 webhook admin routes (INNOBOX_SPEC.md): one place for
// the plain-language error messages (never a spec reference, never the URL) and the deps.
import { WEBHOOKS_PER_NAMESPACE_MAX } from "@innobox/shared";
import { webhookKey } from "@/lib/webhooks";
import type { WebhookDeps, WebhookWriteResult } from "./store";

export const WEBHOOKS_NOT_CONFIGURED = "Webhooks are not configured on this server";

export function webhookDeps(): WebhookDeps {
  return { key: webhookKey(), baseUrl: process.env.PUBLIC_BASE_URL ?? process.env.NEXTAUTH_URL ?? "" };
}

export function notConfiguredResponse(): Response {
  return Response.json({ error: WEBHOOKS_NOT_CONFIGURED }, { status: 409 });
}

export function webhookWriteResponse(result: WebhookWriteResult, notFound: string, okStatus = 200): Response {
  switch (result.status) {
    case "ok":
      return Response.json({ webhook: result.webhook }, { status: okStatus });
    case "not_found":
      return Response.json({ error: notFound }, { status: 404 });
    case "not_configured":
      return notConfiguredResponse();
    case "limit_reached":
      return Response.json({ error: `A namespace can have at most ${WEBHOOKS_PER_NAMESPACE_MAX} webhooks` }, { status: 409 });
    case "invalid_url":
      return Response.json({ error: result.message }, { status: 422 });
  }
}
