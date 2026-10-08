// Leader election via a Postgres session-scoped advisory lock (ENTRA_AUTH_SPEC.md §5,
// the SCIM provisioning topology): background loops run on exactly ONE worker replica.
// The lock is held on a DEDICATED pg Client, never the pool — a session lock acquired on
// a pooled connection is silently released when the pool recycles the session, which
// would let two replicas reconcile concurrently. Losing the connection therefore IS
// losing leadership: the loop demotes, reconnects, and competes again. Nothing in here
// ever throws out of the loop.
import { Client } from "pg";

/** "innobox" in hex — the app-wide advisory-lock key for the singleton worker loops. */
export const WORKER_LEADER_LOCK_KEY = 0x696e6e6f626f78n;

export interface LeaderElection {
  isLeader(): boolean;
  /** Stops the loop and ends the session — Postgres releases the lock server-side. */
  stop(): Promise<void>;
}

export function startLeaderElection(
  databaseUrl: string,
  opts: {
    lockKey: bigint | number;
    onAcquired?: () => void;
    onLost?: () => void;
    /** Lock-retry / liveness-probe cadence. Default 15s. */
    retryIntervalMs?: number;
  },
): LeaderElection {
  const intervalMs = opts.retryIntervalMs ?? 15_000;
  // pg has no native bigint parameter encoding — send text, cast in SQL.
  const lockKey = opts.lockKey.toString();
  let leader = false;
  let stopped = false;
  let client: Client | null = null;
  let wake: (() => void) | null = null;

  function log(level: "info" | "warn", msg: string, extra?: Record<string, unknown>): void {
    console.log(JSON.stringify({ level, msg, lockKey, ...extra }));
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      t.unref();
      wake = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
    });
  }

  // Tear down a dead session and demote if it held the lock (the DB already released it
  // when the session died). Guarded against stale events from already-replaced clients.
  function connectionDown(c: Client, reason: string): void {
    if (client !== c) return;
    client = null;
    void c.end().catch(() => {});
    if (leader) {
      leader = false;
      if (!stopped) {
        log("warn", "leader lock lost", { reason });
        opts.onLost?.();
      }
    }
  }

  const done = (async () => {
    while (!stopped) {
      try {
        if (!client) {
          const fresh = new Client({ connectionString: databaseUrl });
          // Without an 'error' listener a mid-session backend death would crash the
          // process; with it, the loop just demotes and reconnects on its next tick.
          fresh.on("error", () => connectionDown(fresh, "connection error"));
          fresh.on("end", () => connectionDown(fresh, "connection ended"));
          client = fresh;
          await fresh.connect();
        }
        const c = client;
        if (c) {
          if (!leader) {
            const { rows } = await c.query<{ locked: boolean }>(
              "select pg_try_advisory_lock($1::bigint) as locked",
              [lockKey],
            );
            if (rows[0]?.locked === true) {
              leader = true;
              log("info", "leader lock acquired");
              opts.onAcquired?.();
            }
          } else {
            // Liveness probe: a silently-dead session means the DB has already released
            // the lock — surface that as leadership loss rather than split-brain.
            await c.query("select 1");
          }
        }
      } catch (err) {
        log("warn", "leader election tick failed", {
          error: String((err as Error).message ?? err).slice(0, 300),
        });
        if (client) connectionDown(client, "query failed");
      }
      if (!stopped) await sleep(intervalMs);
    }
  })();

  return {
    isLeader: () => leader,
    async stop() {
      stopped = true;
      wake?.();
      await done;
      const c = client;
      client = null;
      leader = false;
      if (c) await c.end().catch(() => {});
    },
  };
}
