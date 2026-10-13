// A challenge accepted from the public form (INNOBOX_SPEC.md §24.6–§24.8) reaching its outcome.
// Called inside every transaction that moves a challenge's status (the detail PATCH, the §14.1
// bulk actions, and the §8.3 auto-close), right after the UPDATE: on the challenge's FIRST
// transition into `solved` or `rejected` it stamps the submission's `contact_erase_due_at` (90
// days on, §24.8) and queues the outcome e-mail (§24.7). The stamp is the "sent once" flag — a
// later status change, even back out and into `solved` again, never re-arms it. Every other
// challenge, and every other status, is a no-op costing one indexed lookup.
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { PoolClient } from "pg";
import { CONTACT_RETENTION_DAYS, outcomeEmail } from "@innobox/shared";
import { enqueueSubmitterEmail } from "../../../lib/public-intake-mail";

export async function onExternalChallengeClosed(client: PoolClient, challengeId: string, newStatus: string): Promise<void> {
  if (newStatus !== "solved" && newStatus !== "rejected") return;
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
  if (!row) return;
  // The title as submitted (an admin may have edited the challenge's on accept). No mail once the
  // contact details are erased — enqueueSubmitterEmail skips a null address.
  await enqueueSubmitterEmail(client, row.id, row.submitter_email, outcomeEmail(row.title, newStatus));
}
