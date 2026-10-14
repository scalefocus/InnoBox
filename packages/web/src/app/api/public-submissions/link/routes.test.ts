// INNOBOX_SPEC.md §6.1, §24.9: the share link for the new-challenge page — 401 without a session;
// `{ url: null }` while the switch is off and while it is on with a precondition missing; the full
// URL once live; always 200, and nothing but `url`. The live decision runs through the real
// getPublicIntakeState over a stub settings table, so "precondition missing" is the §24.2 rule,
// not a re-implementation of it. Plus the route-level contract: gated, logged, not audited, silent
// for presence, and behind a session at the edge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { getPublicIntakeState, PUBLIC_PRIVACY_NOTICE_KEY, PUBLIC_SUBMISSIONS_ENABLED_KEY } from "../../../../lib/public-intake";
import { isPublicPath } from "../../../../lib/routeAccess";
import { presenceTouchFor } from "../../../../lib/presence";
import { handleShareLink, publicShareUrl, type ShareLinkDeps } from "./handler";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://innobox.example.com";
const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

const signedIn: ShareLinkDeps["gate"] = async () => ({ ok: true });

/** A pg stand-in answering the one settings query getPublicIntakeSettings makes. */
function settingsDb(enabled: boolean, notice: string): Pool {
  const rows = [
    { key: PUBLIC_SUBMISSIONS_ENABLED_KEY, value: enabled },
    { key: PUBLIC_PRIVACY_NOTICE_KEY, value: notice },
  ];
  return { query: async () => ({ rows }) } as unknown as Pool;
}

async function withIntakeKey<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PUBLIC_INTAKE_KEY;
  if (key === undefined) delete process.env.PUBLIC_INTAKE_KEY;
  else process.env.PUBLIC_INTAKE_KEY = key;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.PUBLIC_INTAKE_KEY;
    else process.env.PUBLIC_INTAKE_KEY = before;
  }
}

/** The handler over the real live decision for the given settings, key and transport. */
async function linkFor(opts: { enabled: boolean; notice: string; key: string | undefined; transport: boolean }): Promise<{ status: number; body: unknown }> {
  const res = await withIntakeKey(opts.key, () =>
    handleShareLink({
      gate: signedIn,
      live: async () => (await getPublicIntakeState(settingsDb(opts.enabled, opts.notice), async () => opts.transport)).live,
      baseUrl: BASE,
    }),
  );
  return { status: res.status, body: await res.json() };
}

test("401 without a session, before the state is read", async () => {
  let read = false;
  const res = await handleShareLink({
    gate: async () => ({ ok: false, response: Response.json({ error: "unauthenticated" }, { status: 401 }) }),
    live: async () => {
      read = true;
      return true;
    },
    baseUrl: BASE,
  });
  assert.equal(res.status, 401);
  assert.equal(read, false, "the gate comes first");
});

test("switch off → 200 with url null", async () => {
  assert.deepEqual(await linkFor({ enabled: false, notice: "We keep it.", key: VALID_KEY, transport: true }), { status: 200, body: { url: null } });
});

test("switch on with a precondition missing → 200 with url null (never 404, no detail)", async () => {
  for (const missing of [
    { enabled: true, notice: "We keep it.", key: undefined, transport: true }, // no PUBLIC_INTAKE_KEY
    { enabled: true, notice: "   ", key: VALID_KEY, transport: true }, // empty notice
    { enabled: true, notice: "We keep it.", key: VALID_KEY, transport: false }, // no e-mail transport
  ]) {
    assert.deepEqual(await linkFor(missing), { status: 200, body: { url: null } }, JSON.stringify(missing));
  }
});

test("live → the full public form URL, and nothing else", async () => {
  assert.deepEqual(await linkFor({ enabled: true, notice: "We keep it.", key: VALID_KEY, transport: true }), {
    status: 200,
    body: { url: `${BASE}/submit` },
  });
});

test("no base URL configured → null even while live", () => {
  assert.equal(publicShareUrl(true, ""), null);
  assert.equal(publicShareUrl(false, BASE), null);
  assert.equal(publicShareUrl(true, BASE), `${BASE}/submit`);
});

test("the route is gated, logged, not audited, silent for presence and behind a session", () => {
  const route = readFileSync(path.join(here, "route.ts"), "utf8");
  assert.ok(route.includes(`export const GET = withSystemLog("/api/public-submissions/link", handleGET);`));
  assert.match(route, /gate: requireUser/);
  assert.match(route, /loadPublicIntakeState\(\)\)\.live/);
  assert.doesNotMatch(route, /appendAudit/);
  assert.equal(presenceTouchFor("/api/public-submissions/link", "GET"), null);
  assert.equal(isPublicPath("/api/public-submissions/link"), false, "not an unauthenticated route");
});
