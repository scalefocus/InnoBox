// POST /mcp — the MCP endpoint (INNOBOX_SPEC.md §25.2, §25.6, §25.11): Streamable HTTP, stateless,
// JSON-RPC answered with application/json. Bearer token ONLY: a session cookie is ignored, never
// honoured (the middleware leaves this path public and this handler never reads a session), so a
// browser cannot be made to call it with the person's session. Every call re-resolves the person's
// role from SCIM-synced groups (invariant 1), applies the §25.5 restricted filter, takes the
// §25.11 per-person and per-(person, client) rate limits, and records refused tool calls in the
// §14.7 system log with the tool name and the person. MCP calls are not presence (§14.5): nothing
// here stamps last_seen_at. GET (the optional server-sent stream) and DELETE answer 405.
import { publicBaseUrl } from "@innobox/shared/public-url";
import { resolveRolesForUser } from "@/lib/auth";
import { pool } from "@/lib/db";
import { readBytesLimited, JSON_BODY_MAX_BYTES } from "@/lib/http";
import { INTERNAL_ERROR_MESSAGE } from "@/lib/system-log";
import { takeMcpToken } from "@/lib/rate-limit";
import { NO_STORE, ipLimited, recordMcpEvent, settingsOr503 } from "@/lib/mcp/http";
import { bearerChallenge } from "@/lib/mcp/oauth";
import { countToolCall, type ToolOutcome } from "@/lib/mcp/metrics";
import { handleRpc, type CallOutcome } from "@/lib/mcp/protocol";
import { authenticateBearer } from "@/lib/mcp/store";
import { TOOL_PREFIX, findTool, runTool, toolListing, type ToolContext } from "@/lib/mcp/tools";

export const dynamic = "force-dynamic";

const ROUTE = "/mcp";

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401, headers: { ...NO_STORE, "WWW-Authenticate": bearerChallenge(publicBaseUrl()) } });
}

function outcomeOf(status: number): ToolOutcome {
  return status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid";
}

export async function POST(req: Request): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  const { settings } = gate;

  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const auth = match ? await authenticateBearer(pool, match[1]!) : ({ status: "invalid" } as const);
  if (auth.status !== "ok") {
    const limited = ipLimited(req, "mcp-ip"); // §25.11: unauthenticated calls, per IP
    if (limited) return limited;
    if (auth.status === "blocked") {
      // §25.11 carve-out: a blocked client tried again — named, with its person.
      recordMcpEvent({ status: 403, route: ROUTE, errorCode: "mcp_client_blocked", message: `blocked client "${auth.clientName}" called the MCP endpoint`, userId: auth.userId });
      return Response.json({ error: "This application has been blocked by an administrator." }, { status: 403, headers: NO_STORE });
    }
    return unauthorized(); // never says why (§25.3); ordinary 401s are not recorded
  }
  const { principal } = auth;

  const bytes = await readBytesLimited(req, JSON_BODY_MAX_BYTES);
  if (!bytes.ok) return bytes.response;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes.value));
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400, headers: NO_STORE });
  }

  const roles = await resolveRolesForUser(principal.userId);
  const ctx: ToolContext = {
    pool,
    viewer: { userId: principal.userId, roles, orgVisibleOnly: !settings.restrictedContentEnabled },
    principal,
    settings,
    baseUrl: publicBaseUrl(),
    resolveRoles: resolveRolesForUser,
  };

  const callTool = async (name: string, args: unknown): Promise<CallOutcome> => {
    const tool = findTool(name);
    if (!tool) {
      countToolCall("unknown", "invalid");
      return { kind: "unknown_tool" };
    }
    const wireName = `${TOOL_PREFIX}${tool.name}`;
    const limit = takeMcpToken(principal.userId, principal.clientRowId, tool.bucket);
    if (!limit.ok) {
      countToolCall(tool.name, "rate_limited");
      console.warn(JSON.stringify({ level: "warn", msg: "rate limit exceeded", userId: principal.userId, bucket: tool.bucket, tool: wireName }));
      recordMcpEvent({ status: 429, route: ROUTE, message: `${wireName}: too many requests`, userId: principal.userId });
      return { kind: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds };
    }
    try {
      const result = await runTool(tool, ctx, args);
      if (result.ok) {
        countToolCall(tool.name, "ok");
      } else {
        countToolCall(tool.name, outcomeOf(result.status));
        // §14.7: a 403, 409 or 422 from a tool is recorded like the API's — 400/404 are not.
        if (result.status === 403 || result.status === 409 || result.status === 422) {
          recordMcpEvent({ status: result.status, route: ROUTE, message: `${wireName}: ${result.message}`, userId: principal.userId });
        }
      }
      return { kind: "result", result };
    } catch (err) {
      countToolCall(tool.name, "error");
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(JSON.stringify({ level: "error", msg: "mcp tool failed", tool: wireName, error: error.message, stack: error.stack }));
      recordMcpEvent({ status: 500, route: ROUTE, message: `${wireName}: ${error.message}`, userId: principal.userId });
      return { kind: "result", result: { ok: false, status: 400, message: INTERNAL_ERROR_MESSAGE } };
    }
  };

  const reply = await handleRpc(payload, { listTools: toolListing, callTool });
  if (reply.status === 202) return new Response(null, { status: 202, headers: NO_STORE });
  if (reply.status === 429) {
    return Response.json(reply.body, { status: 429, headers: { ...NO_STORE, "Retry-After": String(reply.retryAfterSeconds) } });
  }
  return Response.json(reply.body, { status: reply.status, headers: NO_STORE });
}

async function methodNotAllowed(): Promise<Response> {
  const gate = await settingsOr503();
  if (!gate.ok) return gate.response;
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
