// Data layer for the §24.5 review queue (INNOBOX_SPEC.md §24.5–§24.9): platform admins only (the
// routes gate it). The queue lists confirmed submissions; an unconfirmed row is invisible here, as
// everywhere. Each decision locks its row and refuses (409) a row someone else already decided:
//   - accept  → ONE transaction: an ordinary challenge in awaiting_triage with a new number, no
//               author and `public_submission_id` set; the row `accepted`; the "under review" mail;
//               audited as `challenge.created` (`source: "public"`) and `public_submission.accepted`.
//   - decline → the row `declined`, the optional note mailed, audited without the note.
//   - discard → the row deleted outright, nothing sent.
// Erasing the contact details works on any confirmed row. No audit payload ever carries the
// submitter's name or e-mail. Relative imports only (no `@/`) so the gated .dbtest.ts suites run
// under the plain node runner.
import type { Pool, PoolClient } from "pg";
import {
  DECIDED_LIST_DAYS,
  DECLINE_NOTE_MAX,
  acceptedEmail,
  declinedEmail,
  formatChallengeNumber,
  validateChallengeFields,
} from "@innobox/shared";
import { appendAudit } from "../../../../lib/audit";
import { inTransaction } from "../../../../lib/db";
import { enqueueSubmitterEmail, withdrawSubmitterEmails } from "../../../../lib/public-intake-mail";
import { findSimilarChallenges, type SimilarChallenge, type Viewer } from "../../challenges/store";

export type QueueTab = "pending" | "decided";

export interface PublicSubmissionRow {
  id: string;
  status: "pending_review" | "accepted" | "declined";
  title: string;
  company: string | null;
  /** Null once erased (§24.8). */
  name: string | null;
  email: string | null;
  confirmedAt: string | null;
  decidedAt: string | null;
  contactErasedAt: string | null;
  /** The challenge an accepted row became ("CH-12"); null otherwise. */
  challengeNumber: string | null;
}

export interface PublicSubmissionDetail extends PublicSubmissionRow {
  description: string;
  declineNote: string | null;
  /** §6.1 similarity, run as the reviewing admin; authors masked per §9. */
  similar: SimilarChallenge[];
}

interface QueueDbRow {
  id: string;
  status: PublicSubmissionRow["status"];
  title: string;
  description: string;
  company: string | null;
  submitter_name: string | null;
  submitter_email: string | null;
  confirmed_at: Date | null;
  decided_at: Date | null;
  contact_erased_at: Date | null;
  decline_note: string | null;
  challenge_number: string | null;
}

const QUEUE_SELECT = `
  select ps.id, ps.status, ps.title, ps.description, ps.company, ps.submitter_name, ps.submitter_email,
         ps.confirmed_at, ps.decided_at, ps.contact_erased_at, ps.decline_note, c.number::text as challenge_number
    from public_submissions ps
    left join challenges c on c.public_submission_id = ps.id`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toRow(r: QueueDbRow): PublicSubmissionRow {
  return {
    id: r.id,
    status: r.status,
    title: r.title,
    company: r.company,
    name: r.submitter_name,
    email: r.submitter_email,
    confirmedAt: iso(r.confirmed_at),
    decidedAt: iso(r.decided_at),
    contactErasedAt: iso(r.contact_erased_at),
    challengeNumber: r.challenge_number ? formatChallengeNumber(r.challenge_number) : null,
  };
}

/** Pending review (oldest first), or decided in the last 90 days (newest first). */
export async function listPublicSubmissions(pool: Pool, tab: QueueTab): Promise<PublicSubmissionRow[]> {
  const sql =
    tab === "pending"
      ? `${QUEUE_SELECT} where ps.status = 'pending_review' order by ps.confirmed_at asc, ps.created_at asc limit 500`
      : `${QUEUE_SELECT} where ps.status in ('accepted', 'declined') and ps.decided_at > now() - make_interval(days => $1)
          order by ps.decided_at desc limit 500`;
  const { rows } = await pool.query<QueueDbRow>(sql, tab === "pending" ? [] : [DECIDED_LIST_DAYS]);
  return rows.map(toRow);
}

/** The console card's bubble: rows waiting for a decision. */
export async function countPendingPublicSubmissions(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from public_submissions where status = 'pending_review'`);
  return rows[0]?.n ?? 0;
}

/** A confirmed row with its description and the §6.1 matches; null for unknown or unconfirmed. */
export async function getPublicSubmission(pool: Pool, viewer: Viewer, id: string): Promise<PublicSubmissionDetail | null> {
  const { rows } = await pool.query<QueueDbRow>(`${QUEUE_SELECT} where ps.id = $1 and ps.status <> 'unconfirmed'`, [id]);
  const row = rows[0];
  if (!row) return null;
  const similar = await findSimilarChallenges(pool, viewer, { title: row.title, description: row.description });
  return { ...toRow(row), description: row.description, declineNote: row.decline_note, similar };
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────────

interface LockedRow {
  id: string;
  status: string;
  title: string;
  description: string;
  company: string | null;
  submitter_email: string | null;
  contact_erased_at: Date | null;
}

/** The row, locked for this transaction — null for unknown or unconfirmed (both "not found"). */
async function lockSubmission(client: PoolClient, id: string): Promise<LockedRow | null> {
  const { rows } = await client.query<LockedRow>(
    `select id, status, title, description, company, submitter_email, contact_erased_at
       from public_submissions where id = $1 for update`,
    [id],
  );
  const row = rows[0];
  return row && row.status !== "unconfirmed" ? row : null;
}

export type DecisionRefusal = { status: "not_found" } | { status: "conflict" };

export interface AcceptInput {
  namespaceId: string;
  visibility: unknown;
  impactAreaId: string;
  clientName: unknown;
  title: unknown;
  description: unknown;
}

export type AcceptResult =
  | { status: "ok"; challengeId: string; number: string; namespaceId: string; title: string }
  | DecisionRefusal
  | { status: "unknown_namespace" }
  | { status: "namespace_archived" }
  | { status: "unknown_impact_area" }
  | { status: "inactive_impact_area" }
  | { status: "invalid"; error: string };

/** §24.6 accept: the normal §6.1 create rules (namespace not archived, an active impact area,
 *  the field limits, the Client pairing), with the admin's choices and possibly edited text. */
export async function acceptPublicSubmission(pool: Pool, admin: Viewer, id: string, input: AcceptInput): Promise<AcceptResult> {
  const { rows: nsRows } = await pool.query<{ archived: boolean }>(`select archived_at is not null as archived from namespaces where id = $1`, [input.namespaceId]);
  if (!nsRows[0]) return { status: "unknown_namespace" };
  if (nsRows[0].archived) return { status: "namespace_archived" };
  const { rows: areaRows } = await pool.query<{ name: string; active: boolean }>(`select name, active from impact_areas where id = $1`, [input.impactAreaId]);
  const area = areaRows[0];
  if (!area) return { status: "unknown_impact_area" };
  if (!area.active) return { status: "inactive_impact_area" };

  const validated = validateChallengeFields({
    title: input.title,
    description: input.description,
    clientName: input.clientName,
    visibility: input.visibility,
    isAnonymous: false,
    impactAreaIsClient: area.name === "Client",
  });
  if (!validated.ok) return { status: "invalid", error: validated.error };
  const fields = validated.value;

  return inTransaction(pool, async (client): Promise<AcceptResult> => {
    const row = await lockSubmission(client, id);
    if (!row) return { status: "not_found" };
    if (row.status !== "pending_review") return { status: "conflict" };

    const { rows: created } = await client.query<{ id: string; number: string }>(
      `insert into challenges (namespace_id, visibility, title, description, impact_area_id, client_name, is_anonymous, author_id, public_submission_id)
       values ($1, $2, $3, $4, $5, $6, false, null, $7)
       returning id, number::text`,
      [input.namespaceId, fields.visibility, fields.title, fields.description, input.impactAreaId, fields.clientName, id],
    );
    const challenge = created[0]!;
    await client.query(`update public_submissions set status = 'accepted', decided_at = now(), decided_by = $2 where id = $1`, [id, admin.userId]);
    // The title as the submitter wrote it — they know it by that, whatever the admin changed.
    await enqueueSubmitterEmail(client, id, row.submitter_email, acceptedEmail(row.title));

    const editedOnAccept = [
      ...(fields.title !== row.title ? ["title"] : []),
      ...(fields.description !== row.description ? ["description"] : []),
    ];
    const number = formatChallengeNumber(challenge.number);
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "challenge.created",
      targetType: "challenge",
      targetId: challenge.id,
      after: {
        title: fields.title,
        namespaceId: input.namespaceId,
        visibility: fields.visibility,
        isAnonymous: false,
        source: "public",
        publicSubmissionId: id,
        editedOnAccept,
      },
    });
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "public_submission.accepted",
      targetType: "public_submission",
      targetId: id,
      after: { challengeNumber: number },
    });
    return { status: "ok", challengeId: challenge.id, number, namespaceId: input.namespaceId, title: fields.title };
  });
}

/** The optional decline note: plain text, ≤ 1 000 characters, blank = none. */
export function parseDeclineNote(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "note must be text" };
  const value = raw.trim();
  if (value.length > DECLINE_NOTE_MAX) return { ok: false, error: `the note must be at most ${DECLINE_NOTE_MAX.toLocaleString("en-US")} characters` };
  return { ok: true, value: value || null };
}

export type SimpleDecisionResult = { status: "ok" } | DecisionRefusal;

export async function declinePublicSubmission(pool: Pool, admin: Viewer, id: string, note: string | null): Promise<SimpleDecisionResult> {
  return inTransaction(pool, async (client): Promise<SimpleDecisionResult> => {
    const row = await lockSubmission(client, id);
    if (!row) return { status: "not_found" };
    if (row.status !== "pending_review") return { status: "conflict" };
    await client.query(`update public_submissions set status = 'declined', decided_at = now(), decided_by = $2, decline_note = $3 where id = $1`, [
      id,
      admin.userId,
      note,
    ]);
    await enqueueSubmitterEmail(client, id, row.submitter_email, declinedEmail(row.title, note));
    // Whether a note went out — never the note itself.
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "public_submission.declined",
      targetType: "public_submission",
      targetId: id,
      after: { noteSent: note !== null },
    });
    return { status: "ok" };
  });
}

/** Spam: deleted at once, nothing sent. */
export async function discardPublicSubmission(pool: Pool, admin: Viewer, id: string): Promise<SimpleDecisionResult> {
  return inTransaction(pool, async (client): Promise<SimpleDecisionResult> => {
    const row = await lockSubmission(client, id);
    if (!row) return { status: "not_found" };
    if (row.status !== "pending_review") return { status: "conflict" };
    await withdrawSubmitterEmails(client, id);
    await client.query(`delete from public_submissions where id = $1`, [id]);
    await appendAudit(client, { actorUserId: admin.userId, action: "public_submission.discarded", targetType: "public_submission", targetId: id });
    return { status: "ok" };
  });
}

/** §24.8 manual erasure — on any confirmed row, at any time (e.g. when the submitter asks). A row
 *  already erased is an idempotent no-op. Takes any unsent mail to the address with it. */
export async function eraseSubmissionContact(pool: Pool, admin: Viewer, id: string): Promise<{ status: "ok"; erased: boolean } | { status: "not_found" }> {
  return inTransaction(pool, async (client) => {
    const row = await lockSubmission(client, id);
    if (!row) return { status: "not_found" as const };
    if (row.contact_erased_at) return { status: "ok" as const, erased: false };
    await client.query(`update public_submissions set submitter_name = null, submitter_email = null, contact_erased_at = now() where id = $1`, [id]);
    await withdrawSubmitterEmails(client, id);
    await appendAudit(client, {
      actorUserId: admin.userId,
      action: "public_submission.contact_erased",
      targetType: "public_submission",
      targetId: id,
      after: { trigger: "manual" },
    });
    return { status: "ok" as const, erased: true };
  });
}
