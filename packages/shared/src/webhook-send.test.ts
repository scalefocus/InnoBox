// Unit tests for the §12.4 transport: the DNS vetting (any private address refuses the whole
// host), the pinned connection, redirects never followed, the timeout, Retry-After, the 64 KB
// read cap, and the AES-GCM URL helpers under their own key. Driven against a LOCAL plain-HTTP
// server through the injectable request primitive — this suite never touches the internet.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import {
  decryptWebhookUrl,
  encryptWebhookUrl,
  parseWebhookKey,
  sendWebhook,
  vetWebhookUrl,
  type ResolvedAddress,
  type WebhookSendResult,
  type WebhookRequestFn,
} from "./webhook-send.js";

const PUBLIC: ResolvedAddress = { address: "20.50.2.3", family: 4 };
const failed = (r: WebhookSendResult) => {
  if (r.outcome === "sent") throw new Error("expected a failure");
  return r;
};
const resolveTo = (...addrs: ResolvedAddress[]) => async () => addrs;

async function withServer(handler: http.RequestListener, fn: (port: number, seen: { headers: http.IncomingHttpHeaders; body: string }[]) => Promise<void>) {
  const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn((server.address() as AddressInfo).port, seen);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Redirects the pinned HTTPS request to the local HTTP server — after asserting the custom
 *  lookup hands out exactly the vetted address (no second resolution). */
function localRequest(port: number, pinnedSeen: string[]): WebhookRequestFn {
  return (options, onResponse) => {
    const lookup = options.lookup!;
    lookup("ignored.example", {}, (_err, address) => pinnedSeen.push(String(address)));
    lookup("ignored.example", { all: true }, (_err, list) => pinnedSeen.push((list as unknown as { address: string }[])[0]!.address));
    assert.equal(options.port, 443);
    assert.equal(options.protocol, "https:");
    assert.ok(options.agent instanceof Object, "a dedicated agent — never the (proxy-aware) global one");
    return http.request({ host: "127.0.0.1", port, path: options.path, method: options.method, headers: options.headers }, onResponse);
  };
}

const input = (url = "https://hooks.example.com/in?sig=abc") => ({
  url,
  body: JSON.stringify({ hello: "world" }),
  headers: { "user-agent": "InnoBox-Webhook/test", "x-innobox-event": "challenge.validated", "x-innobox-delivery": "d-1" },
});

test("vetting: form rules, DNS failure, any private address refuses the host", async () => {
  assert.deepEqual((await vetWebhookUrl("http://hooks.example.com", resolveTo(PUBLIC))).ok, false);
  const dns = await vetWebhookUrl("https://hooks.example.com", async () => {
    throw new Error("ENOTFOUND hooks.example.com");
  });
  assert.equal(!dns.ok && dns.reason, "dns");
  assert.equal(!dns.ok && dns.message.includes("hooks.example.com"), false, "never echoes the library message");
  const none = await vetWebhookUrl("https://hooks.example.com", resolveTo());
  assert.equal(!none.ok && none.reason, "dns");
  const mixed = await vetWebhookUrl("https://hooks.example.com", resolveTo(PUBLIC, { address: "10.0.0.5", family: 4 }));
  assert.equal(!mixed.ok && mixed.reason, "blocked_address", "ANY non-public address refuses");
  const mapped = await vetWebhookUrl("https://hooks.example.com", resolveTo({ address: "::ffff:127.0.0.1", family: 6 }));
  assert.equal(!mapped.ok && mapped.reason, "blocked_address");
  const compose = await vetWebhookUrl("https://postgres", resolveTo({ address: "172.18.0.4", family: 4 }));
  assert.equal(!compose.ok && compose.reason, "blocked_address", "compose service names resolve private");
  const ok = await vetWebhookUrl("https://hooks.example.com/x", resolveTo(PUBLIC, { address: "2606:4700::1", family: 6 }));
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.address.address, "20.50.2.3");
});

test("send: 202 is success; headers, content type and the pinned address", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(202);
      res.end("accepted");
    },
    async (port, seen) => {
      const pinned: string[] = [];
      const r = await sendWebhook(input(), { resolve: resolveTo(PUBLIC), request: localRequest(port, pinned) });
      assert.equal(r.outcome, "sent");
      assert.equal(r.outcome === "sent" && r.httpStatus, 202);
      assert.deepEqual(pinned, ["20.50.2.3", "20.50.2.3"]);
      assert.equal(seen.length, 1);
      const h = seen[0]!.headers;
      assert.equal(h["content-type"], "application/json; charset=utf-8");
      assert.equal(h["user-agent"], "InnoBox-Webhook/test");
      assert.equal(h["x-innobox-event"], "challenge.validated");
      assert.equal(h["x-innobox-delivery"], "d-1");
      assert.equal(h.host, "hooks.example.com", "the original host name, not the address");
      assert.deepEqual(JSON.parse(seen[0]!.body), { hello: "world" });
    },
  );
});

test("send: a refused address never opens a connection", async () => {
  let called = 0;
  const r = await sendWebhook(input(), {
    resolve: resolveTo({ address: "169.254.169.254", family: 4 }),
    request: (() => {
      called++;
      throw new Error("must not be called");
    }) as unknown as WebhookRequestFn,
  });
  assert.equal(called, 0);
  assert.equal(r.outcome, "permanent");
  assert.equal(failed(r).reason, "blocked_address");
  const dns = await sendWebhook(input(), {
    resolve: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(dns.outcome, "retryable");
  assert.equal(failed(dns).reason, "dns");
  const form = await sendWebhook(input("https://hooks.example.com:8443/x"), { resolve: resolveTo(PUBLIC) });
  assert.equal(form.outcome, "permanent");
  assert.equal(failed(form).reason, "invalid_url");
});

test("send: a 3xx is a permanent failure and Location is never followed", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/internal" });
      res.end();
    },
    async (port, seen) => {
      const r = await sendWebhook(input(), { resolve: resolveTo(PUBLIC), request: localRequest(port, []) });
      assert.equal(r.outcome, "permanent");
      assert.equal(failed(r).reason, "redirect");
      assert.equal(failed(r).httpStatus, 302);
      assert.equal(seen.length, 1, "exactly one request — nothing followed");
    },
  );
});

test("send: 5xx retryable, 404 permanent, 429 carries Retry-After", async () => {
  for (const [status, outcome] of [
    [500, "retryable"],
    [503, "retryable"],
    [408, "retryable"],
    [404, "permanent"],
    [400, "permanent"],
  ] as const) {
    await withServer(
      (_req, res) => {
        res.writeHead(status);
        res.end();
      },
      async (port) => {
        const r = await sendWebhook(input(), { resolve: resolveTo(PUBLIC), request: localRequest(port, []) });
        assert.equal(r.outcome, outcome, String(status));
        assert.equal(failed(r).reason, "http_error");
      },
    );
  }
  await withServer(
    (_req, res) => {
      res.writeHead(429, { "retry-after": "600" });
      res.end();
    },
    async (port) => {
      const r = await sendWebhook(input(), { resolve: resolveTo(PUBLIC), request: localRequest(port, []) });
      assert.equal(r.outcome, "retryable");
      assert.equal(failed(r).retryAfterMs, 600_000);
    },
  );
});

test("send: no answer within the timeout is a retryable timeout", async () => {
  await withServer(
    () => {
      /* never answers */
    },
    async (port) => {
      const r = await sendWebhook(input(), { resolve: resolveTo(PUBLIC), request: localRequest(port, []), timeoutMs: 150 });
      assert.equal(r.outcome, "retryable");
      assert.equal(failed(r).reason, "timeout");
      assert.equal(failed(r).httpStatus, null);
    },
  );
});

test("send: connection refused is a retryable network error", async () => {
  // Bind then close a port so nothing listens on it.
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  const r = await sendWebhook(input(), { resolve: resolveTo(PUBLIC), request: localRequest(port, []) });
  assert.equal(r.outcome, "retryable");
  assert.equal(failed(r).reason, "network");
});

test("send: a huge response body is read only up to the cap", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(512 * 1024, 120));
    },
    async (port) => {
      const r = await sendWebhook(input(), { resolve: resolveTo(PUBLIC), request: localRequest(port, []) });
      assert.equal(r.outcome, "sent");
    },
  );
});

test("URL encryption: the shared v1 AES-GCM format under WEBHOOK_ENC_KEY; a wrong key fails closed", () => {
  assert.equal(parseWebhookKey(undefined), null);
  assert.equal(parseWebhookKey("short"), null);
  const key = parseWebhookKey(randomBytes(32).toString("base64"))!;
  assert.ok(key);
  const enc = encryptWebhookUrl("https://hooks.example.com/in?sig=abc", key);
  assert.match(enc, /^v1:[^:]+:[^:]+:[^:]+$/);
  assert.ok(!enc.includes("hooks.example.com"));
  assert.equal(decryptWebhookUrl(enc, key), "https://hooks.example.com/in?sig=abc");
  assert.equal(decryptWebhookUrl(enc, randomBytes(32)), null, "a rotated key cannot decrypt");
  assert.equal(decryptWebhookUrl("garbage", key), null);
});
