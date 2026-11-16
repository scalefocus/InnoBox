// A challenge accepted from the public form (INNOBOX_SPEC.md §24.6–§24.8) reaching its outcome.
// Called inside every transaction that moves a challenge's status (the detail PATCH, the §14.1
// bulk actions, and the §8.3 auto-close), right after the UPDATE: on the challenge's FIRST
// transition into `solved` or `rejected` it stamps the submission's `contact_erase_due_at` (90
// days on, §24.8) and queues the outcome e-mail (§24.7). The stamp is the "sent once" flag — a
// later status change, even back out and into `solved` again, never re-arms it. Every other
// challenge, and every other status, is a no-op costing one indexed lookup.
//
// §42.6: while a challenge is a duplicate its submission's outcome FOLLOWS ITS ORIGINAL — the same
// transition also settles every duplicate pointing at the challenge, and a withdrawn original
// counts as closed without a solution. A deleted original sends nothing but starts the clock.
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { PoolClient } from "pg";
import { CONTACT_RETENTION_DAYS, mergedEmail, outcomeEmail } from "@innobox/shared";
import { enqueueSubmitterEmail } from "../../../lib/public-intake-mail";

export async function onExternalChallengeClosed(client: PoolClient, challengeId: string, newStatus: string): Promise<void> {
  if (newStatus === "solved" || newStatus === "rejected") {
    const { rows } = await client.query<{ id: string; title: string; submitter_email: string | null }>(
      `update public_submissions ps
          set contact_erase_due_at = now() + make_interval(days => $2)
         from challenges c
        where c.id = $1 and ps.id = c.public_submission_id and ps.contact_erase_due_at is null
          and c.trashed_at is null -- §24.7: a trashed challenge sends nothing (§10.4)
        returning ps.id, ps.title, ps.submitter_email`,
      [challengeId, CONTACT_RETENTION_DAYS],
    );
    const row = rows[0];
    // The title as submitted (an admin may have edited the challenge's on accept). No mail once the
    // contact details are erased — enqueueSubmitterEmail skips a null address.
    if (row) await enqueueSubmitterEmail(client, row.id, row.submitter_email, outcomeEmail(row.title, newStatus));
  }
  await settleDuplicateOutcomes(client, challengeId, newStatus);
}

/** §42.6: the outcome a duplicate's submitter hears when its original reaches `status` — null while
 *  the original is still open. A withdrawn original counts as closed without a solution. */
export function duplicateOutcomeFor(originalStatus: string): "solved" | "rejected" | null {
  if (originalStatus === "solved") return "solved";
  if (originalStatus === "rejected" || originalStatus === "withdrawn") return "rejected";
  return null;
}

/**
 * §42.6: every duplicate pointing at `originalId` whose submission has no outcome yet gets the
 * original's — the outcome mail, and the 90-day erasure clock from now. A no-op while the original
 * is open, and for a duplicate in the trash (it sends nothing, §10.4).
 */
export async function settleDuplicateOutcomes(client: PoolClient, originalId: string, originalStatus: string): Promise<void> {
  const outcome = duplicateOutcomeFor(originalStatus);
  if (!outcome) return;
  const { rows } = await client.query<{ id: string; title: string; submitter_email: string | null }>(
    `update public_submissions ps
        set contact_erase_due_at = now() + make_interval(days => $2)
       from challenges d
      where d.duplicate_of_id = $1 and d.status = 'duplicate' and d.trashed_at is null
        and ps.id = d.public_submission_id and ps.contact_erase_due_at is null
      returning ps.id, ps.title, ps.submitter_email`,
    [originalId, CONTACT_RETENTION_DAYS],
  );
  for (const row of rows) await enqueueSubmitterEmail(client, row.id, row.submitter_email, outcomeEmail(row.title, outcome));
}

/**
 * §42.6: the mark itself. A duplicate made from a public submission tells its submitter that it
 * joins an existing challenge — at most once (`merge_mailed_at`), and never once its outcome was
 * already sent. When the original has already closed, the outcome goes at once instead
 * (settleDuplicateOutcomes, which the mark calls after this). Returns whether a mail was queued.
 */
export async function onMarkedDuplicate(client: PoolClient, duplicateId: string, originalStatus: string): Promise<boolean> {
  if (duplicateOutcomeFor(originalStatus) !== null) return false;
  const { rows } = await client.query<{ id: string; title: string; submitter_email: string | null }>(
    `update public_submissions ps
        set merge_mailed_at = now()
       from challenges d
      where d.id = $1 and ps.id = d.public_submission_id
        and ps.merge_mailed_at is null and ps.contact_erase_due_at is null
      returning ps.id, ps.title, ps.submitter_email`,
    [duplicateId],
  );
  const row = rows[0];
  if (!row) return false;
  await enqueueSubmitterEmail(client, row.id, row.submitter_email, mergedEmail(row.title));
  return true;
}

// §42.7: a deleted original's duplicates start their erasure clocks inside the purge itself
// (@innobox/shared/item-delete), which the worker's trash purge shares.
