// @innobox/worker — background service (INNOBOX_SPEC.md §2): hosts the SCIM 2.0
// endpoints, runs Entra reconciliation, the ClamAV scan pipeline, and the notification
// dispatch outbox. Singleton, leader-locked via a Postgres advisory lock.
//
// Phase 1: acquired the Postgres advisory leader lock; mounts SCIM 2.0 (/scim/v2); runs
// Entra group-membership reconciliation.
// Phase 3 (this code): notification outbox sweep (Graph e-mail + SMTP fallback; in-app
// delivery already happened at write time).
// Phase 2 (not yet built): ClamAV scan pipeline for uploaded attachments.
import express from "express";
import { Pool } from "pg";
import { APP_VERSION } from "@innobox/shared/version";
import { parseEmailTokenKey, renderMetrics, metricsAuthorized, type GraphMailEnv } from "@innobox/shared";
import { createScimRouter } from "./scim/router.js";
import { startLeaderElection } from "./leader.js";
import { runReconciliation } from "./recon/reconcile.js";
import { runNotificationSweep, type SmtpEnv } from "./notifications/dispatch.js";
import { createClamavScanner, createWorkerS3Client, runScanSweep, type ScanDeps, type WorkerS3Client } from "./attachments/scan.js";
import { runDraftGcSweep } from "./attachments/draft-gc.js";
import { runUploadGcSweep } from "./attachments/upload-gc.js";
import { runPresenceRollupSweep } from "./presence/rollup.js";
import { recordNotificationSweep, recordScanSweep, setLeader, workerMetricsSamples } from "./metrics.js";

const port = Number(process.env.WORKER_PORT ?? 4000);
const app = express();

// DB pool (phase 1): used by SCIM endpoints, leader election, and reconciliation.
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL required");
const pool = new Pool({ connectionString: dbUrl });

// Liveness — the process is up.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", version: APP_VERSION });
});

// Readiness — safe to receive traffic.
// Phase 1: checks DB connectivity and whether this instance holds the leader lock.
let isLeader = false;
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("select 1");
    const ready = isLeader;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_leader",
      leader: isLeader,
    });
  } catch {
    res.status(503).json({ status: "db_error" });
  }
});

// Prometheus metrics (§2 observability). Bearer-token-guarded when METRICS_TOKEN is set.
app.get("/metrics", (req, res) => {
  if (!metricsAuthorized(req.header("authorization"), process.env.METRICS_TOKEN)) {
    res.status(401).type("text/plain").send("unauthorized\n");
    return;
  }
  res.status(200).type("text/plain; version=0.0.4").send(renderMetrics(workerMetricsSamples()));
});

// Mount SCIM 2.0 server (phase 1) at /scim/v2 per ENTRA_AUTH_SPEC.md §3.
const scimToken = process.env.SCIM_BEARER_TOKEN;
if (!scimToken) throw new Error("SCIM_BEARER_TOKEN required");
app.use("/scim/v2", createScimRouter(pool, { bearerToken: scimToken }));

// Start the server before leader election (health checks must work immediately).
const server = app.listen(port, () => {
  console.log(JSON.stringify({ level: "info", msg: "innobox worker listening", port, version: APP_VERSION }));
});

/** Uses the dedicated email app registration (ENTRA_EMAIL_CLIENT_ID/SECRET) so that
 *  Mail.Send is kept entirely off the OIDC app (INNOBOX_SPEC.md §12.1). */
function buildGraphMailEnv(): GraphMailEnv | null {
  const key = parseEmailTokenKey(process.env.EMAIL_TOKEN_ENC_KEY);
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_EMAIL_CLIENT_ID;
  const clientSecret = process.env.ENTRA_EMAIL_CLIENT_SECRET;
  if (!key || !tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret, key };
}

/** The optional plain-text fallback transport (§12.1). No deployment-specific default lives in
 *  the repository (§2.3), so the sender address must be configured: SMTP_USER stands in when
 *  SMTP_FROM is unset, and without either the transport counts as not configured — Graph e-mail
 *  and the in-app inbox are unaffected. */
function buildSmtpEnv(): SmtpEnv | null {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;
  if (!from) {
    console.log(
      JSON.stringify({
        level: "warn",
        msg: "SMTP_HOST is set but neither SMTP_FROM nor SMTP_USER is — SMTP fallback disabled",
      }),
    );
    return null;
  }
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "1",
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from,
  };
}

// §11 scan sweep dependencies: the MinIO/S3 client + the clamd scanner. Returns null when the
// object-store env is absent (dev without MinIO) — the sweep is then skipped. Accepts the
// compose-wired S3_ACCESS_KEY/S3_SECRET_KEY as well as the spec-named *_ID/*_ACCESS_KEY and the
// MinIO root creds, so the same code runs in compose and against real S3.
function buildScanDeps(): (ScanDeps & { s3: WorkerS3Client }) | null {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET ?? "innobox-attachments";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? process.env.S3_ACCESS_KEY ?? process.env.MINIO_ROOT_USER;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.S3_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  const s3 = createWorkerS3Client({ endpoint, region: process.env.S3_REGION, accessKeyId, secretAccessKey, bucket });
  const scan = createClamavScanner({
    host: process.env.CLAMAV_HOST ?? "clamav",
    port: Number(process.env.CLAMAV_PORT ?? 3310),
  });
  return { s3, scan };
}

// Leader election + reconciliation + notification dispatch loops (phase 1/3).
const WORKER_LEADER_LOCK_KEY = 0x696e6e6f626f78n; // "innobox" in hex, from leader.ts.
let reconciliationInterval: NodeJS.Timeout | null = null;
let notificationInterval: NodeJS.Timeout | null = null;
let scanInterval: NodeJS.Timeout | null = null;
let draftGcInterval: NodeJS.Timeout | null = null;
let presenceRollupInterval: NodeJS.Timeout | null = null;

const leaderElection = startLeaderElection(dbUrl, {
  lockKey: WORKER_LEADER_LOCK_KEY,
  onAcquired: async () => {
    isLeader = true;
    setLeader(true);
    console.log(JSON.stringify({ level: "info", msg: "acquired leader lock" }));

    // §14.5 presence rollup + retention purge (hourly). Deliberately scheduled BEFORE the
    // Entra-credential check below — it is pure DB work with no Graph or object-store
    // dependency, and it is what keeps per-person presence detail from accumulating past its
    // 3-day floor. Skipping it because a mail or storage integration is unconfigured would
    // silently turn presence into an unbounded attendance record.
    const runPresenceRollup = async () => {
      try {
        const summary = await runPresenceRollupSweep(pool);
        if (summary.rolled || summary.purged) {
          console.log(JSON.stringify({ level: "info", msg: "presence rollup sweep", ...summary }));
        }
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "presence rollup sweep failed", error: String(err) }));
      }
    };
    void runPresenceRollup();
    presenceRollupInterval = setInterval(runPresenceRollup, 60 * 60 * 1000); // hourly

    // Run reconciliation immediately on leadership acquisition (only if Entra creds present).
    const tenantId = process.env.ENTRA_TENANT_ID;
    const clientId = process.env.ENTRA_CLIENT_ID;
    const clientSecret = process.env.ENTRA_CLIENT_SECRET;
    if (!tenantId || !clientId || !clientSecret) {
      console.log(
        JSON.stringify({
          level: "info",
          msg: "reconciliation skipped (missing Entra credentials)",
        })
      );
      return;
    }

    const graphEnv = { tenantId, clientId, clientSecret };
    try {
      const summary = await runReconciliation(pool, graphEnv, {
        bootstrapAdminGroup: process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP,
      });
      console.log(
        JSON.stringify({
          level: "info",
          msg: "initial reconciliation",
          usersChecked: summary.usersChecked,
          deactivated: summary.deactivated,
          refreshed: summary.refreshed,
          groupsSynced: summary.groupsSynced,
          membershipAdds: summary.membershipAdds,
          membershipRemoves: summary.membershipRemoves,
          errors: summary.errors,
        })
      );
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "initial reconciliation failed", error: String(err) }));
    }

    // Schedule hourly reconciliation (phase 1: periodic only; no event-driven trigger yet).
    reconciliationInterval = setInterval(async () => {
      try {
        await runReconciliation(pool, graphEnv, { bootstrapAdminGroup: process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP });
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "reconciliation failed", error: String(err) }));
      }
    }, 60 * 60 * 1000); // 1 hour

    // Notification dispatch sweep (§12): frequent, since "delivery is immediate" — no
    // digest in v1. Transport availability (Graph/SMTP) is re-checked every sweep.
    const runSweep = async () => {
      try {
        const summary = await runNotificationSweep(pool, {
          graphEnv: buildGraphMailEnv(),
          smtpEnv: buildSmtpEnv(),
          baseUrl: process.env.PUBLIC_BASE_URL ?? "",
        });
        recordNotificationSweep(summary);
        if (summary.sent || summary.failed) {
          console.log(JSON.stringify({ level: "info", msg: "notification sweep", ...summary }));
        }
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "notification sweep failed", error: String(err) }));
      }
    };
    void runSweep();
    notificationInterval = setInterval(runSweep, 30_000);

    // §11 ClamAV scan sweep: frequent (~15s), leader-gated like the notification sweep. Only
    // runs when the object-store env is present; otherwise it is skipped with a log line.
    const scanDeps = buildScanDeps();
    if (!scanDeps) {
      console.log(JSON.stringify({ level: "info", msg: "attachment scan sweep skipped (missing S3/ClamAV env)" }));
    } else {
      const runScan = async () => {
        try {
          const summary = await runScanSweep(pool, scanDeps);
          recordScanSweep(summary);
          if (summary.scanned || summary.errors) {
            console.log(JSON.stringify({ level: "info", msg: "attachment scan sweep", ...summary }));
          }
        } catch (err) {
          console.error(JSON.stringify({ level: "error", msg: "attachment scan sweep failed", error: String(err) }));
        }
      };
      void runScan();
      scanInterval = setInterval(runScan, 15_000);

      // §11 housekeeping (hourly — both TTLs are in hours): draft-attachment GC purges staged
      // uploads abandoned on a submission form after 24h; upload-session GC aborts chunked-upload
      // sessions abandoned after 2h (backstop to the on-initiate cleanup). Both reuse the scan
      // sweep's S3 client.
      const runHousekeeping = async () => {
        try {
          const summary = await runDraftGcSweep(pool, { s3: scanDeps.s3 });
          if (summary.expired || summary.errors) {
            console.log(JSON.stringify({ level: "info", msg: "draft attachment gc sweep", ...summary }));
          }
        } catch (err) {
          console.error(JSON.stringify({ level: "error", msg: "draft attachment gc sweep failed", error: String(err) }));
        }
        try {
          const summary = await runUploadGcSweep(pool, { s3: scanDeps.s3 });
          if (summary.aborted || summary.errors) {
            console.log(JSON.stringify({ level: "info", msg: "upload session gc sweep", ...summary }));
          }
        } catch (err) {
          console.error(JSON.stringify({ level: "error", msg: "upload session gc sweep failed", error: String(err) }));
        }
      };
      void runHousekeeping();
      draftGcInterval = setInterval(runHousekeeping, 60 * 60 * 1000); // hourly
    }
  },
  onLost: () => {
    isLeader = false;
    setLeader(false);
    if (reconciliationInterval) {
      clearInterval(reconciliationInterval);
      reconciliationInterval = null;
    }
    if (notificationInterval) {
      clearInterval(notificationInterval);
      notificationInterval = null;
    }
    if (scanInterval) {
      clearInterval(scanInterval);
      scanInterval = null;
    }
    if (draftGcInterval) {
      clearInterval(draftGcInterval);
      draftGcInterval = null;
    }
    if (presenceRollupInterval) {
      clearInterval(presenceRollupInterval);
      presenceRollupInterval = null;
    }
    console.log(JSON.stringify({ level: "info", msg: "lost leader lock" }));
  },
});

// Clean shutdown so `docker compose stop` / k8s termination is graceful.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (reconciliationInterval) clearInterval(reconciliationInterval);
    if (notificationInterval) clearInterval(notificationInterval);
    if (scanInterval) clearInterval(scanInterval);
    if (draftGcInterval) clearInterval(draftGcInterval);
    if (presenceRollupInterval) clearInterval(presenceRollupInterval);
    await leaderElection.stop();
    await pool.end();
    server.close(() => process.exit(0));
  });
}
