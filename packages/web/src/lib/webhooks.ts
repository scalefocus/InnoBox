// The web tier's half of the §12.4 channel-webhook outbox (INNOBOX_SPEC.md): stamping
// `challenges.first_valid_at` and enqueuing one `webhook_deliveries` row per ENABLED webhook of
// the item's namespace when a milestone happens. Called from inside the status-change
// transaction (challenges/store.ts), so the rows become visible exactly when the transition
// commits — and a rolled-back transition enqueues nothing. A SAVEPOINT isolates the enqueue: a
// failure here is logged and never undoes the transition itself.
//
// The leak guard runs here (enqueue) and again in the worker before every send: an item that is
// not org-visible enqueues nothing (invariants 2–3), and becoming org-visible later never posts
// it retroactively. With WEBHOOK_ENC_KEY unset or invalid no delivery is enqueued.
//
// Relative imports only (no `@/`) so the gated .dbtest.ts suites run under the plain node runner.
import type { PoolClient } from "pg";
import { isOrgVisibleWebhookItem, type WebhookEvent } from "@innobox/shared";
import { parseWebhookKey } from "@innobox/shared/webhook-send";

/** WEBHOOK_ENC_KEY parsed afresh (cheap) — null when unset/invalid, i.e. webhooks are off. */
export function webhookKey(): Buffer | null {
  return parseWebhookKey(process.env.WEBHOOK_ENC_KEY);
}

export function webhooksConfigured(): boolean {
  return webhookKey() !== null;
}

const EVENT_STATUS: Record<WebhookEvent, string> = {
  "challenge.validated": "valid",
  "solution.implemented": "implemented",
  "challenge.solved": "solved",
};

function logEnqueueFailure(event: WebhookEvent, err: unknown): void {
  // The error text is a DB error at most — no URL is involved at enqueue.
  console.error(JSON.stringify({ level: "error", msg: "webhook enqueue failed", event, error: String(err) }));
}

/**
 * Enqueue `event` for the item, inside the caller's transaction. Returns the number of rows
 * written (0 when webhooks are off, the item fails the org-visible test, or its namespace has no
 * enabled webhook). Never throws.
 */
export async function enqueueWebhookEvent(
  client: PoolClient,
  event: WebhookEvent,
  entity: { type: "challenge" | "solution"; id: string },
): Promise<number> {
  if (!webhooksConfigured()) return 0;
  await client.query("savepoint webhook_enqueue");
  try {
    const { rows } =
      entity.type === "challenge"
        ? await client.query<{ namespace_id: string; visibility: string; status: string; solution_status: null }>(
            `select namespace_id, visibility, status, null as solution_status from challenges where id = $1`,
            [entity.id],
          )
        : await client.query<{ namespace_id: string; visibility: string; status: string; solution_status: string }>(
            `select c.namespace_id, c.visibility, c.status, s.status as solution_status
               from solutions s join challenges c on c.id = s.challenge_id
              where s.id = $1`,
            [entity.id],
          );
    const item = rows[0];
    let written = 0;
    if (item && isOrgVisibleWebhookItem({ challengeVisibility: item.visibility, challengeStatus: item.status, solutionStatus: item.solution_status })) {
      // occurred_at = now() is the transaction (= transition) time; created_at/next_attempt_at use
      // clock_timestamp() so two events of one transaction (the §8.3 auto-close posts
      // solution.implemented THEN challenge.solved) keep their order in the sweep.
      const res = await client.query(
        `insert into webhook_deliveries (webhook_id, event, entity_type, entity_id, event_status, occurred_at, next_attempt_at, created_at)
         select w.id, $2, $3, $4, $5, now(), clock_timestamp(), clock_timestamp()
           from channel_webhooks w
          where w.namespace_id = $1 and w.enabled`,
        [item.namespace_id, event, entity.type, entity.id, EVENT_STATUS[event]],
      );
      written = res.rowCount ?? 0;
    }
    await client.query("release savepoint webhook_enqueue");
    return written;
  } catch (err) {
    await client.query("rollback to savepoint webhook_enqueue").catch(() => {});
    logEnqueueFailure(event, err);
    return 0;
  }
}

/**
 * The challenge half, called right after a challenge's status UPDATE: the first transition into
 * `valid` stamps `first_valid_at` (never cleared, stamped even while webhooks are off) and is the
 * only one that posts `challenge.validated`; every real transition into `solved` posts
 * `challenge.solved`.
 */
export async function onChallengeStatusChanged(client: PoolClient, challengeId: string, newStatus: string): Promise<void> {
  if (newStatus === "valid") {
    const stamped = await client.query(`update challenges set first_valid_at = now() where id = $1 and first_valid_at is null`, [challengeId]);
    if ((stamped.rowCount ?? 0) > 0) await enqueueWebhookEvent(client, "challenge.validated", { type: "challenge", id: challengeId });
  } else if (newStatus === "solved") {
    await enqueueWebhookEvent(client, "challenge.solved", { type: "challenge", id: challengeId });
  }
}

/**
 * The solution half, called once the `implemented` transition (and its §8.3 auto-close) has been
 * written: `solution.implemented`, then `challenge.solved` — the latter only when the parent
 * really transitioned (it was not already `solved`).
 */
export async function onSolutionImplemented(client: PoolClient, solutionId: string, challengeId: string, challengeWasSolved: boolean): Promise<void> {
  await enqueueWebhookEvent(client, "solution.implemented", { type: "solution", id: solutionId });
  if (!challengeWasSolved) await enqueueWebhookEvent(client, "challenge.solved", { type: "challenge", id: challengeId });
}
