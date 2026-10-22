// §39 Co-authors — the SQL every read path uses to see an item's team (INNOBOX_SPEC.md §39.2,
// §39.12). One place builds "who is on the team" so the gallery, the detail page, search, triage, the
// notification fan-out and the worker cannot disagree. Server-only by convention (SQL text), shared
// by the web tier and the worker. `alias` is the SQL alias of the `challenges` / `solutions` row.
import { maskAuthor } from "./challenges.js";
import { maskTeam, teamText, type TeamMemberRow } from "./coauthors.js";

/** `text[]` of the challenge's member ids, in team order (added_at, then user id). */
export function challengeAuthorIdsSql(alias: string): string {
  return `array(select ca.user_id::text from challenge_authors ca where ca.challenge_id = ${alias}.id order by ca.added_at, ca.user_id)`;
}

/** `text[]` of the solution's member ids, in team order. */
export function solutionAuthorIdsSql(alias: string): string {
  return `array(select sa.user_id::text from solution_authors sa where sa.solution_id = ${alias}.id order by sa.added_at, sa.user_id)`;
}

/** `boolean`: the user (a bound parameter or column) is a member of the challenge's team. */
export function isChallengeMemberSql(alias: string, user: string): string {
  return `exists (select 1 from challenge_authors cam where cam.challenge_id = ${alias}.id and cam.user_id = ${user})`;
}

/** `boolean`: the user is a member of the solution's team. */
export function isSolutionMemberSql(alias: string, user: string): string {
  return `exists (select 1 from solution_authors sam where sam.solution_id = ${alias}.id and sam.user_id = ${user})`;
}

/** `json` array of the challenge's members as `TeamMemberRow`s, in team order, with the creator
 *  flagged. Masking is the caller's (`maskTeam`): an anonymous item's row must never leave raw. */
export function challengeTeamJsonSql(alias: string): string {
  return `(select coalesce(json_agg(json_build_object('id', ca.user_id, 'displayName', tu.display_name, 'active', tu.active,
                  'scrubbed', tu.scrubbed_at is not null, 'creator', ca.user_id = ${alias}.author_id) order by ca.added_at, ca.user_id), '[]'::json)
             from challenge_authors ca join users tu on tu.id = ca.user_id where ca.challenge_id = ${alias}.id)`;
}

/** `json` array of the solution's members as `TeamMemberRow`s, in team order. */
export function solutionTeamJsonSql(alias: string): string {
  return `(select coalesce(json_agg(json_build_object('id', sa.user_id, 'displayName', tu.display_name, 'active', tu.active,
                  'scrubbed', tu.scrubbed_at is not null, 'creator', sa.user_id = ${alias}.author_id) order by sa.added_at, sa.user_id), '[]'::json)
             from solution_authors sa join users tu on tu.id = sa.user_id where sa.solution_id = ${alias}.id)`;
}

/** §39.5: the stale-copy check — the stored `edited_at` still matches the editor's `baseEditedAt`
 *  (a bound parameter, null for an item never edited). The API sends `editedAt` as a millisecond
 *  ISO string while the column keeps microseconds, so the two match within 2 ms — no two human edits
 *  are that close. Runs in the edit's own UPDATE, so the check and the write are one statement. */
export function sameEditSql(column: string, param: string): string {
  return `coalesce((${column} is null and ${param}::timestamptz is null)
                   or abs(extract(epoch from (${column} - ${param}::timestamptz))) < 0.002, false)`;
}

/**
 * §39.7 text surfaces: the author an e-mail or inbox line names — the first member plus "and N
 * others", "Anonymous" for an anonymous item, the §24.6 label for an external one. `team` is the
 * `*TeamJsonSql` column.
 */
export function teamDisplayText(item: {
  isAnonymous: boolean;
  authorId: string | null;
  authorDisplayName: string | null;
  externalCompany?: string | null;
  team: readonly TeamMemberRow[] | null;
}): string {
  const single = maskAuthor({
    isAnonymous: item.isAnonymous,
    authorId: item.authorId,
    authorDisplayName: item.authorDisplayName,
    externalCompany: item.externalCompany ?? null,
  });
  return teamText(maskTeam(single, item.team ?? []));
}
