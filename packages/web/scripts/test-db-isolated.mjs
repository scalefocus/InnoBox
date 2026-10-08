// Ephemeral-database harness for the gated *.dbtest.ts suites (INNOBOX_SPEC.md §2.3).
//
// WHY: the dbtests INSERT namespaces/users/challenges/etc. that the app never hard-deletes,
// so running them against a shared database accumulates rows forever — which eventually breaks
// count-bounded assertions (e.g. the triage leaderboard's top-10 cap). This harness gives every
// run its OWN throwaway database: create → migrate → run the suites against it → drop. No shared
// state, deterministic results, and it works identically locally and in CI.
//
// The suites run as the least-privilege `innobox_app` role (not the admin) so a forgotten GRANT
// on a new table is still caught. Locally the role's existing dev password is reused and NEVER
// changed (so a running `pnpm dev` is unaffected); in CI, pass TEST_SET_APP_PASSWORD=1 to have
// the harness set it on the throwaway server.
//
// Config (env overrides file-derived defaults):
//   TEST_ADMIN_DATABASE_URL  admin conn that can CREATE/DROP DATABASE (default: from deploy/.env)
//   TEST_APP_DATABASE_URL    app-role conn template — user/password/host/port (db ignored)
//                            (default: from packages/web/.env.local DATABASE_URL)
//   TEST_SET_APP_PASSWORD=1  ALTER the app role's password to the template's (CI only)
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", ".."); // packages/web/scripts → repo root
const migrationsDir = path.join(repoRoot, "db", "migrations");

function parseEnvFile(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function resolveAdminUrl() {
  if (process.env.TEST_ADMIN_DATABASE_URL) return process.env.TEST_ADMIN_DATABASE_URL;
  const e = parseEnvFile(path.join(repoRoot, "deploy", ".env"));
  const user = e.POSTGRES_USER || "innobox";
  const pw = e.POSTGRES_PASSWORD;
  if (!pw) throw new Error("cannot resolve admin DB creds — set TEST_ADMIN_DATABASE_URL or POSTGRES_PASSWORD in deploy/.env");
  const db = e.POSTGRES_DB || "postgres";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pw)}@127.0.0.1:5432/${db}`;
}

function resolveAppConn() {
  const raw = process.env.TEST_APP_DATABASE_URL || parseEnvFile(path.join(repoRoot, "packages", "web", ".env.local")).DATABASE_URL;
  if (!raw) throw new Error("cannot resolve app-role DB creds — set TEST_APP_DATABASE_URL or DATABASE_URL in packages/web/.env.local");
  const u = new URL(raw);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname, port: u.port || "5432" };
}

const q = (id) => `"${String(id).replace(/"/g, '""')}"`; // quote an identifier safely

async function main() {
  const adminUrl = resolveAdminUrl();
  const app = resolveAppConn();
  const ephName = `innobox_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ephAppUrl = `postgres://${encodeURIComponent(app.user)}:${encodeURIComponent(app.password)}@${app.host}:${app.port}/${ephName}`;

  // Retry the first connection so the harness tolerates a Postgres service/container that is
  // still starting up in CI (no need for a separate pg_isready wait). A pg.Client cannot be
  // reconnected after a failed connect(), so build a fresh one each attempt.
  let admin;
  for (let attempt = 1; ; attempt++) {
    admin = new pg.Client({ connectionString: adminUrl });
    try {
      await admin.connect();
      break;
    } catch (err) {
      await admin.end().catch(() => {});
      if (attempt >= 15) throw err;
      if (attempt === 1) console.log("[test:db] waiting for the database to accept connections…");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  let createdDb = false;
  try {
    console.log(`[test:db] creating ephemeral database ${ephName}`);
    await admin.query(`CREATE DATABASE ${q(ephName)}`);
    createdDb = true;

    // Apply every migration in filename order, as the admin, to the fresh DB. Each file is sent
    // as a single simple-protocol query so dollar-quoted blocks ($$ … $$) execute intact.
    // Migration 0001 creates the (global) innobox_app role, so anything touching that role must
    // come AFTER this loop — important on a fresh CI server where the role doesn't exist yet.
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    const ephAdmin = new pg.Client({ connectionString: adminUrl.replace(/\/[^/]*$/, `/${ephName}`) });
    await ephAdmin.connect();
    try {
      for (const f of files) {
        process.stdout.write(`[test:db] migrate ${f} … `);
        await ephAdmin.query(readFileSync(path.join(migrationsDir, f), "utf8"));
        console.log("ok");
      }
    } finally {
      await ephAdmin.end();
    }

    if (process.env.TEST_SET_APP_PASSWORD) {
      // CI only — the app role has no password on a throwaway server. Never used locally.
      await admin.query(`ALTER ROLE ${q(app.user)} WITH LOGIN PASSWORD '${app.password.replace(/'/g, "''")}'`);
    }
    await admin.query(`GRANT CONNECT ON DATABASE ${q(ephName)} TO ${q(app.user)}`);

    // Run the suites against the ephemeral DB, as innobox_app. Sequential; any failure fails.
    // The commands are static (no interpolated input), so a shell string is safe here and
    // avoids the shell+args-array deprecation warning.
    // TEST_OWNER_DATABASE_URL: the owner connection to THIS throwaway database only — used by the
    // audit-chain tamper tests, which disable a guard trigger inside a rolled-back transaction to
    // prove "Verify integrity" catches the tampering. Never set for any other database.
    const childEnv = {
      ...process.env,
      DATABASE_URL: ephAppUrl,
      TEST_OWNER_DATABASE_URL: adminUrl.replace(/\/[^/]*$/, `/${ephName}`),
      INNOBOX_DB_E2E: "1",
    };
    const suites = [
      ["@innobox/web", "pnpm --filter @innobox/web run test:db:run"],
      ["@innobox/worker", "pnpm --filter @innobox/worker run test:db"],
    ];
    let worst = 0;
    for (const [label, cmd] of suites) {
      console.log(`\n[test:db] running ${label} dbtests against ${ephName}\n`);
      const r = spawnSync(cmd, { cwd: repoRoot, env: childEnv, stdio: "inherit", shell: true });
      worst = worst || (r.status ?? 1);
    }
    process.exitCode = worst;
  } finally {
    if (createdDb) {
      try {
        await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [ephName]);
        await admin.query(`DROP DATABASE IF EXISTS ${q(ephName)}`);
        console.log(`[test:db] dropped ephemeral database ${ephName}`);
      } catch (err) {
        console.error(`[test:db] WARNING: could not drop ${ephName}: ${String(err)}`);
      }
    }
    await admin.end();
  }
}

main().catch((err) => {
  console.error("[test:db] harness failed:", err);
  process.exit(1);
});
