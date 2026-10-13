// Data layer for the §24 public submission routes (INNOBOX_SPEC.md §24.4, §24.5): receiving a
// submission from the form and confirming it through the e-mailed link. Unauthenticated callers
// only reach this after the route has checked the form is live, the per-IP limit, the body and the
// proof-of-work signature; what is left here is the database's part — the spent-salt check, the
// per-address cap, the platform ceiling, the row, its confirmation e-mail, and on confirm the
// §12.1 event 14 to every platform admin. Nothing here is audited or system-logged (§24.4).
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { Pool } from "pg";
import {
  CONFIRM_TOKEN_TTL_MS,
  PER_ADDRESS_WINDOW_MS,
  PLATFORM_WINDOW_MS,
  confirmationEmail,
  generateConfirmToken,
  hashConfirmToken,
  isAddressCapped,
  isPlatformCeilingReached,
  normalizeEmailForCap,
  type PublicSubmissionFields,
} from "@innobox/shared";
import { inTransaction } from "../../../lib/db";
import { dispatchAdminAttention, getPlatformAdminUserIds } from "../../../lib/notify";
import { enqueueSubmitterEmail } from "../../../lib/public-intake-mail";

export type ReceiveResult =
  /** Stored, confirmation e-mail queued. `token` is returned for the dev/e2e seam only. */
  | { status: "received"; id: string; token: string }
  /** The salt bought a row already (→ 403). */
  | { status: "spent" }
  /** 3 confirmation e-mails to this address in 24 h (→ the normal 202, silently). */
  | { status: "address_capped" }
  /** 100 confirmation e-mails in the last hour (→ 429). */
  | { status: "ceiling" };

/** One lock name serializes the cap checks with the insert, so two racing requests cannot both
 *  slip under a cap. The form's traffic is tiny; the lock is held for one short transaction. */
const INTAKE_LOCK = "innobox.public_intake";

export async function receiveSubmission(pool: Pool, fields: PublicSubmissionFields, powSalt: string): Promise<ReceiveResult> {
  return inTransaction(pool, async (client): Promise<ReceiveResult> => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [INTAKE_LOCK]);

    const { rows: spent } = await client.query(`select 1 from public_submissions where pow_salt = $1`, [powSalt]);
    if (spent.length > 0) return { status: "spent" };

    const { rows: counts } = await client.query<{ address: number; platform: number }>(
      `select count(*) filter (where lower(submitter_email) = $1 and created_at > now() - make_interval(secs => $2))::int as address,
              count(*) filter (where created_at > now() - make_interval(secs => $3))::int as platform
         from public_submissions
        where created_at > now() - make_interval(secs => greatest($2, $3))`,
      [normalizeEmailForCap(fields.email), PER_ADDRESS_WINDOW_MS / 1000, PLATFORM_WINDOW_MS / 1000],
    );
    if (isAddressCapped(counts[0]?.address ?? 0)) return { status: "address_capped" };
    if (isPlatformCeilingReached(counts[0]?.platform ?? 0)) return { status: "ceiling" };

    const token = generateConfirmToken();
    const { rows } = await client.query<{ id: string }>(
      `insert into public_submissions
         (title, description, submitter_name, submitter_email, company, confirm_token_hash, confirm_expires_at, pow_salt)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8)
       on conflict (pow_salt) do nothing
       returning id`,
      [fields.title, fields.description, fields.name, fields.email, fields.company, hashConfirmToken(token), CONFIRM_TOKEN_TTL_MS / 1000, powSalt],
    );
    const id = rows[0]?.id;
    if (!id) return { status: "spent" };
    // The confirmation carries nothing the submitter wrote — only the fixed text and the link.
    await enqueueSubmitterEmail(client, id, fields.email, confirmationEmail(token));
    return { status: "received", id, token };
  });
}

export type ConfirmResult = { status: "confirmed"; id: string } | { status: "invalid" };

/** Valid, unexpired and unused → `pending_review`, the token hash cleared, and event 14 to every
 *  platform admin. Unknown, expired and already used are one answer (§24.5). */
export async function confirmSubmission(pool: Pool, token: string): Promise<ConfirmResult> {
  const { rows } = await pool.query<{ id: string }>(
    `update public_submissions
        set status = 'pending_review', confirmed_at = now(), confirm_token_hash = null
      where confirm_token_hash = $1 and status = 'unconfirmed' and confirm_expires_at > now()
      returning id`,
    [hashConfirmToken(token)],
  );
  const id = rows[0]?.id;
  if (!id) return { status: "invalid" };
  // §12.1 event 14 — the message names no submitter and quotes nothing they wrote.
  await dispatchAdminAttention(pool, await getPlatformAdminUserIds(pool), "public_submission_confirmed", {
    message: "A new public submission is waiting for review.",
    link: "/admin/public-submissions",
  }).catch((err) => console.error(JSON.stringify({ level: "error", msg: "public submission notification failed", error: String(err) })));
  return { status: "confirmed", id };
}
