// The §22.11 triage-assist pass (INNOBOX_SPEC.md): leader-only, every minute while the task is
// effective (its platform switch on AND AI available). Each subject — a challenge in
// awaiting_triage / in_review / needs_improvement / meeting_scheduled — without a current result
// gets one run per distinct input: the input hash (title, description, impact area) is claimed
// first, so an unchanged item is never re-sent, an edit makes a new hash and a new run, and a
// Re-run (hash cleared) runs again. A namespace-only challenge is skipped while restricted content
// may not be sent. A failed run waits an hour before the same input is tried again.
//
// Advisory only (invariant 6): this writes ai_results and nothing else — never a status, an
// assignment, a visibility or a notification. Never throws mid-batch.
import type { Pool } from "pg";
import {
  AI_SETTING_KEYS,
  TRIAGE_CANDIDATE_LIMIT,
  TRIAGE_FAILED_RETRY_MINUTES,
  TRIAGE_INPUT_HASH_SQL,
  TRIAGE_SUBJECT_STATUSES,
  aiFeatureSwitchKey,
  buildTriagePrompt,
  deleteWithdrawnAiResults,
  isAiError,
  processTriageNotes,
  promptImpactAreaNames,
  readAiSwitch,
  type AiClient,
} from "@innobox/shared/ai";

export const TRIAGE_FEATURE = "triage_assist";
/** Subjects per sweep — a sweep is sequential, so this bounds its length. */
export const TRIAGE_SWEEP_BATCH = 3;
/** A claim older than this is considered abandoned (a crash mid-run) and is taken again. */
const STALE_CLAIM_MINUTES = 15;

export interface TriageSweepSummary {
  effective: boolean;
  ran: number;
  ready: number;
  failed: number;
  cleaned: number;
}

interface SubjectRow {
  id: string;
  number: string;
  title: string;
  description: string;
  namespace_id: string;
  visibility: "org" | "namespace";
  impact_area: string;
  hash: string;
}

function log(level: "info" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, msg, ...extra });
  if (level === "error") console.error(line);
  else console.log(line);
}

/** One sweep. `ai` is the worker's helper client (source = worker). `scope` limits the subjects
 *  to one namespace — a test seam (the live-DB suite shares its database with other suites). */
export async function runTriageAssistSweep(pool: Pool, ai: AiClient, scope: { namespaceId?: string } = {}): Promise<TriageSweepSummary> {
  const summary: TriageSweepSummary = { effective: false, ran: 0, ready: 0, failed: 0, cleaned: 0 };
  // The withdrawn clean-up runs regardless of the switch: a result shares its item's lifecycle.
  summary.cleaned = await deleteWithdrawnAiResults(pool);

  if (!(await readAiSwitch(pool, aiFeatureSwitchKey(TRIAGE_FEATURE)))) return summary;
  if (!(await ai.available(TRIAGE_FEATURE))) return summary;
  summary.effective = true;
  const restrictedOk = await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent);

  const { rows: subjects } = await pool.query<SubjectRow>(
    `select c.id, c.number::text, c.title, c.description, c.namespace_id, c.visibility, ia.name as impact_area,
            ${TRIAGE_INPUT_HASH_SQL} as hash
       from challenges c
       join impact_areas ia on ia.id = c.impact_area_id
       left join ai_results r on r.kind = $1 and r.parent_type = 'challenge' and r.parent_id = c.id
      where c.status = any($2::text[])
        and (c.visibility = 'org' or $3::boolean)
        and ($6::uuid is null or c.namespace_id = $6::uuid)
        and (r.id is null
             or r.input_hash is null
             or r.input_hash <> ${TRIAGE_INPUT_HASH_SQL}
             or (r.status = 'failed' and r.updated_at < now() - make_interval(mins => $4::int))
             or (r.status = 'pending' and r.updated_at < now() - make_interval(mins => $5::int)))
      order by c.created_at
      limit ${TRIAGE_SWEEP_BATCH}`,
    [TRIAGE_FEATURE, TRIAGE_SUBJECT_STATUSES, restrictedOk, TRIAGE_FAILED_RETRY_MINUTES, STALE_CLAIM_MINUTES, scope.namespaceId ?? null],
  );
  if (subjects.length === 0) return summary;

  const { rows: areas } = await pool.query<{ id: string; name: string; active: boolean }>(`select id, name, active from impact_areas where active`);
  const impactAreaNames = promptImpactAreaNames(areas);

  for (const s of subjects) {
    try {
      // Claim this exact input. The previous result's payload stays readable until the new one lands.
      await pool.query(
        `insert into ai_results (kind, parent_type, parent_id, input_hash, status)
         values ($1, 'challenge', $2, $3, 'pending')
         on conflict (kind, parent_type, parent_id)
         do update set input_hash = excluded.input_hash, status = 'pending', error_code = null, updated_at = now()`,
        [TRIAGE_FEATURE, s.id, s.hash],
      );
      summary.ran++;

      // Duplicate candidates: same namespace, visible to every reader of the note — org-visible
      // (or restricted, while the switch allows), never awaiting_triage or withdrawn.
      const { rows: candidates } = await pool.query<{ number: string; title: string; visibility: string }>(
        `with q as (
           select to_tsquery('simple', coalesce(
                    (select string_agg(quote_literal(l), ' | ')
                       from unnest(tsvector_to_array(to_tsvector('english', $2 || ' ' || left($3, 2000)))) l),
                    '')) as tsq
         )
         select c.number::text, c.title, c.visibility
           from challenges c, q
          where c.namespace_id = $1
            and c.id <> $4
            and c.status not in ('awaiting_triage', 'withdrawn')
            and (c.visibility = 'org' or $5::boolean)
          order by ts_rank(c.search_vector, q.tsq) desc, c.created_at desc
          limit ${TRIAGE_CANDIDATE_LIMIT}`,
        [s.namespace_id, s.title, s.description, s.id, restrictedOk],
      );
      const candidateList = candidates.map((c) => ({ number: Number(c.number), title: c.title }));
      const prompt = buildTriagePrompt({ title: s.title, description: s.description, impactArea: s.impact_area, impactAreaNames, candidates: candidateList });

      let payload: ReturnType<typeof processTriageNotes> = null;
      let errorCode: string | null = null;
      let model: string | null = null;
      try {
        const result = await ai.complete({
          feature: TRIAGE_FEATURE,
          system: prompt.system,
          messages: prompt.messages,
          json: true,
          // Restricted when the subject or any candidate sent is namespace-only (only possible
          // while the switch allows it; the helper re-checks).
          restrictedContent: s.visibility === "namespace" || candidates.some((c) => c.visibility === "namespace"),
        });
        model = result.model;
        payload = processTriageNotes(result.json, candidateList.map((c) => c.number), areas);
        if (!payload) errorCode = "ai_invalid_output";
      } catch (err) {
        errorCode = isAiError(err) ? err.code : "ai_provider_error";
      }

      // Written only against the claimed hash: an edit (or a Re-run) during the call made the
      // claim stale, and the next sweep runs the new input instead.
      await pool.query(
        `update ai_results
            set status = $4, payload = coalesce($5::jsonb, payload), model = coalesce($6, model), error_code = $7, updated_at = now()
          where kind = $1 and parent_type = 'challenge' and parent_id = $2 and input_hash = $3`,
        [TRIAGE_FEATURE, s.id, s.hash, payload ? "ready" : "failed", payload ? JSON.stringify(payload) : null, model, errorCode],
      );
      if (payload) summary.ready++;
      else summary.failed++;
    } catch (err) {
      summary.failed++;
      log("error", "triage assist run failed", { challenge: s.number, error: String(err) });
    }
  }
  return summary;
}

/** Schedules the pass every minute (leader-only — the caller starts it on acquiring the lock).
 *  A slow provider never stacks sweeps. */
export function startTriageAssistSweeps(pool: Pool, ai: () => AiClient, onSweep?: (s: TriageSweepSummary) => void): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const s = await runTriageAssistSweep(pool, ai());
      onSweep?.(s);
      if (s.ran || s.cleaned) log("info", "triage assist sweep", { ...s });
    } catch (err) {
      log("error", "triage assist sweep failed", { error: String(err) });
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(sweep, 60_000);
  return () => clearInterval(timer);
}
