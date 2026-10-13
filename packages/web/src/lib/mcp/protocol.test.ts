// Pins the MCP JSON-RPC layer (INNOBOX_SPEC.md §25.2) and the tool catalogue (§25.6): stateless
// request/response, notifications accepted with no body, tools only, the 15 tools with their
// prefix and read-only hints, no escape hatch (no like, transition, assignment, reveal, delete,
// admin or AI tool), rate-limit refusals surfaced as HTTP 429, and tool errors in MCP shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVER_INSTRUCTIONS, SUPPORTED_PROTOCOL_VERSIONS, handleRpc, toolResultContent, type CallOutcome, type RpcDeps } from "./protocol";
import { TOOLS, TOOL_PREFIX, findTool, toolListing } from "./tools";

const deps = (callTool: RpcDeps["callTool"] = async () => ({ kind: "result", result: { ok: true, data: { x: 1 } } })): RpcDeps => ({
  listTools: toolListing,
  callTool,
});
const rpc = (method: string, params: unknown = {}, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

test("initialize: echoes a supported protocol version, else offers the newest; tools only", async () => {
  const reply = await handleRpc(rpc("initialize", { protocolVersion: "2025-03-26" }), deps());
  assert.equal(reply.status, 200);
  const result = (reply as { body: { result: Record<string, unknown> } }).body.result;
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  assert.equal(result.instructions, SERVER_INSTRUCTIONS);
  const newest = (await handleRpc(rpc("initialize", { protocolVersion: "1999-01-01" }), deps())) as { body: { result: { protocolVersion: string } } };
  assert.equal(newest.body.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test("the server instructions say who the agent acts as, to check for duplicates, and 'via agent'", () => {
  assert.match(SERVER_INSTRUCTIONS, /act as the signed-in person/);
  assert.match(SERVER_INSTRUCTIONS, /innobox_find_similar_challenges/);
  assert.match(SERVER_INSTRUCTIONS, /via agent/);
  assert.match(SERVER_INSTRUCTIONS, /browser/);
});

test("notifications and client responses are accepted with no body; batches and junk are refused", async () => {
  assert.deepEqual(await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, deps()), { status: 202 });
  assert.deepEqual(await handleRpc({ jsonrpc: "2.0", id: 4, result: {} }, deps()), { status: 202 });
  assert.equal((await handleRpc([rpc("ping")], deps())).status, 400);
  assert.equal((await handleRpc("nope", deps())).status, 400);
  assert.equal((await handleRpc({ id: 1, method: "ping" }, deps())).status, 400, "jsonrpc 2.0 is required");
  const unknown = (await handleRpc(rpc("resources/list"), deps())) as { body: { error: { code: number } } };
  assert.equal(unknown.body.error.code, -32601, "no resources, no prompts");
  const ping = (await handleRpc(rpc("ping", {}, "a"), deps())) as { body: { id: string; result: unknown } };
  assert.deepEqual(ping.body, { jsonrpc: "2.0", id: "a", result: {} });
});

test("tools/call: result, tool error, unknown tool, and a rate-limit refusal as HTTP 429", async () => {
  const outcomes: CallOutcome[] = [
    { kind: "result", result: { ok: true, data: { number: "CH-1" } } },
    { kind: "result", result: { ok: false, status: 409, message: "solutions can only be proposed while the challenge is valid" } },
    { kind: "unknown_tool" },
    { kind: "rate_limited", retryAfterSeconds: 7 },
  ];
  let i = 0;
  const d = deps(async () => outcomes[i++]!);
  const ok = (await handleRpc(rpc("tools/call", { name: "innobox_get_challenge", arguments: { number: 1 } }), d)) as { body: { result: Record<string, unknown> } };
  assert.deepEqual(ok.body.result.structuredContent, { number: "CH-1" });
  assert.equal(ok.body.result.isError, false);
  const err = (await handleRpc(rpc("tools/call", { name: "innobox_propose_solution" }), d)) as { body: { result: { isError: boolean; content: { text: string }[] } } };
  assert.equal(err.body.result.isError, true);
  assert.equal(err.body.result.content[0]!.text, "solutions can only be proposed while the challenge is valid");
  const unknown = (await handleRpc(rpc("tools/call", { name: "innobox_like" }), d)) as { body: { error: { code: number } } };
  assert.equal(unknown.body.error.code, -32602);
  const limited = await handleRpc(rpc("tools/call", { name: "innobox_search_challenges" }), d);
  assert.equal(limited.status, 429);
  assert.equal(limited.status === 429 && limited.retryAfterSeconds, 7);
});

test("tool errors never carry a spec reference", () => {
  const content = toolResultContent({ ok: false, status: 403, message: "you are not a member of that namespace" });
  assert.ok(!JSON.stringify(content).includes("§"));
});

test("the catalogue: exactly 15 tools, 8 read + 7 contribute, prefixed, with read-only hints", () => {
  assert.equal(TOOLS.length, 15, "15 is the ceiling — a sixteenth tool is a spec change");
  const read = TOOLS.filter((t) => t.readOnly).map((t) => t.name).sort();
  const write = TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort();
  assert.deepEqual(read, [
    "find_similar_challenges",
    "get_challenge",
    "get_reference_data",
    "get_solution",
    "list_comments",
    "list_my_items",
    "list_my_notifications",
    "search_challenges",
  ]);
  assert.deepEqual(write, ["edit_challenge", "edit_solution", "post_comment", "propose_solution", "resubmit", "set_follow", "submit_challenge"]);
  for (const t of toolListing()) {
    assert.ok(String(t.name).startsWith(TOOL_PREFIX));
    const annotations = t.annotations as { readOnlyHint: boolean };
    assert.equal(annotations.readOnlyHint, TOOLS.find((d) => `${TOOL_PREFIX}${d.name}` === t.name)!.readOnly);
    assert.ok(!JSON.stringify(t).includes("§"), `${String(t.name)} description carries no spec reference`);
  }
  // §25.11: reads take the search bucket; writes their API route's bucket, never search.
  for (const t of TOOLS) assert.equal(t.bucket === "search", t.readOnly, t.name);
});

test("no escape hatch: likes, transitions, assignment, triage, reveal, delete, admin and AI do not exist", () => {
  const forbidden = /like|status|assign|triage|reveal|withdraw|delete|trash|restore|visibility|feature|admin|export|attachment|upload|ai_|summary|draft|profile|leader|badge|point/;
  for (const t of TOOLS) assert.ok(!forbidden.test(t.name), t.name);
  assert.equal(findTool("innobox_like_challenge"), null);
  assert.equal(findTool("get_challenge"), null, "the prefix is required on the wire");
  assert.equal(findTool("innobox_get_challenge")?.name, "get_challenge");
});
