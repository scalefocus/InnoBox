// "Improve with AI" on the submit forms (INNOBOX_SPEC.md §22.10): a writing aid for the author's
// OWN text. Nothing it produces is stored, audited or marked — the draft goes back to the browser
// and the author decides what to keep.
//
// Egress is exactly the §22.10 list (see buildChallengeDraftPrompt / buildSolutionDraftPrompt):
// never the client name, the anonymity choice, attachments or anything about the author. A
// namespace-only challenge (the one being written, or a solution's parent) is restricted content
// and is refused before any network call while the platform switch is off. `retry: false`, and at
// most 10 calls a minute and 50 a rolling 24 hours per person, counted from ai_usage.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import { canSeeChallenge, isRestrictedVisibility, type ChallengeStatus, type ChallengeVisibility } from "@innobox/shared";
import {
  AI_DRAFT_LIMITS,
  AI_SETTING_KEYS,
  aiUserLimitHit,
  buildChallengeDraftPrompt,
  buildSolutionDraftPrompt,
  countAiUserCalls,
  isAiError,
  processChallengeDraft,
  processSolutionDraft,
  promptImpactAreaNames,
  readAiSwitch,
  type AiClient,
  type ChallengeDraftOutput,
  type SolutionDraftOutput,
} from "@innobox/shared/ai";
import type { Viewer } from "../../challenges/store";
import { listActiveImpactAreas } from "../../challenges/store";
import type { DraftRequest } from "./validation";

export const DRAFT_FEATURE = "submit_draft";

export const DRAFT_MESSAGES = {
  unavailable: "Improving text with AI isn't available right now.",
  restricted: "This challenge is visible only to its namespace, so its text can't be sent to the AI provider.",
  minute: `You've improved text ${AI_DRAFT_LIMITS.perMinute} times in the last minute — wait a moment and try again.`,
  day: `You've reached the limit of ${AI_DRAFT_LIMITS.perDay} improvements in 24 hours — try again later.`,
  notFound: "challenge not found",
} as const;

export interface DraftAvailability {
  available: boolean;
  /** Whether namespace-only content may be sent (the button explains itself when not). */
  restrictedAllowed: boolean;
}

export async function getDraftAvailability(pool: Pool, ai: AiClient): Promise<DraftAvailability> {
  const available = await ai.available(DRAFT_FEATURE);
  return { available, restrictedAllowed: available && (await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent)) };
}

export type DraftOutcome =
  | { status: "ok"; kind: "challenge"; draft: ChallengeDraftOutput }
  | { status: "ok"; kind: "solution"; draft: SolutionDraftOutput }
  | { status: "unavailable" | "restricted" | "minute" | "day" | "not_found" | "trashed" | "failed" };

/** Runs one draft for `viewer`. Never throws for an AI failure — the caller maps the outcome. */
export async function runDraft(pool: Pool, ai: AiClient, viewer: Viewer, req: DraftRequest, signal?: AbortSignal): Promise<DraftOutcome> {
  if (!(await ai.available(DRAFT_FEATURE))) return { status: "unavailable" };

  let restrictedContent = false;
  let challenge: { title: string; description: string } | null = null;
  if (req.kind === "challenge") {
    restrictedContent = isRestrictedVisibility(req.visibility);
  } else {
    const { rows } = await pool.query<{ id: string; title: string; description: string; visibility: ChallengeVisibility; status: string; author_id: string; assignee_id: string | null; namespace_id: string; trashed: boolean }>(
      `select id, title, description, visibility, status, author_id, assignee_id, namespace_id, trashed_at is not null as trashed from challenges where number = $1`,
      [req.challengeNumber],
    );
    const row = rows[0];
    // §10.4: a trashed challenge drops out of every AI task — refused (409) for the platform admin,
    // the only one who can see it there.
    if (row?.trashed && viewer.roles.isPlatformAdmin) return { status: "trashed" };
    if (
      !row ||
      row.trashed ||
      !canSeeChallenge(viewer, { id: row.id, namespaceId: row.namespace_id, visibility: row.visibility, status: row.status as ChallengeStatus, authorId: row.author_id, assigneeId: row.assignee_id, trashed: false })
    ) {
      return { status: "not_found" };
    }
    challenge = { title: row.title, description: row.description };
    restrictedContent = isRestrictedVisibility(row.visibility);
  }
  if (restrictedContent && !(await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent))) return { status: "restricted" };

  const hit = aiUserLimitHit(await countAiUserCalls(pool, viewer.userId, DRAFT_FEATURE), AI_DRAFT_LIMITS);
  if (hit) return { status: hit };

  const areas = await listActiveImpactAreas(pool);
  const impactAreaNames = promptImpactAreaNames(areas);
  const prompt =
    req.kind === "challenge"
      ? buildChallengeDraftPrompt({ title: req.title, description: req.description, impactAreaNames })
      : buildSolutionDraftPrompt({ description: req.description, costVsBenefits: req.costVsBenefits, challenge: challenge!, impactAreaNames });

  try {
    const result = await ai.complete({
      feature: DRAFT_FEATURE,
      userId: viewer.userId,
      system: prompt.system,
      messages: prompt.messages,
      json: true,
      retry: false,
      signal,
      restrictedContent,
    });
    if (req.kind === "challenge") {
      const draft = processChallengeDraft(result.json, areas);
      return draft ? { status: "ok", kind: "challenge", draft } : { status: "failed" };
    }
    const draft = processSolutionDraft(result.json);
    return draft ? { status: "ok", kind: "solution", draft } : { status: "failed" };
  } catch (err) {
    if (isAiError(err) && err.code === "ai_restricted_content") return { status: "restricted" };
    if (isAiError(err) && (err.code === "ai_disabled" || err.code === "ai_not_configured")) return { status: "unavailable" };
    return { status: "failed" };
  }
}
