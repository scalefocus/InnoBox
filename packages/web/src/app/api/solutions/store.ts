// Data layer for GET /api/solutions/:number (INNOBOX_SPEC.md §16): the solution detail read.
// There is no standalone solution page (§13.1 — the deep link resolves to the parent challenge
// page), so this read is built FROM the challenge detail: the parent goes through the same
// visibility gate (§4.3) and the solution through the same per-solution visibility rule and
// anonymity masking (§9) as on the challenge page. A solution the viewer cannot see — its parent
// is hidden, or it is a `proposed` solution they may not see — is indistinguishable from a
// missing one (null → 404, invariant 2).
// Relative imports only (no `@/`) so the gated .dbtest.ts suite runs under the plain node runner.
import type { Pool } from "pg";
import { getChallengeByNumber, type SolutionListItem, type Viewer } from "../challenges/store";
import { isEntityNumber } from "../challenges/validation";

export interface SolutionDetail {
  solution: SolutionListItem;
  /** The parent challenge, for context and the deep link (`/challenges/:n#SOL-:m`). */
  challenge: { id: string; number: string; title: string; status: string };
}

export async function getSolutionByNumber(pool: Pool, viewer: Viewer, number: string): Promise<SolutionDetail | null> {
  if (!isEntityNumber(number)) return null;
  const { rows } = await pool.query<{ challenge_number: string }>(
    `select c.number::text as challenge_number from solutions s join challenges c on c.id = s.challenge_id where s.number = $1`,
    [number],
  );
  const parentNumber = rows[0]?.challenge_number;
  if (!parentNumber) return null;
  const challenge = await getChallengeByNumber(pool, viewer, parentNumber);
  if (!challenge) return null;
  // `challenge.solutions` is already filtered to what this viewer may see, and masked.
  const solution = challenge.solutions.find((s) => s.number.replace(/\D/g, "") === number);
  if (!solution) return null;
  return { solution, challenge: { id: challenge.id, number: challenge.number, title: challenge.title, status: challenge.status } };
}
