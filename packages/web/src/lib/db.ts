// Server-only Postgres pool. Connects as the least-privilege innobox_app role via
// DATABASE_URL (db/migrations/0001). Lazy singleton behind a Proxy: importing this
// module (e.g. during `next build` page collection) never opens sockets and doesn't
// require DATABASE_URL — the pool materializes on first use with a clear error if
// the env is missing. All queries are parameterized; there is no ORM (§2).
import type { Pool as PoolType, PoolClient } from "pg";
import { Pool } from "pg";

let realPool: PoolType | null = null;

function getPool(): PoolType {
  if (!realPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    realPool = new Pool({ connectionString: url });
  }
  return realPool;
}

export const pool: PoolType = new Proxy({} as PoolType, {
  get(_target, prop: keyof PoolType) {
    const p = getPool();
    const value = p[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(p) : value;
  },
});

/** BEGIN/COMMIT/ROLLBACK boilerplate shared by every store.ts that needs an atomic
 *  write + audit row (§15) — previously reimplemented identically in challenges/store.ts,
 *  comments/store.ts, and admin/store.ts. Imported via a relative path (not `@/db`) from
 *  those modules so the gated `.dbtest.ts` suites can still run under the plain node
 *  test runner. */
export async function inTransaction<T>(pool: PoolType, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
