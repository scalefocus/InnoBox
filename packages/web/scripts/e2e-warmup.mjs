// Pre-compile every page and API route of a running `next dev` server before the e2e suite starts.
// Used by the Jenkins e2e job. Dev mode compiles each route on its first request (seconds under
// Turbopack, 5–35 s under webpack on the CI agent) and every new compile can make Fast Refresh fully
// reload whatever page a test has open — the source of the suite's first-attempt flakes. Warming
// everything up front, on a server started with E2E_DEV_SERVER=1 (next.config.ts turns on Turbopack's
// "full" memory eviction), fills Turbopack's disk cache: the compiled output leaves memory, and a
// test's first request to a route restores it from disk instead of compiling it.
//
// Side-effect free by construction:
//   - pages get a plain GET (server components render; no client JS runs, so no API calls fire);
//   - API routes get OPTIONS, which Next answers itself once the module is compiled — no handler
//     code runs, and the CSRF check exempts it as a safe method;
//   - Next's /_error page gets a GET with an undecodable path segment, answered 400 by Next itself.
// It signs in a dedicated dev persona first (INNOBOX_DEV_AUTH), since the route gate would otherwise
// answer 401/redirect before anything compiles. Non-2xx answers are expected (a placeholder
// dynamic segment 404s) and only logged; only a failed sign-in or an unreachable server fails it.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "app");
const base = (process.env.E2E_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const origin = new URL(base).origin;
const CONCURRENCY = Number(process.env.E2E_WARMUP_CONCURRENCY || 4);
const REQUEST_TIMEOUT_MS = 180_000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Every page.* / route.* under src/app as { kind, url }. Route groups "(x)" vanish from the URL,
 *  private folders "_x" are not routable, dynamic segments get a placeholder that matches no row. */
function collectEntries(dir, segments = []) {
  const entries = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) {
      const name = dirent.name;
      if (name.startsWith("_") || name.startsWith("@")) continue;
      if (name.includes("...")) continue; // catch-alls: only Auth.js, which sign-in compiles anyway
      let seg = name;
      if (/^\(.*\)$/.test(name)) seg = null;
      else if (/^\[.*\]$/.test(name)) seg = /id$/i.test(name.slice(1, -1)) ? NIL_UUID : "0";
      entries.push(...collectEntries(path.join(dir, name), seg === null ? segments : [...segments, seg]));
    } else if (/^page\.(t|j)sx?$/.test(dirent.name)) {
      entries.push({ kind: "page", url: "/" + segments.join("/") });
    } else if (/^route\.(t|j)sx?$/.test(dirent.name)) {
      entries.push({ kind: "route", url: "/" + segments.join("/") });
    }
  }
  return entries;
}

const jar = new Map();
function storeCookies(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
}
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

async function request(url, init = {}) {
  const res = await fetch(base + url, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
    headers: { origin, cookie: cookieHeader(), ...(init.headers ?? {}) },
  });
  storeCookies(res);
  return res;
}

async function signIn() {
  const csrfRes = await request("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({
    csrfToken,
    name: "E2E Warmup",
    email: "e2e-warmup@dev.test",
    admin: "1", // admin pages render fully instead of short-circuiting
    freshOnboarding: "0",
    whatsNewSeen: "",
    whatsNewSinceDate: "",
    survey: "0",
    json: "true",
  });
  await request("/api/auth/callback/dev", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const me = await request("/api/me", { headers: { accept: "application/json" } });
  const body = me.ok ? await me.json() : null;
  if (!body?.user?.id) throw new Error(`dev sign-in did not establish a session (GET /api/me → ${me.status})`);
}

async function warm({ kind, url }) {
  const started = Date.now();
  const res = await request(url, kind === "page" ? { headers: { accept: "text/html" } } : { method: "OPTIONS" });
  await res.arrayBuffer(); // drain, so the connection is released
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[e2e-warmup] ${kind === "page" ? "GET    " : "OPTIONS"} ${url} → ${res.status} (${secs}s)`);
}

const t0 = Date.now();
try {
  await signIn();
} catch (err) {
  console.error(`[e2e-warmup] ${String(err)}`);
  process.exit(1);
}

// Pages first (they pull in the shared layout + client chunks), then the API routes.
const entries = collectEntries(appDir).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "page" ? -1 : 1));
const queue = [...entries];
let unreachable = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await warm(next);
      } catch (err) {
        unreachable++;
        console.error(`[e2e-warmup] ${next.url} failed: ${String(err)}`);
      }
    }
  }),
);

// Next's own error page, /_error, is not a file under src/app, so the walk above never reaches it.
// Next compiles it the first time it renders an error outside the app router — mid-run, that is
// the first request a closing test context aborts ("Error: aborted"), and the compile then stalls
// the server for seconds and can leave a page loading at that moment un-hydrated. A dynamic segment
// that can't be percent-decoded is answered 400 through /_error before any handler runs, so this
// compiles it without side effects. It relies on /challenges/[number] existing; anything but a 400
// means the probe no longer reaches /_error.
const ERROR_PAGE_PROBE = "/challenges/%E0%A4%A";
try {
  const started = Date.now();
  const res = await request(ERROR_PAGE_PROBE, { headers: { accept: "text/html" } });
  await res.arrayBuffer();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[e2e-warmup] GET     ${ERROR_PAGE_PROBE} → ${res.status} (${secs}s, compiles /_error)`);
  if (res.status !== 400) console.warn(`[e2e-warmup] expected 400 from ${ERROR_PAGE_PROBE}; /_error may still compile mid-run`);
} catch (err) {
  unreachable++;
  console.error(`[e2e-warmup] ${ERROR_PAGE_PROBE} failed: ${String(err)}`);
}

const total = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`[e2e-warmup] warmed ${entries.length + 1 - unreachable}/${entries.length + 1} entries in ${total}s`);
// A request that never got an answer means the server is down or wedged — the suite would only
// fail later and less clearly.
if (unreachable > 0) process.exit(1);
