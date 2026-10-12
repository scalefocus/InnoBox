// Request parsing for POST /api/ai/draft (INNOBOX_SPEC.md §22.10). Pure. Only the fields the
// task's egress names are accepted — a client name or anonymity flag in the body is ignored, so
// it can never reach a prompt.
import { AI_DRAFT_COST_MAX, AI_DRAFT_DESCRIPTION_MAX, AI_DRAFT_TITLE_MAX } from "@innobox/shared/ai";

export type DraftRequest =
  | { kind: "challenge"; title: string; description: string; visibility: "org" | "namespace" }
  | { kind: "solution"; challengeNumber: string; description: string; costVsBenefits: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function text(v: unknown, max: number, field: string): Parsed<string> {
  if (v === undefined || v === null) return { ok: true, value: "" };
  if (typeof v !== "string") return { ok: false, error: `${field} must be text` };
  if (v.length > max) return { ok: false, error: `${field} must be at most ${max} characters` };
  return { ok: true, value: v };
}

export function parseDraftRequest(body: Record<string, unknown>): Parsed<DraftRequest> {
  if (body.kind === "challenge") {
    const title = text(body.title, AI_DRAFT_TITLE_MAX, "title");
    if (!title.ok) return title;
    const description = text(body.description, AI_DRAFT_DESCRIPTION_MAX, "description");
    if (!description.ok) return description;
    if (!title.value.trim() && !description.value.trim()) return { ok: false, error: "write a title or a description first" };
    if (body.visibility !== "org" && body.visibility !== "namespace") return { ok: false, error: "visibility must be org or namespace" };
    return { ok: true, value: { kind: "challenge", title: title.value, description: description.value, visibility: body.visibility } };
  }
  if (body.kind === "solution") {
    const num = typeof body.challengeNumber === "string" ? body.challengeNumber.replace(/^CH-/i, "") : "";
    if (!/^[1-9][0-9]{0,9}$/.test(num)) return { ok: false, error: "challengeNumber is invalid" };
    const description = text(body.description, AI_DRAFT_DESCRIPTION_MAX, "description");
    if (!description.ok) return description;
    const cost = text(body.costVsBenefits, AI_DRAFT_COST_MAX, "costVsBenefits");
    if (!cost.ok) return cost;
    if (!description.value.trim() && !cost.value.trim()) return { ok: false, error: "write a description first" };
    return { ok: true, value: { kind: "solution", challengeNumber: num, description: description.value, costVsBenefits: cost.value } };
  }
  return { ok: false, error: "kind must be challenge or solution" };
}
