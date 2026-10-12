// Request parsing for the §22 AI provider routes (INNOBOX_SPEC.md §22.4, §22.5, §22.9). Pure: the
// shapes only — base-URL normalization (it needs the process's localhost allowance) and the
// stored-token rule (it needs the saved row) run in the store. Parsers return
// `{ ok: false, error }` for the routes' 400 responses — never throw.
import { isAiProvider, parseAiModel, parseAiToken, type AiProvider } from "@innobox/shared/ai";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The connection half of the form: provider, base URL (raw — normalized by the store) and the
 *  API key ("" = use the stored one). */
export interface AiConnectionInput {
  provider: AiProvider;
  baseUrl: string;
  token: string;
}

export interface AiConfigInput extends AiConnectionInput {
  model: string;
}

export function parseAiConnectionInput(body: Record<string, unknown>): Parsed<AiConnectionInput> {
  if (!isAiProvider(body.provider)) return { ok: false, error: "provider must be openwebui or openai" };
  if (body.baseUrl !== undefined && body.baseUrl !== null && typeof body.baseUrl !== "string") return { ok: false, error: "baseUrl must be text" };
  const token = parseAiToken(body.token);
  if (!token.ok) return token;
  return { ok: true, value: { provider: body.provider, baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "", token: token.value } };
}

export function parseAiConfigInput(body: Record<string, unknown>): Parsed<AiConfigInput> {
  const conn = parseAiConnectionInput(body);
  if (!conn.ok) return conn;
  const model = parseAiModel(body.model);
  if (!model.ok) return model;
  return { ok: true, value: { ...conn.value, model: model.value } };
}

export function parseAiEnabledPatch(body: Record<string, unknown>): Parsed<{ enabled: boolean }> {
  if (typeof body.enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
  return { ok: true, value: { enabled: body.enabled } };
}

/** `{ restrictedContent?: boolean, features?: { <featureKey>: boolean } }` — at least one. */
export interface AiSwitchesInput {
  restrictedContent?: boolean;
  features: Record<string, boolean>;
}

export function parseAiSwitchesInput(body: Record<string, unknown>, switchable: readonly string[]): Parsed<AiSwitchesInput> {
  const out: AiSwitchesInput = { features: {} };
  if (body.restrictedContent !== undefined) {
    if (typeof body.restrictedContent !== "boolean") return { ok: false, error: "restrictedContent must be true or false" };
    out.restrictedContent = body.restrictedContent;
  }
  if (body.features !== undefined) {
    if (typeof body.features !== "object" || body.features === null || Array.isArray(body.features)) return { ok: false, error: "features must be an object" };
    for (const [key, value] of Object.entries(body.features as Record<string, unknown>)) {
      if (!switchable.includes(key)) return { ok: false, error: `${key} has no switch` };
      if (typeof value !== "boolean") return { ok: false, error: `features.${key} must be true or false` };
      out.features[key] = value;
    }
  }
  if (out.restrictedContent === undefined && Object.keys(out.features).length === 0) return { ok: false, error: "nothing to change" };
  return { ok: true, value: out };
}
