// POST /api/admin/audit/verify (INNOBOX_SPEC.md §15 "Verify integrity", §16): platform admin only.
// Streams `application/x-ndjson`: a `{ type: "start", head }` line, a `{ type: "progress",
// checked }` line every 10 000 rows, then one `{ type: "result", … }` line. One run per web
// process (409 otherwise); counts against the ordinary state-changing rate limit; every run —
// including one the client abandons mid-stream — is audited as `audit.verified`.
import { requirePlatformAdmin } from "@/lib/auth";
import { pool } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { withSystemLog } from "@/lib/system-log";
import { endVerification, runAuditVerification, tryBeginVerification } from "./verify";

export const dynamic = "force-dynamic";

async function handlePOST(req: Request): Promise<Response> {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const limited = rateLimit(gate.user.id, "mutation");
  if (limited) return limited;
  if (!tryBeginVerification()) return Response.json({ error: "A verification is already running." }, { status: 409 });

  try {
    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    req.signal?.addEventListener("abort", onClientGone);
    const encoder = new TextEncoder();
    const actorId = gate.user.id;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (line: Record<string, unknown>): void => {
          if (abort.signal.aborted) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            abort.abort(); // the consumer is gone
          }
        };
        void runAuditVerification(pool, actorId, {
          signal: abort.signal,
          onStart: (head) => send({ type: "start", head }),
          onProgress: (checked) => send({ type: "progress", checked }),
        })
          .then((outcome) => {
            if (outcome.result === "aborted") return;
            send({ type: "result", result: outcome.result, checked: outcome.checked, head: outcome.head, firstBreak: outcome.firstBreak });
          })
          .catch((err: unknown) => {
            console.error(JSON.stringify({ level: "error", msg: "audit verification failed", error: err instanceof Error ? err.message : String(err) }));
            send({ type: "error", error: "The verification could not complete. Try again." });
          })
          .finally(() => {
            endVerification();
            req.signal?.removeEventListener("abort", onClientGone);
            try {
              controller.close();
            } catch {
              /* already closed or cancelled */
            }
          });
      },
      cancel() {
        abort.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    endVerification();
    throw err;
  }
}

// §14.7: every handler is wrapped so refused requests and failures are recorded in the system log.
export const POST = withSystemLog("/api/admin/audit/verify", handlePOST);
