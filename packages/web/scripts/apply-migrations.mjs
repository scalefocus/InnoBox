// Apply every db/migrations/*.sql (in filename order) to DATABASE_URL via pg — no psql needed.
// Used by the e2e CI job to migrate the ephemeral CI database the dev server runs against. Each
// file is sent as a single simple-protocol query so dollar-quoted blocks ($$ … $$) run intact.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", ".."); // packages/web/scripts → repo root
const migrationsDir = path.join(repoRoot, "db", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[apply-migrations] DATABASE_URL is required");
  process.exit(1);
}

// Retry the connection so a still-starting CI Postgres needs no separate readiness wait.
// A pg.Client can't be reconnected after a failed connect(), so build a fresh one each attempt.
let client;
for (let attempt = 1; ; attempt++) {
  client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    break;
  } catch (err) {
    await client.end().catch(() => {});
    if (attempt >= 20) {
      console.error(`[apply-migrations] could not connect after ${attempt} attempts: ${String(err)}`);
      process.exit(1);
    }
    if (attempt === 1) console.log("[apply-migrations] waiting for the database…");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

try {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    process.stdout.write(`[apply-migrations] ${f} … `);
    await client.query(readFileSync(path.join(migrationsDir, f), "utf8"));
    console.log("ok");
  }
  console.log(`[apply-migrations] applied ${files.length} migration(s)`);
} finally {
  await client.end();
}
