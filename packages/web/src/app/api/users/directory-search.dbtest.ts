// Live-DB integration test (gated) for the §2.4 *Substring filters are literal* rule on the §7.3
// directory search (INNOBOX_SPEC.md): `GET /api/users?q=` escapes `%`, `_` and `\` before the
// ILIKE, so a wildcard query no longer matches everyone and a literal name still matches.
// Self-skips when DATABASE_URL is unset.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.DATABASE_URL;

test(
  "directory search: `%` and `_` are literal — a wildcard query no longer matches a plain name, a name carrying them still matches",
  { skip: url ? false : "DATABASE_URL not set — live-DB suite self-skips" },
  async () => {
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const { searchActiveUsers, searchUsersForAdmin } = await import("./store");

    const pool = new Pool({ connectionString: url });
    try {
      const stamp = randomUUID().slice(0, 8);
      const insert = async (name: string, tag: string): Promise<string> => {
        const { rows } = await pool.query<{ id: string }>(
          `insert into users (external_id, user_name, display_name, email, active) values ($1, $2, $3, $4, true) returning id`,
          [`dbtest-${tag}-${stamp}`, `dbtest-${tag}-${stamp}@example.test`, name, `${tag}-${stamp}@example.test`],
        );
        return rows[0]!.id;
      };
      // One plain name (no LIKE metacharacters at all) and one that carries them.
      const plainId = await insert(`Dbtest Plain ${stamp}`, "plain");
      const literalId = await insert(`Dbtest 100%_lit ${stamp}`, "literal");
      const hits = async (q: string, admin = false): Promise<Set<string>> =>
        new Set((admin ? await searchUsersForAdmin(pool, q) : await searchActiveUsers(pool, q)).map((u) => u.id));

      // Unescaped, every one of these would match the plain user. Escaped, none does.
      for (const q of ["%", "_", `%${stamp}`, `Dbtest_Plain`, `Plain_${stamp}`, `%Plain%`]) {
        assert.equal((await hits(q)).has(plainId), false, `${JSON.stringify(q)} must not act as a wildcard`);
      }
      assert.equal((await hits("%", true)).has(plainId), false, "the admin directory search follows the same rule");

      // A literal name still matches — including one whose own text carries `%` and `_`.
      assert.ok((await hits(`Dbtest Plain ${stamp}`)).has(plainId), "the plain name matches itself");
      assert.ok((await hits(`plain ${stamp}`)).has(plainId), "still case-insensitive");
      assert.ok((await hits(`100%_lit ${stamp}`)).has(literalId), "a name with % and _ matches when typed literally");
      assert.ok((await hits("100%_lit")).has(literalId));
      assert.equal((await hits("100%_lit")).has(plainId), false);
      assert.ok((await hits(`literal-${stamp}@`)).has(literalId), "e-mail search unchanged");
      assert.ok((await hits(`100%_lit ${stamp}`, true)).has(literalId));
    } finally {
      await pool.end();
    }
  },
);
