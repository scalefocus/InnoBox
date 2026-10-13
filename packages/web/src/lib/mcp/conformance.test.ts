// Conformance of the MCP server against a real MCP client (INNOBOX_SPEC.md §25.13): the official
// TypeScript SDK's Streamable HTTP client initializes, lists the tools and calls one, over plain
// HTTP against the very protocol layer /mcp uses — stateless JSON answers, 202 for notifications,
// 405 for the optional server-sent stream. The bearer check and the tools' data are covered by the
// dbtests; here a fake tool runner stands in for the database.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleRpc, SERVER_INSTRUCTIONS } from "./protocol";
import { TOOL_PREFIX, TOOLS, toolListing } from "./tools";

async function startServer(): Promise<{ url: string; requests: { method: string; status: number }[]; close: () => Promise<void> }> {
  const requests: { method: string; status: number }[] = [];
  const server = http.createServer((req, res) => {
    const done = (status: number, body?: unknown) => {
      requests.push({ method: req.method ?? "", status });
      res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method !== "POST") return done(405);
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const reply = await handleRpc(JSON.parse(raw), {
        listTools: toolListing,
        callTool: async (name, args) =>
          name === `${TOOL_PREFIX}get_challenge`
            ? { kind: "result", result: { ok: true, data: { number: "CH-12", title: "A challenge", echo: args } } }
            : name === `${TOOL_PREFIX}propose_solution`
              ? { kind: "result", result: { ok: false, status: 409, message: "solutions can only be proposed while the challenge is valid" } }
              : { kind: "unknown_tool" },
      });
      if (reply.status === 202) return done(202);
      done(reply.status, reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("a real MCP client: initialize, tools/list, tools/call over Streamable HTTP", async () => {
  const server = await startServer();
  const client = new Client({ name: "conformance", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    assert.equal(client.getServerVersion()?.name, "innobox");
    assert.equal(client.getInstructions(), SERVER_INSTRUCTIONS);
    assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });

    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOLS.length);
    const search = tools.find((t) => t.name === `${TOOL_PREFIX}search_challenges`)!;
    assert.equal(search.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === `${TOOL_PREFIX}submit_challenge`)!.annotations?.readOnlyHint, false);

    const ok = await client.callTool({ name: `${TOOL_PREFIX}get_challenge`, arguments: { number: "CH-12" } });
    assert.equal(ok.isError, false);
    assert.deepEqual(ok.structuredContent, { number: "CH-12", title: "A challenge", echo: { number: "CH-12" } });

    const refused = await client.callTool({ name: `${TOOL_PREFIX}propose_solution`, arguments: {} });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.content, [{ type: "text", text: "solutions can only be proposed while the challenge is valid" }]);

    await assert.rejects(client.callTool({ name: `${TOOL_PREFIX}like`, arguments: {} }), /Unknown tool/);
    await client.ping();

    // The notification after initialize was accepted with 202; the optional GET stream got 405.
    assert.ok(server.requests.some((r) => r.method === "POST" && r.status === 202));
    assert.ok(server.requests.every((r) => r.method === "POST" || r.status === 405));
  } finally {
    await client.close().catch(() => {});
    await server.close();
  }
});
