// Shared response mapping for the §22 AI provider routes (INNOBOX_SPEC.md §22.4, §22.5, §22.9):
// one place for the deps, the machine codes and the plain-language messages (never a spec
// reference, never the token).
import { AI_ERROR_MESSAGES } from "@innobox/shared/ai";
import { aiKey, aiTransport } from "@/lib/ai";
import type { AiAdminDeps } from "./store";

export function aiAdminDeps(): AiAdminDeps {
  return { key: aiKey(), transport: aiTransport() };
}

export function aiError(status: number, code: string, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, code, ...extra }, { status });
}

export function keyMissingResponse(): Response {
  return aiError(409, "ai_key_missing", AI_ERROR_MESSAGES.ai_key_missing);
}

/** The refusals shared by test, save and the model list. */
export function connectionRefusal(r: { status: "key_missing" } | { status: "invalid"; error: string } | { status: "token_required"; error: string }): Response {
  switch (r.status) {
    case "key_missing":
      return keyMissingResponse();
    case "invalid":
      return aiError(422, "invalid_base_url", r.error);
    case "token_required":
      return aiError(422, "ai_token_required", r.error);
  }
}

export const AI_ENABLE_REFUSALS = {
  not_configured: { code: "ai_not_configured", message: AI_ERROR_MESSAGES.ai_not_configured },
  test_required: { code: "ai_test_required", message: "The saved configuration needs a passing test before AI can be switched on." },
  token_undecryptable: { code: "ai_token_undecryptable", message: AI_ERROR_MESSAGES.ai_token_undecryptable },
} as const;
