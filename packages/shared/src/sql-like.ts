// §2.4 *Substring filters are literal* (INNOBOX_SPEC.md): the ONE escape every free-text
// "contains" filter runs before wrapping the user's text in `%…%` for a LIKE/ILIKE — the §13.1
// gallery and §13.4 search author filters, the §14.1 triage author filter, the §7.3 directory
// search, the §15 audit browser and the §14.7 system-log search. `%`, `_` and `\` are escaped
// with a backslash so they match themselves: a query of `%` or `_` then matches nothing rather
// than everything, and the directory cannot be paged through with a wildcard.
//
// Postgres's LIKE/ILIKE default escape character is the backslash (`ESCAPE '\'` is implied when
// no ESCAPE clause is given), so `col ILIKE $1` with a parameter built from this helper needs no
// explicit ESCAPE clause. The value travels as a bound parameter — standard_conforming_strings is
// irrelevant, nothing here is spliced into SQL text.

/** Escapes `\`, `%` and `_` as `\\`, `\%` and `\_` for a LIKE/ILIKE pattern. Pure; empty in → empty out. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
