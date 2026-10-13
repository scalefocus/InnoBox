// §10.3 Delete permanently: the platform-admin gate in front of the shared purge
// (@innobox/shared/item-delete), which the worker's §10.4 retention purge runs too. Platform
// admins only — and a non-platform-admin caller (or any caller asking about an item they cannot
// see) gets `not_found`, never `forbidden`, so this endpoint can never be used as an existence
// oracle for a namespace-restricted item (invariant 2). It works on a live item (the danger zone)
// and on a trashed one (the trash page and the trashed detail view) alike.
import type { Pool } from "pg";
import { purgeChallenge, purgeSolution, type CascadeCounts } from "@innobox/shared/item-delete";
import type { StorageClient } from "../../../lib/storage";
import type { Viewer } from "./store";

export type { CascadeCounts };

export interface DeleteDeps {
  pool: Pool;
  storage: StorageClient;
}

export type DeleteChallengeResult = { status: "ok"; counts: CascadeCounts } | { status: "not_found" };

export type DeleteSolutionResult =
  | { status: "ok"; counts: CascadeCounts; challengeRevertedToValid: boolean }
  | { status: "not_found" };

/**
 * Permanently delete a challenge and everything under it — all of its solutions regardless of
 * status, and every comment, like, follow, attachment, notification, and unsent outbox row on
 * the challenge or those solutions (§10.3).
 */
export async function deleteChallenge(deps: DeleteDeps, admin: Viewer, number: string, reason: string): Promise<DeleteChallengeResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };
  return purgeChallenge(deps, number, { actorUserId: admin.userId, reason, trigger: "manual" });
}

/**
 * Permanently delete one solution and its own children, leaving the parent challenge standing
 * (§10.3). When the deleted solution was the `implemented` one of a `solved` challenge, the
 * challenge is un-solved back to `valid` in the same transaction.
 */
export async function deleteSolution(deps: DeleteDeps, admin: Viewer, number: string, reason: string): Promise<DeleteSolutionResult> {
  if (!admin.roles.isPlatformAdmin) return { status: "not_found" };
  return purgeSolution(deps, number, { actorUserId: admin.userId, reason, trigger: "manual" });
}
