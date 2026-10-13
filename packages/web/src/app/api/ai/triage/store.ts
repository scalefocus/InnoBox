// Triage assist, the web half (INNOBOX_SPEC.md §22.11): who may read a challenge's triage note,
// the note itself (duplicates re-filtered for the reader), whether it is current, and Re-run.
// The worker writes the notes; nothing here ever calls the provider.
//
// Who sees it: namespace and platform admins always; committee members of the namespace and the
// assignee once the challenge is past awaiting_triage. NEVER the author (v1 — it is triage
// material, not feedback), and only readers who can see the challenge at all (invariant 2). A
// withdrawn challenge has no note. Each duplicate is shown only when the reader can see that
// challenge too — the AI output inherits the visibility of every input (§22.7).
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import { canSeeChallenge, type ChallengeStatus } from "@innobox/shared";
import {
  AI_SETTING_KEYS,
  TRIAGE_INPUT_HASH_SQL,
  aiFeatureSwitchKey,
  isTriageSubject,
  readAiSwitch,
  type AiClient,
  type TriageNotes,
} from "@innobox/shared/ai";
import type { Viewer } from "../../challenges/store";

export const TRIAGE_FEATURE = "triage_assist";

export interface TriageDuplicateView {
  number: string;
  title: string;
  reason: string;
}

export interface TriageNotesView {
  /** The switch is on and AI is available — new notes are being made. */
  effective: boolean;
  /** none: no note yet (and none coming); pending: one is on its way; ready; failed. */
  state: "none" | "pending" | "ready" | "failed";
  /** The ready note was made from the current text (false after an edit, until the new one). */
  current: boolean;
  /** Namespace-only while restricted content may not be sent: no note will be made. */
  restrictedBlocked: boolean;
  canRerun: boolean;
  generatedAt: string | null;
  notes: (Omit<TriageNotes, "duplicates"> & { duplicates: TriageDuplicateView[] }) | null;
}

interface ChallengeRow {
  id: string;
  status: string;
  visibility: "org" | "namespace";
  namespace_id: string;
  author_id: string;
  assignee_id: string | null;
  trashed: boolean;
  hash: string;
}

type Access = { ok: true; row: ChallengeRow; isAdmin: boolean } | { ok: false; trashed?: true };

/** The §22.11 reader rule for one challenge. Not visible / not allowed both answer `ok: false`
 *  (the route answers 404 either way, so the note's existence never leaks). */
async function access(pool: Pool, viewer: Viewer, number: string): Promise<Access> {
  const { rows } = await pool.query<ChallengeRow>(
    `select c.id, c.status, c.visibility, c.namespace_id, c.author_id, c.assignee_id, c.trashed_at is not null as trashed, ${TRIAGE_INPUT_HASH_SQL} as hash
       from challenges c join impact_areas ia on ia.id = c.impact_area_id
      where c.number = $1`,
    [number],
  );
  const row = rows[0];
  if (!row) return { ok: false };
  // §10.4: a trashed challenge drops out of every AI task, for platform admins too (who alone can
  // see it, and are told why a re-run is refused).
  if (row.trashed) return viewer.roles.isPlatformAdmin ? { ok: false, trashed: true } : { ok: false };
  const visible = canSeeChallenge(viewer, { namespaceId: row.namespace_id, visibility: row.visibility, status: row.status as ChallengeStatus, authorId: row.author_id, trashed: false });
  if (!visible || row.author_id === viewer.userId || row.status === "withdrawn") return { ok: false };
  const isAdmin = viewer.roles.isNamespaceAdmin(row.namespace_id);
  if (isAdmin) return { ok: true, row, isAdmin };
  const pastTriage = row.status !== "awaiting_triage";
  if (pastTriage && (viewer.roles.isCommittee(row.namespace_id) || row.assignee_id === viewer.userId)) return { ok: true, row, isAdmin };
  return { ok: false };
}

async function effective(pool: Pool, ai: AiClient): Promise<boolean> {
  return (await readAiSwitch(pool, aiFeatureSwitchKey(TRIAGE_FEATURE))) && (await ai.available(TRIAGE_FEATURE));
}

/** The note for `viewer`, or null when they may not see one (the route answers 404). */
export async function getTriageNotes(pool: Pool, ai: AiClient, viewer: Viewer, number: string): Promise<TriageNotesView | null> {
  const a = await access(pool, viewer, number);
  if (!a.ok) return null;
  const { row } = a;
  const isEffective = await effective(pool, ai);
  const restrictedOk = await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent);
  const restrictedBlocked = row.visibility === "namespace" && !restrictedOk;
  const subject = isTriageSubject(row.status);

  const { rows: results } = await pool.query<{ status: "pending" | "ready" | "failed"; input_hash: string | null; payload: TriageNotes | null; updated_at: Date }>(
    `select status, input_hash, payload, updated_at from ai_results where kind = $1 and parent_type = 'challenge' and parent_id = $2`,
    [TRIAGE_FEATURE, row.id],
  );
  const r = results[0];
  const current = !!r && r.input_hash === row.hash;
  const coming = isEffective && subject && !restrictedBlocked && (!r || !current || r.status === "pending");

  let state: TriageNotesView["state"];
  if (coming) state = "pending";
  else if (r?.status === "failed" && current) state = "failed";
  else if (r?.payload) state = "ready";
  else state = "none";

  // Neither a note nor one coming, and the task is off: there is nothing to show at all.
  if (state === "none" && !isEffective) return null;

  let notes: TriageNotesView["notes"] = null;
  if (r?.payload) {
    const p = r.payload;
    const numbers = p.duplicates.map((d) => String(d.number));
    const dupRows = numbers.length
      ? (
          await pool.query<{ number: string; title: string; status: string; visibility: "org" | "namespace"; namespace_id: string; author_id: string }>(
            `select number::text, title, status, visibility, namespace_id, author_id from challenges
              where number::text = any($1::text[]) and trashed_at is null`,
            [numbers],
          )
        ).rows
      : [];
    const duplicates: TriageDuplicateView[] = [];
    for (const d of p.duplicates) {
      const c = dupRows.find((x) => x.number === String(d.number));
      if (!c) continue; // deleted or trashed since
      if (!canSeeChallenge(viewer, { namespaceId: c.namespace_id, visibility: c.visibility, status: c.status as ChallengeStatus, authorId: c.author_id, trashed: false })) continue;
      if (c.status === "withdrawn") continue;
      duplicates.push({ number: `CH-${c.number}`, title: c.title, reason: d.reason });
    }
    notes = { ...p, duplicates };
  }

  return {
    effective: isEffective,
    state,
    current,
    restrictedBlocked: subject && restrictedBlocked,
    canRerun: a.isAdmin && isEffective && subject && !restrictedBlocked && state !== "pending",
    generatedAt: r?.payload ? r.updated_at.toISOString() : null,
    notes,
  };
}

/** Re-run (namespace and platform admins): clears the hash so the worker makes a fresh note. */
export async function rerunTriageNotes(pool: Pool, ai: AiClient, viewer: Viewer, number: string): Promise<"ok" | "not_found" | "trashed" | "forbidden" | "unavailable"> {
  const a = await access(pool, viewer, number);
  if (!a.ok) return a.trashed ? "trashed" : "not_found";
  if (!a.isAdmin) return "forbidden";
  if (!isTriageSubject(a.row.status)) return "unavailable";
  if (!(await effective(pool, ai))) return "unavailable";
  if (a.row.visibility === "namespace" && !(await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent))) return "unavailable";
  await pool.query(
    `insert into ai_results (kind, parent_type, parent_id, input_hash, status, requested_by)
     values ($1, 'challenge', $2, null, 'pending', $3)
     on conflict (kind, parent_type, parent_id)
     do update set input_hash = null, status = 'pending', error_code = null, requested_by = excluded.requested_by, updated_at = now()`,
    [TRIAGE_FEATURE, a.row.id, viewer.userId],
  );
  return "ok";
}

export type TriageQueueNote = "ready" | "pending" | "failed" | null;

/** The §14.1 queue indicator for many challenges at once (admins only — the queue is theirs).
 *  Null on the reader's own challenges: an author never learns a note exists. */
export async function triageQueueNotes(pool: Pool, ai: AiClient, viewerUserId: string, challengeNumbers: string[]): Promise<Map<string, TriageQueueNote>> {
  const out = new Map<string, TriageQueueNote>();
  if (challengeNumbers.length === 0) return out;
  const isEffective = await effective(pool, ai);
  const restrictedOk = await readAiSwitch(pool, AI_SETTING_KEYS.restrictedContent);
  const { rows } = await pool.query<{ number: string; status: string; visibility: string; author_id: string; current: boolean | null; result_status: string | null; has_payload: boolean }>(
    `select c.number::text, c.status, c.visibility, c.author_id,
            (r.input_hash = ${TRIAGE_INPUT_HASH_SQL}) as current, r.status as result_status, (r.payload is not null) as has_payload
       from challenges c
       join impact_areas ia on ia.id = c.impact_area_id
       left join ai_results r on r.kind = $1 and r.parent_type = 'challenge' and r.parent_id = c.id
      where c.number::text = any($2::text[])`,
    [TRIAGE_FEATURE, challengeNumbers.map((n) => n.replace(/^CH-/, ""))],
  );
  for (const r of rows) {
    if (r.author_id === viewerUserId) {
      out.set(`CH-${r.number}`, null);
      continue;
    }
    const subject = isTriageSubject(r.status) && (r.visibility === "org" || restrictedOk);
    let note: TriageQueueNote = null;
    if (isEffective && subject && (r.result_status === null || r.current !== true || r.result_status === "pending")) note = "pending";
    else if (r.result_status === "failed" && r.current) note = "failed";
    else if (r.has_payload) note = "ready";
    out.set(`CH-${r.number}`, note);
  }
  return out;
}
