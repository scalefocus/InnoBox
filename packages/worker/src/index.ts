// @innobox/worker — background service (INNOBOX_SPEC.md §2): hosts the SCIM 2.0
// endpoints, runs Entra reconciliation, the ClamAV scan pipeline, and the notification
// dispatch outbox. Singleton, leader-locked via a Postgres advisory lock.
//
// Phase 1: acquired the Postgres advisory leader lock; mounts SCIM 2.0 (/scim/v2); runs
// Entra group-membership reconciliation.
// Phase 3 (this code): notification outbox sweep (Graph e-mail + SMTP fallback; in-app
// delivery already happened at write time).
// Phase 2: ClamAV scan pipeline for uploaded attachments.
import express from "express";
import { Pool } from "pg";
import { APP_VERSION } from "@innobox/shared/version";
import { parseEmailTokenKey, type GraphMailEnv } from "@innobox/shared";
import { createScimRouter } from "./scim/router.js";
import { createScimLastRequestStamper } from "./scim/last-request.js";
import { checkScimBearerToken, scimTokenFatalLog } from "./scim/token.js";
import { startLeaderElection } from "./leader.js";
import { runReconciliation } from "./recon/reconcile.js";
import { runNotificationSweep } from "./notifications/dispatch.js";
import { buildSmtpEnv } from "./notifications/smtp-env.js";
import { createClamavScanner, createWorkerS3Client, runScanSweep, type ScanDeps, type WorkerS3Client } from "./attachments/scan.js";
import { runDraftGcSweep } from "./attachments/draft-gc.js";
import { runUploadGcSweep } from "./attachments/upload-gc.js";
import { runPresenceRollupSweep } from "./presence/rollup.js";
import {
  createMetricsHandler,
  createReadyzHandler,
  healthzHandler,
  recordNotificationSweep,
  recordScanSweep,
  recordWebhookSweep,
  setLeader,
} from "./metrics.js";
import { createScimRateLimit, parseTrustProxy } from "./ratelimit.js";
import { createScimEventRecorder, trimSystemEvents } from "./system-log/record.js";
import { runSystemLogAlertSweep } from "./system-log/alert.js";
import { startWebhookSweeps } from "./webhooks/deliver.js";

// ENTRA_AUTH_SPEC.md §3 *Auth*: SCIM_BEARER_TOKEN guards a public endpoint that can create users
// and change group membership, so a missing or short (< 32 chars) value refuses to start. The
// fatal log names the variable, never its value.
const scimTokenCheck = checkScimBearerToken(process.env.SCIM_BEARER_TOKEN);
if (!scimTokenCheck.ok) {
  console.error(scimTokenFatalLog(scimTokenCheck.reason));
  process.exit(1);
}
const scimToken = scimTokenCheck.token;

const port = Number(process.env.WORKER_PORT ?? 4000);
const app = express();
app.disable("x-powered-by"); // §2.4: no X-Powered-By on the worker either
// Behind the proxy (deploy/Caddyfile) the client address arrives in X-Forwarded-For; TRUST_PROXY
// (deploy/.env.example) decides how much of it to believe, so the §2.4 SCIM rate limiter keys the
// real caller and never the proxy itself. Unset → not trusted (safe default off-compose).
app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));

// DB pool (phase 1): used by SCIM endpoints, leader election, and reconciliation.
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL required");
const pool = new Pool({ connectionString: dbUrl });

// Liveness — the process is up. Body is the status word only (§2).
app.get("/healthz", healthzHandler);

// Readiness — safe to receive traffic: DB connectivity and whether this instance holds the
// leader lock. Body is the status word + failing check's name; detail goes to the log (§2).
let isLeader = false;
app.get("/readyz", createReadyzHandler({ pingDb: () => pool.query("select 1"), isLeader: () => isLeader }));

// Prometheus metrics (§2 observability). Constant-time bearer gate when METRICS_TOKEN is set;
// unset → open in dev, disabled (404) in production.
app.get("/metrics", createMetricsHandler());

// Mount SCIM 2.0 server (phase 1) at /scim/v2 per ENTRA_AUTH_SPEC.md §3.
// §2.4 SCIM rate limiting — keyed per client IP; the operational endpoints above are
// deliberately outside the limiter so probe/scrape cadence can never be throttled.
// §14.7 system log — the SCIM 401/403 carve-out, observed on the finished response. Mounted
// ahead of the limiter so it sees the auth outcome; a limiter 429 is deliberately not recorded.
app.use("/scim/v2", createScimEventRecorder(pool));
app.use("/scim/v2", createScimRateLimit());
// §14.10: bearer-accepted SCIM requests stamp scim_last_request_at (throttled, fire-and-forget).
app.use("/scim/v2", createScimRouter(pool, { bearerToken: scimToken, onAccepted: createScimLastRequestStamper(pool) }));

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

/** The optional plain-text fallback transport (§12.1) — see notifications/smtp-env.ts. An empty
 *  SMTP_FROM (compose passes `${SMTP_FROM:-}`) falls back to SMTP_USER like an unset one. */
function currentSmtpEnv() {
  return buildSmtpEnv(process.env, (msg) => console.log(JSON.stringify({ level: "warn", msg })));
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
let housekeepingInterval: NodeJS.Timeout | null = null;
let systemLogAlertInterval: NodeJS.Timeout | null = null;
let stopWebhookSweeps: (() => void) | null = null;

const leaderElection = startLeaderElection(dbUrl, {
  lockKey: WORKER_LEADER_LOCK_KEY,
  onAcquired: async () => {
    isLeader = true;
    setLeader(true);
    console.log(JSON.stringify({ level: "info", msg: "acquired leader lock" }));

    // Every sweep below except reconciliation is scheduled BEFORE the Entra-credential check at
    // the end (§2): pure-DB work must never be skipped because a Graph or object-store
    // integration is unconfigured. Integration-dependent parts are gated individually.
    const scanDeps = buildScanDeps();

    // §2 hourly housekeeping sweep: §14.5 presence rollup + retention purge, §14.7 system-log
    // trim, §11 stale upload sessions (and abandoned draft attachments). Presence rollup is what
    // keeps per-person presence detail from accumulating past its 3-day floor — skipping it
    // because a mail or storage integration is unconfigured would silently turn presence into an
    // unbounded attendance record. (The §12.4 webhook-delivery trim runs on the same hourly
    // cadence inside startWebhookSweeps below.)
    const runHousekeeping = async () => {
      try {
        const summary = await runPresenceRollupSweep(pool);
        if (summary.rolled || summary.purged) {
          console.log(JSON.stringify({ level: "info", msg: "presence rollup sweep", ...summary }));
        }
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "presence rollup sweep failed", error: String(err) }));
      }
      // §14.7 retention: the system log keeps 90 days.
      try {
        const trimmed = await trimSystemEvents(pool);
        if (trimmed) console.log(JSON.stringify({ level: "info", msg: "system log trim", trimmed }));
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "system log trim failed", error: String(err) }));
      }
      // §11 upload-session GC: reaps chunked-upload sessions abandoned after 2h (backstop to the
      // on-initiate cleanup). The session rows are reaped regardless; the MinIO multipart abort
      // needs the object store and is skipped (logged) without it.
      try {
        const summary = await runUploadGcSweep(pool, { s3: scanDeps?.s3 ?? null });
        if (summary.aborted || summary.errors) {
          console.log(JSON.stringify({ level: "info", msg: "upload session gc sweep", ...summary }));
        }
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "upload session gc sweep failed", error: String(err) }));
      }
      // §11 draft-attachment GC: purges staged uploads abandoned on a submission form after 24h.
      // Purging is the object delete itself, so it needs the object store.
      if (scanDeps) {
        try {
          const summary = await runDraftGcSweep(pool, { s3: scanDeps.s3 });
          if (summary.expired || summary.errors) {
            console.log(JSON.stringify({ level: "info", msg: "draft attachment gc sweep", ...summary }));
          }
        } catch (err) {
          console.error(JSON.stringify({ level: "error", msg: "draft attachment gc sweep failed", error: String(err) }));
        }
      }
    };
    void runHousekeeping();
    housekeepingInterval = setInterval(runHousekeeping, 60 * 60 * 1000); // hourly

    // §14.7 alert sweep: a coalesced in-app `system_error` row per platform admin when new
    // system-log events appear, watermarked so nothing is double-counted. Pure DB work.
    const runSystemLogAlert = async () => {
      try {
        const summary = await runSystemLogAlertSweep(pool, { bootstrapAdminGroup: process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP });
        if (summary.newEvents) console.log(JSON.stringify({ level: "info", msg: "system log alert sweep", ...summary }));
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "system log alert sweep failed", error: String(err) }));
      }
    };
    void runSystemLogAlert();
    systemLogAlertInterval = setInterval(runSystemLogAlert, 5 * 60 * 1000); // every 5 minutes

    // §12.4 channel-webhook delivery sweep (30 s) + 30-day trim (hourly). Pure DB + outbound HTTPS.
    stopWebhookSweeps = startWebhookSweeps(pool, { onSweep: recordWebhookSweep });

    // Notification dispatch sweep (§12): frequent, since "delivery is immediate" — no digest in
    // v1. Transport availability (Graph via the separate e-mail app registration, or SMTP) is
    // re-checked every sweep, and neither depends on the OIDC/reconciliation credentials — SMTP
    // e-mail keeps working with no Entra configuration at all.
    const runSweep = async () => {
      try {
        const summary = await runNotificationSweep(pool, {
          graphEnv: buildGraphMailEnv(),
          smtpEnv: currentSmtpEnv(),
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

    // §11 ClamAV scan sweep: frequent (~15s). Needs the object store + clamd, not Entra.
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
    }

    // Entra reconciliation — the only sweep that needs the OIDC app's Graph credentials, so the
    // credential check lives here, after everything else has been scheduled.
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
    // Schedule hourly reconciliation (phase 1: periodic only; no event-driven trigger yet).
    reconciliationInterval = setInterval(async () => {
      try {
        await runReconciliation(pool, graphEnv, { bootstrapAdminGroup: process.env.INNOBOX_BOOTSTRAP_ADMIN_GROUP });
      } catch (err) {
        console.error(JSON.stringify({ level: "error", msg: "reconciliation failed", error: String(err) }));
      }
    }, 60 * 60 * 1000); // 1 hour

    // Run reconciliation immediately on leadership acquisition.
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
    if (housekeepingInterval) {
      clearInterval(housekeepingInterval);
      housekeepingInterval = null;
    }
    if (systemLogAlertInterval) {
      clearInterval(systemLogAlertInterval);
      systemLogAlertInterval = null;
    }
    stopWebhookSweeps?.();
    stopWebhookSweeps = null;
    console.log(JSON.stringify({ level: "info", msg: "lost leader lock" }));
  },
});

// Clean shutdown so `docker compose stop` / k8s termination is graceful.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (reconciliationInterval) clearInterval(reconciliationInterval);
    if (notificationInterval) clearInterval(notificationInterval);
    if (scanInterval) clearInterval(scanInterval);
    if (housekeepingInterval) clearInterval(housekeepingInterval);
    if (systemLogAlertInterval) clearInterval(systemLogAlertInterval);
    stopWebhookSweeps?.();
    await leaderElection.stop();
    await pool.end();
    server.close(() => process.exit(0));
  });
}
