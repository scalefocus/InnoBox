// "Similar challenges, explained" (INNOBOX_SPEC.md §22.12): after the §6.1 full-text check finds
// candidates, the AI re-ranks ONLY those candidates and adds a one-line reason to each. It never
// adds a challenge the check did not return, never blocks a submission, and fails silently: any AI
// error — or no answer within 5 s — returns the plain §6.1 list unchanged. retry: false.
//
// Egress: the draft's title and description, and each candidate's title and first 500 characters.
// Candidates are exactly the caller-visible §6.1 set; namespace-only ones are dropped from the AI
// input (they stay in the banner, unranked) while restricted content may not be sent, and a
// namespace-only draft is itself restricted.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import {
  AI_SETTING_KEYS,
  SIMILAR_EXPLAIN_TIMEOUT_MS,
  aiFeatureSwitchKey,
  buildSimilarPrompt,
  mergeSimilarRanking,
  processSimilarRanking,
  readAiSwitch,
  similarExplainInput,
  type AiClient,
} from "@innobox/shared/ai";
import { isRestrictedVisibility, type ChallengeVisibility } from "@innobox/shared";
import type { SimilarCandidate, SimilarChallenge } from "../challenges/store";

export const SIMILAR_FEATURE = "duplicate_explain";

export type ExplainedSimilar = SimilarChallenge & { reason?: string };

/** The banner's list: re-ranked with reasons when the step ran, else the plain §6.1 list. Never
 *  throws. The internal visibility/excerpt fields never leave this function. */
export async function explainSimilar(
  pool: Pool,
  ai: AiClient,
  userId: string,
  draft: { title: string; description: string; visibility: ChallengeVisibility },
  candidates: readonly SimilarCandidate[],
  opts: { timeoutMs?: number } = {},
): Promise<{ similar: ExplainedSimilar[]; explained: boolean }> {
  const plain = candidates.map(({ visibility: _v, excerpt: _e, ...c }) => c);
  if (candidates.length === 0) return { similar: plain, explained: false };
  try {
    if (!(await readAiSwitch(pool, aiFeatureSwitchKey(SIMILAR_FEATURE)))) return { similar: plain, explained: false };
    if (!(await ai.available(SIMILAR_FEATURE))) return { similar: plain, explained: false };
    const restrictedOk = await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent);
    if (isRestrictedVisibility(draft.visibility) && !restrictedOk) return { similar: plain, explained: false };

    const sendable = similarExplainInput(candidates, restrictedOk);
    if (sendable.length === 0) return { similar: plain, explained: false };
    const aiCandidates = sendable.map((c) => ({ number: Number(c.number.replace(/^CH-/, "")), title: c.title, excerpt: c.excerpt, visibility: c.visibility }));
    const prompt = buildSimilarPrompt({ title: draft.title, description: draft.description, candidates: aiCandidates });

    const result = await ai.complete({
      feature: SIMILAR_FEATURE,
      userId,
      system: prompt.system,
      messages: prompt.messages,
      json: true,
      retry: false,
      signal: AbortSignal.timeout(opts.timeoutMs ?? SIMILAR_EXPLAIN_TIMEOUT_MS),
      restrictedContent: isRestrictedVisibility(draft.visibility) || sendable.some((c) => isRestrictedVisibility(c.visibility)),
    });
    const ranking = processSimilarRanking(result.json, aiCandidates.map((c) => c.number));
    if (ranking.length === 0) return { similar: plain, explained: false };
    return { similar: mergeSimilarRanking(plain, ranking), explained: true };
  } catch {
    // Silent by design: the plain §6.1 banner is always a correct answer.
    return { similar: plain, explained: false };
  }
}
